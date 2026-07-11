import {
    ContextMenuCommandBuilder,
    SlashCommandBuilder,
    SlashCommandOptionsOnlyBuilder,
} from 'discord.js'
import { SlashCommandHandler } from './slash-command-handler.js'

export type SlashCommandData = SlashCommandBuilder | SlashCommandOptionsOnlyBuilder | ContextMenuCommandBuilder

export class SlashCommand {
    constructor(
        public data: SlashCommandData,
        public handler: new (...args: any[]) => SlashCommandHandler
    ) {}

    public get name(): string {
        return this.data.name
    }
}
