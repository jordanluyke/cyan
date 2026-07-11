import { injectable } from 'tsyringe'
import {
    ChatInputCommandInteraction,
    Guild,
    Message,
    MessageContextMenuCommandInteraction,
    TextChannel,
} from 'discord.js'
import { Config } from '../config.js'
import { BotError } from '../audio/model/error/bot-error.js'
import { DiscordUtil } from '../util/discord-util.js'
import { GrokUtil } from '../util/grok-util.js'
import { GrokPrompt } from './model/grok-prompt.js'

@injectable()
export class GrokManager {
    constructor(private config: Config) {}

    public async ask(interaction: ChatInputCommandInteraction): Promise<void> {
        this.requireApiKey()
        const promptText = interaction.options.getString('prompt')?.trim() ?? ''
        const attachment = interaction.options.getAttachment('image')
        const imageUrls: string[] = []
        if (attachment != null) {
            if (!DiscordUtil.isSupportedImageAttachment(attachment)) {
                throw new BotError(
                    'unsupported image',
                    'i can only look at jpeg/png images (max 20MB)'
                )
            }
            imageUrls.push(attachment.url)
        }

        if (promptText.length === 0 && imageUrls.length === 0) {
            await interaction.reply({
                content:
                    'try `/ask prompt:what even is calculus`\n' +
                    'or `@` me in chat, attach an image, or right-click a message → **Ask Cyan**',
                ephemeral: true,
            })
            return
        }

        await interaction.deferReply()
        let asker = interaction.user.displayName
        if (interaction.guild != null && interaction.member != null) {
            const member = await DiscordUtil.resolveGuildMember(
                interaction.guild,
                interaction.member,
                interaction.user.id
            )
            asker = member.displayName
        }
        const channel = interaction.channel as TextChannel
        const prompt = await this.buildDirectPrompt({
            channel,
            guild: interaction.guild,
            asker,
            userPrompt: promptText,
            imageUrls,
        })
        const response = await GrokUtil.chat(this.config.xaiApiKey!, prompt)
        await this.sendInteractionResponse(interaction, response)
    }

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

        const response = await GrokUtil.chat(this.config.xaiApiKey!, prompt)
        await this.sendInteractionResponse(interaction, response)
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
                await message.reply({
                    content: 'um… did you need something? try `@` me with a question~',
                    allowedMentions: { repliedUser: false },
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
            const response = await GrokUtil.chat(this.config.xaiApiKey!, prompt)
            await this.sendMessageResponse(message, response)
        } finally {
            stopTyping()
        }
    }

    private static readonly MAX_REPLY_CHAIN = 10
    private static readonly MAX_CHANNEL_CONTEXT = 15
    private static readonly MAX_CONTEXT_MSG_LENGTH = 300

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

        const referencedMessage = chain[chain.length - 1]
        const referencedImages = DiscordUtil.getMessageImages(referencedMessage)
        const imageUrls = [...referencedImages, ...(opts?.extraImageUrls ?? [])]
        const hasChainText = chain.some((m) => DiscordUtil.getMessageText(m).length > 0)
        if (!hasChainText && imageUrls.length === 0 && userPrompt.length === 0) {
            return null
        }

        const parts: string[] = []
        for (const chainMessage of chain) {
            const content = DiscordUtil.getMessageText(chainMessage)
            const displayName = await DiscordUtil.getMemberDisplayName(
                start.guild,
                chainMessage
            )
            if (content.length > 0) {
                parts.push(`${displayName} said:\n${content}`)
            } else if (
                chainMessage.id === referencedMessage.id &&
                referencedImages.length > 0
            ) {
                parts.push(`${displayName} sent a pic`)
            }
        }

        let text = parts.join('\n\n')
        if (userPrompt.length > 0) {
            text = text.length > 0 ? `${text}\n\n${userPrompt}` : userPrompt
        } else if (imageUrls.length > 0) {
            text = text.length > 0 ? `${text}\n\nwhat's in this?` : "what's in this pic?"
        } else {
            text = text.length > 0 ? text : 'help them out with whatever they were talking about'
        }

        return new GrokPrompt(text, imageUrls)
    }

    /** Oldest → newest including the starting message, walking up references. */
    private async fetchReplyChain(start: Message): Promise<Message[]> {
        const chain: Message[] = [start]
        let current = start
        while (current.reference != null && chain.length < GrokManager.MAX_REPLY_CHAIN) {
            try {
                current = await current.fetchReference()
            } catch {
                break
            }
            chain.push(current)
        }
        return chain.reverse()
    }

    /** Oldest → newest from the message this one replies to (excludes start). */
    private async fetchReplyChainFromReference(start: Message): Promise<Message[]> {
        if (start.reference == null) return []
        try {
            const referenced = await start.fetchReference()
            return this.fetchReplyChain(referenced)
        } catch {
            return []
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

            const parts: string[] = []
            for (const recentMessage of recent) {
                const content = DiscordUtil.getMessageText(recentMessage)
                if (content.length === 0) continue
                const displayName = await DiscordUtil.getMemberDisplayName(guild, recentMessage)
                const truncated =
                    content.length > GrokManager.MAX_CONTEXT_MSG_LENGTH
                        ? content.slice(0, GrokManager.MAX_CONTEXT_MSG_LENGTH) + '…'
                        : content
                parts.push(`${displayName}: ${truncated}`)
            }
            return parts.join('\n')
        } catch {
            return ''
        }
    }

    private async sendInteractionResponse(
        interaction: ChatInputCommandInteraction | MessageContextMenuCommandInteraction,
        response: string
    ): Promise<void> {
        const chunks = DiscordUtil.splitMessage(response)
        await interaction.editReply({ content: chunks[0] })
        for (const chunk of chunks.slice(1)) {
            await interaction.followUp({ content: chunk })
        }
    }

    private async sendMessageResponse(message: Message, response: string): Promise<void> {
        const channel = message.channel as TextChannel
        const chunks = DiscordUtil.splitMessage(response)
        await message.reply({ content: chunks[0], allowedMentions: { repliedUser: false } })
        for (const chunk of chunks.slice(1)) {
            await channel.send(chunk)
        }
    }
}
