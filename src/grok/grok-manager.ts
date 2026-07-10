import { injectable } from 'tsyringe'
import { Message, TextChannel } from 'discord.js'
import { Config } from '../config.js'
import { BotError } from '../audio/model/error/bot-error.js'
import { DiscordUtil } from '../util/discord-util.js'
import { GrokUtil } from '../util/grok-util.js'
import { GrokPrompt } from './model/grok-prompt.js'

@injectable()
export class GrokManager {
    constructor(private config: Config) {}

    public async ask(message: Message, args: string[]): Promise<void> {
        if (this.config.xaiApiKey == null) {
            throw new BotError('XAI_API_KEY not configured', 'Grok is not configured on this bot')
        }
        const prompt = await this.buildPrompt(message, args)
        if (prompt == null) {
            await message.reply({
                content:
                    'try `!grok what even is calculus`\n' +
                    'or reply to a message/pic with `!grok explain this`',
                allowedMentions: { repliedUser: false },
            })
            return
        }
        const response = await GrokUtil.chat(this.config.xaiApiKey, prompt)
        await this.sendResponse(message, response)
    }

    private static readonly MAX_REPLY_CHAIN = 10

    private async buildPrompt(message: Message, args: string[]): Promise<GrokPrompt | null> {
        const userPrompt = args.join(' ').trim()
        if (message.reference == null) {
            return this.buildDirectPrompt(message, userPrompt)
        }

        const chain = await this.fetchReplyChain(message)
        if (chain.length === 0) {
            throw new BotError(
                'referenced message not found',
                "couldn't find the message you replied to"
            )
        }

        const referencedMessage = chain[chain.length - 1]
        const imageUrls = DiscordUtil.getMessageImages(referencedMessage)
        const hasChainText = chain.some((m) => DiscordUtil.getMessageText(m).length > 0)
        if (!hasChainText && imageUrls.length === 0 && userPrompt.length === 0) {
            throw new BotError(
                'referenced message has no content',
                "that message doesn't have any text or pics i can read"
            )
        }

        const parts: string[] = []
        for (const chainMessage of chain) {
            const content = DiscordUtil.getMessageText(chainMessage)
            const displayName = await DiscordUtil.getMemberDisplayName(message, chainMessage)
            if (content.length > 0) {
                parts.push(`${displayName} said:\n${content}`)
            } else if (chainMessage.id === referencedMessage.id && imageUrls.length > 0) {
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

    /** Oldest → newest, capped at MAX_REPLY_CHAIN. Images come only from the last (immediate) reply. */
    private async fetchReplyChain(message: Message): Promise<Message[]> {
        const chain: Message[] = []
        let current = message
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

    private buildDirectPrompt(message: Message, userPrompt: string): GrokPrompt | null {
        const imageUrls = DiscordUtil.getMessageImages(message)
        if (userPrompt.length === 0 && imageUrls.length === 0) return null
        const text = userPrompt.length > 0 ? userPrompt : "what's in this pic?"
        return new GrokPrompt(text, imageUrls)
    }

    private async sendResponse(message: Message, response: string): Promise<void> {
        const channel = message.channel as TextChannel
        const chunks = DiscordUtil.splitMessage(response)
        await message.reply({ content: chunks[0], allowedMentions: { repliedUser: false } })
        for (const chunk of chunks.slice(1)) {
            await channel.send(chunk)
        }
    }
}
