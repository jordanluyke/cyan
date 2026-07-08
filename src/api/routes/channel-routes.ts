import { Message } from 'discord.js'
import { injectable } from 'tsyringe'
import { MessageRouteHandler } from '../model/message-route-handler.js'
import { ChannelManager } from '../../channel/channel-manager.js'

@injectable()
export class DownloadMessages implements MessageRouteHandler {
    constructor(public channelManager: ChannelManager) {}

    public async handle(message: Message, args: string[]): Promise<void> {
        return this.channelManager.downloadMessages(message)
    }
}
