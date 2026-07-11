import {
    ChatInputCommandInteraction,
    MessageContextMenuCommandInteraction,
} from 'discord.js'
import { injectable } from 'tsyringe'
import { GrokManager } from '../../grok/grok-manager.js'
import {
    CommandInteraction,
    SlashCommandHandler,
} from '../model/slash-command-handler.js'

@injectable()
export class Grok implements SlashCommandHandler {
    constructor(private grokManager: GrokManager) {}

    public async handle(interaction: CommandInteraction): Promise<void> {
        if (interaction.isMessageContextMenuCommand()) {
            return this.grokManager.askAboutMessage(
                interaction as MessageContextMenuCommandInteraction
            )
        }
        return this.grokManager.ask(interaction as ChatInputCommandInteraction)
    }
}
