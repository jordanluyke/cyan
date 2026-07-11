import { ChatInputCommandInteraction } from 'discord.js'
import { injectable } from 'tsyringe'
import {
    CommandInteraction,
    SlashCommandHandler,
} from '../model/slash-command-handler.js'
import { ChannelManager } from '../../channel/channel-manager.js'
import { BotError } from '../../audio/model/error/bot-error.js'

@injectable()
export class DownloadMessages implements SlashCommandHandler {
    constructor(public channelManager: ChannelManager) {}

    public async handle(interaction: CommandInteraction): Promise<void> {
        if (!interaction.isChatInputCommand()) {
            throw new BotError('invalid interaction', 'Expected a slash command')
        }
        return this.channelManager.downloadMessages(interaction as ChatInputCommandInteraction)
    }
}
