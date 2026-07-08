import { Message, TextChannel } from 'discord.js'
import { autoInjectable } from 'tsyringe'
import { Config } from '../../config.js'
import { BotError } from '../../audio/model/error/bot-error.js'
import { GrokUtil } from '../../util/grok-util.js'
import { MessageRouteHandler } from '../model/message-route-handler.js'

@autoInjectable()
export class Grok implements MessageRouteHandler {
    constructor(private config?: Config) {}

    public async handle(message: Message, args: string[]): Promise<void> {
        const channel = message.channel as TextChannel
        if (this.config?.xaiApiKey == null) {
            throw new BotError('XAI_API_KEY not configured', 'Grok is not configured on this bot')
        }
        const prompt = args.join(' ').trim()
        if (prompt.length === 0) {
            await channel.send('Example: !grok What is the capital of France?')
            return
        }
        const response = await GrokUtil.chat(this.config.xaiApiKey, prompt)
        for (const chunk of GrokUtil.splitMessage(response)) {
            await channel.send(chunk)
        }
    }
}
