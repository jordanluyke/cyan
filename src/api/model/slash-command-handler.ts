import { ChatInputCommandInteraction, MessageContextMenuCommandInteraction } from 'discord.js'

export type CommandInteraction = ChatInputCommandInteraction | MessageContextMenuCommandInteraction

export interface SlashCommandHandler {
    handle(interaction: CommandInteraction): Promise<void>
}
