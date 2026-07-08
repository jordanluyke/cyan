import { Message } from 'discord.js'
import { injectable } from 'tsyringe'
import { GrokManager } from '../../grok/grok-manager.js'
import { MessageRouteHandler } from '../model/message-route-handler.js'

@injectable()
export class Grok implements MessageRouteHandler {
    constructor(private grokManager: GrokManager) {}

    public async handle(message: Message, args: string[]): Promise<void> {
        return this.grokManager.ask(message, args)
    }
}
