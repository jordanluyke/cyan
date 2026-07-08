import { injectable } from 'tsyringe'
import { Message, TextChannel } from 'discord.js'
import { Config } from '../config.js'
import { BotError } from '../audio/model/error/bot-error.js'
import { DiscordUtil } from '../util/discord-util.js'
import { GrokUtil } from '../util/grok-util.js'

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
                    'Example: !grok What is the capital of France?\nOr reply to a message with: !grok explain this',
                allowedMentions: { repliedUser: false },
            })
            return
        }
        const response = await GrokUtil.chat(this.config.xaiApiKey, prompt)
        await this.sendResponse(message, response)
    }

    private async buildPrompt(message: Message, args: string[]): Promise<string | null> {
        const userPrompt = args.join(' ').trim()
        if (message.reference == null) {
            return userPrompt.length > 0 ? userPrompt : null
        }

        let referencedMessage: Message
        try {
            referencedMessage = await message.fetchReference()
        } catch {
            throw new BotError(
                'referenced message not found',
                'Could not find the message you replied to'
            )
        }

        const referencedContent = DiscordUtil.getMessageText(referencedMessage)
        if (referencedContent.length === 0 && userPrompt.length === 0) {
            throw new BotError(
                'referenced message has no text',
                'The message you replied to has no text content'
            )
        }

        const parts: string[] = []
        if (referencedContent.length > 0) {
            const displayName = await DiscordUtil.getMemberDisplayName(message, referencedMessage)
            parts.push(`Referenced message from ${displayName}:\n${referencedContent}`)
        }
        if (userPrompt.length > 0) {
            parts.push(`User request: ${userPrompt}`)
        } else {
            parts.push('Please respond to the referenced message above.')
        }
        return parts.join('\n\n')
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
