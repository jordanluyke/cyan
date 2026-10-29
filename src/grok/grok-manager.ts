import { injectable } from 'tsyringe'
import {
    ChatInputCommandInteraction,
    Guild,
    Message,
    MessageContextMenuCommandInteraction,
    ModalSubmitInteraction,
    TextChannel,
} from 'discord.js'
import { Config } from '../config.js'
import { BotError } from '../audio/model/error/bot-error.js'
import { DateUtil } from '../util/date-util.js'
import { DiscordUtil, MAX_IMAGE_BYTES } from '../util/discord-util.js'
import { GrokUtil, MAX_EDIT_IMAGES } from '../util/grok-util.js'
import { readResponseBodyWithLimit, ResponseTooLargeError } from '../util/response-body-limit.js'
import { buildDrawModal, parseDrawModalCustomId } from './draw-modal.js'
import { CYAN_SYSTEM_PROMPT, GrokPrompt } from './model/grok-prompt.js'
import { replyChainImages } from './reply-chain-images.js'

@injectable()
export class GrokManager {
    constructor(private config: Config) {}

    public async askAboutMessage(
        interaction: MessageContextMenuCommandInteraction
    ): Promise<void> {
        this.requireApiKey()
        await interaction.deferReply()

        const prompt = await this.buildReplyChainPrompt(interaction.targetMessage, '')
        if (prompt == null) {
            throw new BotError(
                'referenced message has no content',
                "that message doesn't have any text or pics i can read"
            )
        }

        const response = await GrokUtil.chat(
            this.config.xaiApiKey!,
            prompt.text,
            prompt.imageUrls,
            CYAN_SYSTEM_PROMPT
        )
        await this.sendInteractionResponse(interaction, response.text, response.images)
    }

    public async askFromMention(message: Message): Promise<void> {
        this.requireApiKey()
        if (message.client.user == null) return
        if (!message.channel.isTextBased() || message.channel.isDMBased()) return

        const channel = message.channel as TextChannel
        const botId = message.client.user.id
        const userPrompt = this.stripBotMentions(message.content, botId)
        const imageUrls = DiscordUtil.getMessageImages(message)
        const asker = await DiscordUtil.getMemberDisplayName(message.guild, message)

        let prompt: GrokPrompt | null = null
        if (message.reference != null) {
            prompt = await this.buildReplyChainPrompt(message, userPrompt, {
                includeStartingMessage: false,
                extraImageUrls: imageUrls,
            })
        }
        if (prompt == null) {
            if (userPrompt.length === 0 && imageUrls.length === 0) {
                await DiscordUtil.tryReply(message, {
                    content: 'um… did you need something? try `@` me with a question~',
                })
                return
            }
            prompt = await this.buildDirectPrompt({
                channel,
                guild: message.guild,
                asker,
                userPrompt,
                imageUrls,
                beforeMessageId: message.id,
            })
        }

        const stopTyping = DiscordUtil.startTyping(channel)
        try {
            const response = await GrokUtil.chat(
                this.config.xaiApiKey!,
                prompt.text,
                prompt.imageUrls,
                CYAN_SYSTEM_PROMPT
            )
            await this.sendMessageResponse(message, response.text, response.images)
        } finally {
            stopTyping()
        }
    }

    public async draw(interaction: ChatInputCommandInteraction): Promise<void> {
        this.requireApiKey()
        const promptText = interaction.options.getString('prompt', true).trim()
        if (promptText.length === 0) {
            throw new BotError('empty prompt', 'give me something to draw~')
        }
        const aspectRatio = interaction.options.getString('aspect')

        await interaction.deferReply()
        try {
            const image = await GrokUtil.generateImage(
                this.config.xaiApiKey!,
                promptText,
                aspectRatio
            )
            await interaction.editReply({
                files: [
                    {
                        name: 'cyan-draw.png',
                        attachment: image,
                    },
                ],
            })
        } catch (err) {
            console.error('draw error:', err)
            throw new BotError(
                'image generation failed',
                "couldn't draw that… try a different prompt?"
            )
        }
    }

    /** Right-click Draw. Slash commands cannot be sent as a reply, so this targets the message. */
    public async beginDrawFromMessage(
        interaction: MessageContextMenuCommandInteraction
    ): Promise<void> {
        this.requireApiKey()
        if (
            interaction.channelId == null ||
            interaction.channelId !== interaction.targetMessage.channelId
        ) {
            throw new BotError('no channel', "i can't see that channel")
        }
        const images = DiscordUtil.getMessageImages(interaction.targetMessage)
        if (images.length === 0) {
            throw new BotError('no image', "that message doesn't have a pic i can draw from")
        }

        await interaction.showModal(
            buildDrawModal(interaction.channelId, interaction.targetMessage.id)
        )
    }

    public async completeDrawFromMessage(interaction: ModalSubmitInteraction): Promise<void> {
        this.requireApiKey()
        const parsed = parseDrawModalCustomId(interaction.customId)
        if (parsed == null || interaction.channelId !== parsed.channelId) {
            throw new BotError('bad draw modal', "i can't see that channel")
        }
        const promptText = interaction.fields.getTextInputValue('prompt').trim()
        if (promptText.length === 0) {
            throw new BotError('empty prompt', 'give me something to draw~')
        }

        const channel = interaction.channel
        if (channel == null || !channel.isTextBased()) {
            throw new BotError('no channel', "i can't see that channel")
        }

        await interaction.deferReply()
        try {
            let message: Message
            try {
                message = await channel.messages.fetch(parsed.messageId)
            } catch (err) {
                console.error('draw error:', err)
                throw new BotError('message missing', "i can't see that message")
            }

            const imageUrls = DiscordUtil.getMessageImages(message).slice(0, MAX_EDIT_IMAGES)
            if (imageUrls.length === 0) {
                throw new BotError('no image', "that message doesn't have a pic i can draw from")
            }
            const dataUris = await Promise.all(imageUrls.map((url) => this.imageUrlToDataUri(url)))
            const image = await GrokUtil.editImage(this.config.xaiApiKey!, promptText, dataUris)
            await interaction.editReply({
                files: [
                    {
                        name: 'cyan-draw.png',
                        attachment: image,
                    },
                ],
            })
        } catch (err) {
            if (err instanceof BotError) throw err
            console.error('draw error:', err)
            throw new BotError(
                'image generation failed',
                "couldn't draw that… try a different prompt?"
            )
        }
    }

    private async imageUrlToDataUri(url: string): Promise<string> {
        const response = await fetch(url, {
            signal: AbortSignal.timeout(GrokManager.SOURCE_IMAGE_TIMEOUT_MS),
        })
        if (!response.ok) {
            await response.body?.cancel().catch(() => {})
            throw new Error(`failed to fetch source image (${response.status})`)
        }
        // Embed image.url is the original file, not Discord's sized proxy, and
        // attachments only skip files whose metadata is already over the cap.
        // arrayBuffer() would hold a multi-gigabyte body and OOM the process.
        let bytes: Buffer
        try {
            bytes = await readResponseBodyWithLimit(response, MAX_IMAGE_BYTES)
        } catch (err) {
            if (err instanceof ResponseTooLargeError) {
                throw new BotError('image too large', "that pic is too big for me to draw from")
            }
            throw err
        }
        if (bytes.length === 0) {
            throw new Error('source image was empty')
        }
        const header = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? null
        return `data:${GrokManager.imageMediaType(bytes, header)};base64,${bytes.toString('base64')}`
    }

    private static imageMediaType(bytes: Buffer, header: string | null): string {
        if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
            return 'image/jpeg'
        }
        if (
            bytes.length >= 8 &&
            bytes[0] === 0x89 &&
            bytes[1] === 0x50 &&
            bytes[2] === 0x4e &&
            bytes[3] === 0x47
        ) {
            return 'image/png'
        }
        if (header != null && header.startsWith('image/')) return header
        return 'image/png'
    }

    private static readonly MAX_REPLY_CHAIN = 10
    private static readonly MAX_CHANNEL_CONTEXT = 15
    private static readonly MAX_CONTEXT_MSG_LENGTH = 300
    private static readonly SOURCE_IMAGE_TIMEOUT_MS = 30_000

    private requireApiKey(): void {
        if (this.config.xaiApiKey == null) {
            throw new BotError('XAI_API_KEY not configured', 'Chat is not configured on this bot')
        }
    }

    private stripBotMentions(content: string, botId: string): string {
        return content.replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim()
    }

    private async buildDirectPrompt(opts: {
        channel: TextChannel
        guild: Guild | null
        asker: string
        userPrompt: string
        imageUrls: string[]
        beforeMessageId?: string
    }): Promise<GrokPrompt> {
        const context = await this.fetchChannelContext(
            opts.channel,
            opts.guild,
            opts.beforeMessageId
        )

        let text: string
        if (opts.userPrompt.length > 0) {
            text =
                context.length > 0
                    ? `Recent chat:\n${context}\n\n${opts.asker} asks: ${opts.userPrompt}`
                    : opts.userPrompt
        } else {
            text =
                context.length > 0
                    ? `Recent chat:\n${context}\n\n${opts.asker} sent a pic — what's in this?`
                    : "what's in this pic?"
        }
        return new GrokPrompt(text, opts.imageUrls)
    }

    /**
     * Build a prompt from a reply chain.
     * When includeStartingMessage is false (mention replies), the starting message is the
     * user's @bot message — only walk its references; append userPrompt separately.
     */
    private async buildReplyChainPrompt(
        start: Message,
        userPrompt: string,
        opts?: { includeStartingMessage?: boolean; extraImageUrls?: string[] }
    ): Promise<GrokPrompt | null> {
        const includeStarting = opts?.includeStartingMessage !== false
        const chain = includeStarting
            ? await this.fetchReplyChain(start)
            : await this.fetchReplyChainFromReference(start)

        if (chain.length === 0) return null

        const hasChainText = chain.some((m) => DiscordUtil.getMessageText(m).length > 0)
        const hasChainImages = chain.some((m) => DiscordUtil.getMessageImages(m).length > 0)
        const extraImageUrls = opts?.extraImageUrls ?? []
        if (
            !hasChainText &&
            !hasChainImages &&
            extraImageUrls.length === 0 &&
            userPrompt.length === 0
        ) {
            return null
        }

        const now = Date.now()
        const described: { imageUrls: string[]; label: string }[] = []
        const parts: string[] = []
        for (const chainMessage of chain) {
            const content = DiscordUtil.getMessageText(chainMessage)
            const displayName = await DiscordUtil.getMemberDisplayName(
                start.guild,
                chainMessage
            )
            const age = DateUtil.formatRelativeAge(now - chainMessage.createdTimestamp)
            const msgImages = DiscordUtil.getMessageImages(chainMessage)
            described.push({
                imageUrls: msgImages,
                label: `${displayName}, ${age}`,
            })
            if (content.length > 0) {
                parts.push(
                    msgImages.length > 0
                        ? `${displayName} said (with pic, ${age}):\n${content}`
                        : `${displayName} said (${age}):\n${content}`
                )
            } else if (msgImages.length > 0) {
                parts.push(`${displayName} sent a pic (${age})`)
            }
        }

        const picked = replyChainImages(described, extraImageUrls)
        if (picked.earlierImageNote != null) {
            parts.push(picked.earlierImageNote)
        }

        let text = parts.join('\n\n')
        if (userPrompt.length > 0) {
            text = text.length > 0 ? `${text}\n\n${userPrompt}` : userPrompt
        } else if (picked.imageUrls.length > 0) {
            text = text.length > 0 ? `${text}\n\nwhat's in this?` : "what's in this pic?"
        } else {
            text = text.length > 0 ? text : 'help them out with whatever they were talking about'
        }

        return new GrokPrompt(text, picked.imageUrls)
    }

    /** Oldest → newest including the starting message, walking up references. */
    private async fetchReplyChain(start: Message): Promise<Message[]> {
        const chain: Message[] = [start]
        const seen = new Set<string>([start.id])
        let current = start
        while (chain.length < GrokManager.MAX_REPLY_CHAIN) {
            const parent = await this.fetchReplyParent(current)
            if (parent == null || seen.has(parent.id)) break
            seen.add(parent.id)
            chain.push(parent)
            current = parent
        }
        return chain.reverse()
    }

    /** Oldest → newest from the message this one replies to (excludes start). */
    private async fetchReplyChainFromReference(start: Message): Promise<Message[]> {
        const referenced = await this.fetchReplyParent(start)
        if (referenced == null) return []
        return this.fetchReplyChain(referenced)
    }

    /** Full fetch so a cached reply still has its parent reference and attachments. */
    private async fetchReplyParent(message: Message): Promise<Message | null> {
        const messageId = message.reference?.messageId
        const channelId = message.reference?.channelId
        if (messageId == null || channelId == null) return null
        const channel = message.client.channels.resolve(channelId)
        if (channel == null || !channel.isTextBased()) return null
        try {
            return await channel.messages.fetch({ message: messageId, force: true })
        } catch {
            return null
        }
    }

    private async fetchChannelContext(
        channel: TextChannel,
        guild: Guild | null,
        beforeMessageId?: string
    ): Promise<string> {
        try {
            const fetched = await channel.messages.fetch({
                limit: GrokManager.MAX_CHANNEL_CONTEXT,
                ...(beforeMessageId != null ? { before: beforeMessageId } : {}),
            })
            const recent = [...fetched.values()].sort(
                (a, b) => a.createdTimestamp - b.createdTimestamp
            )

            const now = Date.now()
            const parts: string[] = []
            for (const recentMessage of recent) {
                const content = DiscordUtil.getMessageText(recentMessage)
                if (content.length === 0) continue
                const displayName = await DiscordUtil.getMemberDisplayName(guild, recentMessage)
                const age = DateUtil.formatRelativeAge(now - recentMessage.createdTimestamp)
                const truncated =
                    content.length > GrokManager.MAX_CONTEXT_MSG_LENGTH
                        ? content.slice(0, GrokManager.MAX_CONTEXT_MSG_LENGTH) + '…'
                        : content
                parts.push(`${displayName} (${age}): ${truncated}`)
            }
            return parts.join('\n')
        } catch {
            return ''
        }
    }

    private async sendInteractionResponse(
        interaction: ChatInputCommandInteraction | MessageContextMenuCommandInteraction,
        response: string,
        images: Buffer[] = []
    ): Promise<void> {
        const files = images.map((attachment, i) => ({
            name: images.length === 1 ? 'cyan-draw.png' : `cyan-draw-${i + 1}.png`,
            attachment,
        }))
        const chunks =
            response.length > 0
                ? DiscordUtil.splitMessage(response)
                : files.length > 0
                  ? []
                  : ['…']

        if (chunks.length === 0) {
            await interaction.editReply({ files })
            return
        }

        await interaction.editReply({
            content: chunks[0],
            allowedMentions: DiscordUtil.suppressedMentions(),
            ...(files.length > 0 ? { files } : {}),
        })
        for (const chunk of chunks.slice(1)) {
            await interaction.followUp({
                content: chunk,
                allowedMentions: DiscordUtil.suppressedMentions(),
            })
        }
    }

    private async sendMessageResponse(
        message: Message,
        response: string,
        images: Buffer[] = []
    ): Promise<void> {
        const channel = message.channel as TextChannel
        const files = images.map((attachment, i) => ({
            name: images.length === 1 ? 'cyan-draw.png' : `cyan-draw-${i + 1}.png`,
            attachment,
        }))
        const chunks =
            response.length > 0
                ? DiscordUtil.splitMessage(response)
                : files.length > 0
                  ? []
                  : ['…']

        if (chunks.length === 0) {
            await DiscordUtil.tryReply(message, { files })
            return
        }

        const reply = await DiscordUtil.tryReply(message, {
            content: chunks[0],
            ...(files.length > 0 ? { files } : {}),
        })
        if (reply == null) return
        for (const chunk of chunks.slice(1)) {
            await channel.send({
                content: chunk,
                allowedMentions: DiscordUtil.suppressedMentions(),
            })
        }
    }
}
