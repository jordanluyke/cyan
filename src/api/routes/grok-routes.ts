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
import { BotError } from '../../audio/model/error/bot-error.js'

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

@injectable()
export class Draw implements SlashCommandHandler {
    constructor(private grokManager: GrokManager) {}

    public async handle(interaction: CommandInteraction): Promise<void> {
        if (!interaction.isChatInputCommand()) {
            throw new BotError('invalid interaction', 'Expected a slash command')
        }
        return this.grokManager.draw(interaction as ChatInputCommandInteraction)
    }
}
