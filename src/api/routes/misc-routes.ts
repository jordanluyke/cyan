import { ChatInputCommandInteraction } from 'discord.js'
import {
    CommandInteraction,
    SlashCommandHandler,
} from '../model/slash-command-handler.js'
import { BotError } from '../../audio/model/error/bot-error.js'

export class Commands implements SlashCommandHandler {
    public async handle(interaction: CommandInteraction): Promise<void> {
        if (!interaction.isChatInputCommand()) {
            throw new BotError('invalid interaction', 'Expected a slash command')
        }
        const chat = interaction as ChatInputCommandInteraction
        await chat.reply(
            [
                '### Audio',
                '`/clear`',
                '`/now`',
                '`/pause`',
                '`/play query:` `[pitch:]`',
                '`/queue`',
                '`/replace query:` `[pitch:]`',
                '`/skip`',
                '`/source`',
                '`/stop`',
                '',
                '### Channel',
                '`/download_messages`',
                '',
                '### Misc',
                '`/ask prompt:` `[image:]`',
                'Mention me (`@Cyan …`) to chat',
                'Right-click a message → **Apps → Ask Cyan**',
            ].join('\n')
        )
    }
}
