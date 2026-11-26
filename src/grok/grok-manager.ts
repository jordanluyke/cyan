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
import {
    ChatContextDraft,
    dropRepliesOutside,
    formatAskAboutPrompt,
    formatChatPrompt,
    toContextLines,
} from './chat-context.js'
import { replyChainImages } from './reply-chain-images.js'
import { shouldFollowReplyReference } from './reply-reference.js'

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
        const prompt = await this.buildChatPrompt(message)
        if (prompt == null) {
            await DiscordUtil.tryReply(message, {
                content: 'um… did you need something? try `@` me with a question~',
            })
            return
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
        const response = await this.fetchDiscordHostedImage(url)
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
    /** Requests, not redirects. Covers a CDN hop and then stops. */
    private static readonly MAX_IMAGE_FETCH_HOPS = 4

    /**
     * Download a source image without following a redirect off Discord's media hosts.
     * `fetch` follows redirects by default, including to link-local addresses.
     */
    private async fetchDiscordHostedImage(url: string): Promise<Response> {
        let current = url
        for (let hop = 0; hop < GrokManager.MAX_IMAGE_FETCH_HOPS; hop++) {
            if (!DiscordUtil.isDiscordHostedMediaUrl(current)) {
                throw new BotError(
                    'unsupported image url',
                    'i can only draw from pics hosted on Discord'
                )
            }
            const response = await fetch(current, {
                redirect: 'manual',
                signal: AbortSignal.timeout(GrokManager.SOURCE_IMAGE_TIMEOUT_MS),
            })
            let next: string | null
            try {
                next = DiscordUtil.discordMediaRedirectTarget(
                    current,
                    response.status,
                    response.headers.get('location')
                )
            } catch (err) {
                await response.body?.cancel().catch(() => {})
                throw new BotError(
                    err instanceof Error ? err.message : 'unsupported image url',
                    'i can only draw from pics hosted on Discord'
                )
            }
            if (next == null) return response
            await response.body?.cancel().catch(() => {})
            current = next
        }
        throw new BotError('unsupported image url', 'i can only draw from pics hosted on Discord')
    }

    private requireApiKey(): void {
        if (this.config.xaiApiKey == null) {
            throw new BotError('XAI_API_KEY not configured', 'Chat is not configured on this bot')
        }
    }

    /**
     * Same transcript for an @mention and a reply. A reply target is a label on that line.
     * Recent channel messages are the context either way. A reply also keeps the message
     * it points at when that message is older than the window, so the label can be read.
     */
    private async buildChatPrompt(message: Message): Promise<GrokPrompt | null> {
        const channel = message.channel as TextChannel
        const botId = message.client.user?.id ?? null
        const imageUrls = DiscordUtil.getMessageImages(message)
        const chain =
            message.reference != null ? await this.fetchReplyChainFromReference(message) : []
        const chainHasContent = chain.some(
            (chainMessage) =>
                DiscordUtil.getMessageText(chainMessage).length > 0 ||
                DiscordUtil.getMessageImages(chainMessage).length > 0
        )
        const currentText = this.contextText(message, botId, false)
        if (currentText.length === 0 && imageUrls.length === 0 && !chainHasContent) return null

        let history: Message[] = []
        try {
            const fetched = await channel.messages.fetch({
                limit: GrokManager.MAX_CHANNEL_CONTEXT,
                before: message.id,
            })
            history = [...fetched.values()]
        } catch {
            history = []
        }

        const byId = new Map<string, Message>()
        for (const prior of [...chain, ...history]) byId.set(prior.id, prior)
        byId.set(message.id, message)
        const ordered = [...byId.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp)
        const fullMessageIds = new Set<string>([
            message.id,
            ...chain.map((chainMessage) => chainMessage.id),
        ])

        const now = Date.now()
        const described = await this.describeContextMessages(
            ordered,
            message.guild,
            channel.id,
            true,
            fullMessageIds
        )
        const lines = toContextLines(described.drafts, now)
        const picked = replyChainImages(
            described.images.map((image) => ({
                imageUrls: image.imageUrls,
                label: `${image.author}, ${DateUtil.formatRelativeAge(now - image.timestamp)}`,
            }))
        )
        return new GrokPrompt(formatChatPrompt(lines, picked.earlierImageNote), picked.imageUrls)
    }

    /** Context menu Ask Cyan: the selected message and the chain that led to it. */
    private async buildReplyChainPrompt(
        start: Message,
        userPrompt: string,
        opts?: { includeStartingMessage?: boolean; extraImageUrls?: string[] }
    ): Promise<GrokPrompt | null> {
        const includeStarting = opts?.includeStartingMessage !== false
        const chain = includeStarting
            ? await this.fetchReplyChain(start, start.channelId)
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
        const describedMessages = await this.describeContextMessages(
            chain,
            start.guild,
            start.channelId,
            false
        )
        // A parent past the chain cap is omitted, so it is not labeled as a reply target.
        const lines = toContextLines(dropRepliesOutside(describedMessages.drafts), now)
        const picked = replyChainImages(
            describedMessages.images.map((image) => ({
                imageUrls: image.imageUrls,
                label: `${image.author}, ${DateUtil.formatRelativeAge(now - image.timestamp)}`,
            })),
            extraImageUrls
        )
        const text = formatAskAboutPrompt({
            chain: lines,
            hasImages: picked.imageUrls.length > 0,
            imageNote: picked.earlierImageNote,
        })
        return new GrokPrompt(text, picked.imageUrls)
    }

    /** Oldest → newest including the starting message, walking up references. */
    private async fetchReplyChain(start: Message, allowedChannelId: string): Promise<Message[]> {
        const chain: Message[] = [start]
        const seen = new Set<string>([start.id])
        let current = start
        while (chain.length < GrokManager.MAX_REPLY_CHAIN) {
            const parent = await this.fetchReplyParent(current, allowedChannelId)
            if (parent == null || seen.has(parent.id)) break
            seen.add(parent.id)
            chain.push(parent)
            current = parent
        }
        return chain.reverse()
    }

    /** Oldest → newest from the message this one replies to (excludes start). */
    private async fetchReplyChainFromReference(start: Message): Promise<Message[]> {
        const referenced = await this.fetchReplyParent(start, start.channelId)
        if (referenced == null) return []
        return this.fetchReplyChain(referenced, start.channelId)
    }

    /**
     * Full fetch so a cached reply still has its parent and attachments.
     * Only `allowedChannelId`: a forward's reference points at another channel
     * the bot can read when the people seeing this reply cannot.
     */
    private async fetchReplyParent(
        message: Message,
        allowedChannelId: string
    ): Promise<Message | null> {
        const messageId = message.reference?.messageId
        const channelId = message.reference?.channelId
        if (messageId == null || channelId == null) return null
        if (!shouldFollowReplyReference(channelId, allowedChannelId)) return null
        const channel = message.client.channels.resolve(channelId)
        if (channel == null || !channel.isTextBased()) return null
        try {
            return await channel.messages.fetch({ message: messageId, force: true })
        } catch {
            return null
        }
    }

    /**
     * Oldest-first drafts. Truncated lines are background and drop pics.
     * `fullMessageIds` stay whole, including pics, so a reply target is readable
     * without a separate prompt shape.
     */
    private async describeContextMessages(
        messages: readonly Message[],
        guild: Guild | null,
        allowedChannelId: string,
        truncate: boolean,
        fullMessageIds?: ReadonlySet<string>
    ): Promise<{
        drafts: ChatContextDraft[]
        images: { imageUrls: string[]; author: string; timestamp: number }[]
    }> {
        if (messages.length === 0) return { drafts: [], images: [] }
        const botId = messages[0].client.user?.id ?? null
        const drafts: ChatContextDraft[] = []
        const images: { imageUrls: string[]; author: string; timestamp: number }[] = []
        for (const message of messages) {
            const author = await DiscordUtil.getMemberDisplayName(guild, message)
            const imageUrls = DiscordUtil.getMessageImages(message)
            const keepFull = !truncate || (fullMessageIds != null && fullMessageIds.has(message.id))
            if (keepFull) images.push({ imageUrls, author, timestamp: message.createdTimestamp })
            const text = this.contextText(message, botId, !keepFull)
            const hasImage = keepFull && imageUrls.length > 0
            if (text.length === 0 && !hasImage && !keepFull) continue
            const replyToId = shouldFollowReplyReference(
                message.reference?.channelId,
                allowedChannelId
            )
                ? (message.reference?.messageId ?? null)
                : null
            drafts.push({
                id: message.id,
                author,
                timestamp: message.createdTimestamp,
                text,
                hasImage,
                mentionsBot: this.messageMentionsBot(message, botId),
                fromBot: botId != null && message.author.id === botId,
                replyToId,
            })
        }
        return { drafts, images }
    }

    /** Bot pings become a "to Cyan" tag, so a raw mention id is not part of the subject. */
    private contextText(message: Message, botId: string | null, truncate: boolean): string {
        let content = DiscordUtil.getMessageText(message)
        if (botId != null) {
            content = content.replace(new RegExp(`<@!?${botId}>`, 'g'), ' ')
            content = content.replace(/[ \t]{2,}/g, ' ').trim()
        }
        if (!truncate || content.length <= GrokManager.MAX_CONTEXT_MSG_LENGTH) return content
        return content.slice(0, GrokManager.MAX_CONTEXT_MSG_LENGTH) + '…'
    }

    private messageMentionsBot(message: Message, botId: string | null): boolean {
        if (botId == null) return false
        if (message.mentions?.users?.has(botId)) return true
        const content = message.content ?? ''
        return content.includes(`<@${botId}>`) || content.includes(`<@!${botId}>`)
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
