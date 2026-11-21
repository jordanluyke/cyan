import { ChatInputCommandInteraction, MessageFlags } from 'discord.js'
import {
    CommandInteraction,
    SlashCommandHandler,
} from '../model/slash-command-handler.js'
import { BotError } from '../../audio/model/error/bot-error.js'
import { DiceRoll, formatDiceRoll, rollDice } from '../../util/dice.js'

export class Commands implements SlashCommandHandler {
    public async handle(interaction: CommandInteraction): Promise<void> {
        if (!interaction.isChatInputCommand()) {
            throw new BotError('invalid interaction', 'Expected a slash command')
        }
        const chat = interaction as ChatInputCommandInteraction
        await chat.reply({
            content: [
                '### Audio',
                '`/clear`',
                '`/download_audio query:`',
                '`/now`',
                '`/pause`',
                '`/play query:`',
                '`/queue`',
                '`/replace query:`',
                '`/skip`',
                '`/source`',
                '`/stop`',
                '',
                '### Misc',
                '`/roll dice:`',
                '`/draw prompt:` `[aspect:]`',
                'Right-click a pic → **Apps → Draw**',
                '',
                'Mention me (`@Cyan …`) to chat',
                'Or reply to one of my messages to keep talking',
                '',
                'Right-click a message → **Apps → Ask Cyan**',
            ].join('\n'),
            flags: MessageFlags.Ephemeral,
        })
    }
}

export class Roll implements SlashCommandHandler {
    public async handle(interaction: CommandInteraction): Promise<void> {
        if (!interaction.isChatInputCommand()) {
            throw new BotError('invalid interaction', 'Expected a slash command')
        }
        const chat = interaction as ChatInputCommandInteraction
        let roll: DiceRoll
        try {
            roll = rollDice(chat.options.getString('dice', true))
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Example: /roll 2d8'
            throw new BotError(message, message)
        }
        await chat.reply({ content: formatDiceRoll(roll) })
    }
}
