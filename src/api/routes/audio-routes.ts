import {
    ChatInputCommandInteraction,
    GuildMember,
    TextChannel,
} from 'discord.js'
import { AudioPlayerStatus } from '@discordjs/voice'
import { injectable } from 'tsyringe'
import {
    CommandInteraction,
    SlashCommandHandler,
} from '../model/slash-command-handler.js'
import { AudioManager } from '../../audio/audio-manager.js'
import { BotError } from '../../audio/model/error/bot-error.js'
import { DiscordUtil } from '../../util/discord-util.js'

function asChatInput(interaction: CommandInteraction): ChatInputCommandInteraction {
    if (!interaction.isChatInputCommand()) {
        throw new BotError('invalid interaction', 'Expected a slash command')
    }
    return interaction
}

async function requireGuildContext(interaction: ChatInputCommandInteraction): Promise<{
    guildId: string
    member: GuildMember
    channel: TextChannel
}> {
    if (interaction.guild == null || interaction.guildId == null) {
        throw new BotError('guild null', 'This command only works in a server')
    }
    if (interaction.member == null) {
        throw new BotError('member null', 'Member not found')
    }
    if (interaction.channel == null || !interaction.channel.isTextBased()) {
        throw new BotError('channel null', 'Channel not found')
    }
    const member = await DiscordUtil.resolveGuildMember(
        interaction.guild,
        interaction.member,
        interaction.user.id
    )
    return {
        guildId: interaction.guildId,
        member,
        channel: interaction.channel as TextChannel,
    }
}

function statusLabel(status: AudioPlayerStatus): string {
    if (status === AudioPlayerStatus.Paused) return 'Paused'
    if (status === AudioPlayerStatus.Playing || status === AudioPlayerStatus.Buffering)
        return 'Playing'
    return 'Starting'
}

const MAX_QUEUE_SHOWN = 15

@injectable()
export class PlayAudio implements SlashCommandHandler {
    constructor(public audioManager: AudioManager) {}

    public async handle(interaction: CommandInteraction): Promise<void> {
        const chat = asChatInput(interaction)
        const { guildId, member, channel } = await requireGuildContext(chat)
        const query = chat.options.getString('query', true)
        await chat.deferReply()
        const queued = await this.audioManager.play(guildId, member, channel, query)
        if (queued.length === 0) {
            await chat.editReply('No search results')
            return
        }
        if (queued.length === 1) {
            await chat.editReply(`Queued: **${queued[0].title}**`)
            return
        }
        await chat.editReply(
            `Queued **${queued.length}** tracks (starting with **${queued[0].title}**)`
        )
    }
}

@injectable()
export class PauseAudio implements SlashCommandHandler {
    constructor(public audioManager: AudioManager) {}

    public async handle(interaction: CommandInteraction): Promise<void> {
        const chat = asChatInput(interaction)
        const { guildId } = await requireGuildContext(chat)
        await this.audioManager.pause(guildId)
        await chat.reply('Paused')
    }
}

@injectable()
export class StopAudio implements SlashCommandHandler {
    constructor(public audioManager: AudioManager) {}

    public async handle(interaction: CommandInteraction): Promise<void> {
        const chat = asChatInput(interaction)
        const { guildId } = await requireGuildContext(chat)
        await this.audioManager.stop(guildId)
        await chat.reply('Stopped')
    }
}

@injectable()
export class SkipAudio implements SlashCommandHandler {
    constructor(public audioManager: AudioManager) {}

    public async handle(interaction: CommandInteraction): Promise<void> {
        const chat = asChatInput(interaction)
        const { guildId } = await requireGuildContext(chat)
        const skipped = await this.audioManager.skip(guildId)
        await chat.reply(skipped ? 'Skipped' : 'Queue empty')
    }
}

@injectable()
export class GetNowPlaying implements SlashCommandHandler {
    constructor(public audioManager: AudioManager) {}

    public async handle(interaction: CommandInteraction): Promise<void> {
        const chat = asChatInput(interaction)
        const { guildId } = await requireGuildContext(chat)
        const queue = await this.audioManager.getQueue(guildId)
        if (queue.length === 0) {
            await chat.reply('Nothing playing')
            return
        }
        const item = queue[0]
        const status = this.audioManager.getPlayerStatus(guildId)
        const upNext =
            queue.length > 1
                ? `\nup next: ${queue[1].title}` +
                  (queue.length > 2 ? ` · ${queue.length - 1} in queue` : '')
                : ''
        await chat.reply(
            `**Now playing** (${statusLabel(status)})\n` +
                `${item.title}\n` +
                `${item.getYoutubeUrl()}\n` +
                `requested by ${item.requesterDisplayName}` +
                upNext
        )
    }
}

@injectable()
export class GetAudioQueue implements SlashCommandHandler {
    constructor(public audioManager: AudioManager) {}

    public async handle(interaction: CommandInteraction): Promise<void> {
        const chat = asChatInput(interaction)
        const { guildId } = await requireGuildContext(chat)
        const queue = await this.audioManager.getQueue(guildId)
        if (queue.length === 0) {
            await chat.reply('Queue empty')
            return
        }

        const status = this.audioManager.getPlayerStatus(guildId)
        const lines: string[] = []
        const shown = Math.min(queue.length, MAX_QUEUE_SHOWN)

        for (let i = 0; i < shown; i++) {
            const item = queue[i]
            if (i === 0) {
                lines.push(`**Now playing** (${statusLabel(status)}): ${item.title}`)
                lines.push(
                    `requested by ${item.requesterDisplayName} · ${item.getYoutubeUrl()}`
                )
            } else {
                lines.push(
                    `**${i + 1}.** ${item.title} _(requested by ${item.requesterDisplayName})_`
                )
            }
        }

        if (queue.length > MAX_QUEUE_SHOWN) {
            lines.push(`…and ${queue.length - MAX_QUEUE_SHOWN} more`)
        } else if (queue.length > 1) {
            lines.push(`\n${queue.length} tracks in queue`)
        }

        await chat.reply(lines.join('\n'))
    }
}

@injectable()
export class ClearAudioQueue implements SlashCommandHandler {
    constructor(public audioManager: AudioManager) {}

    public async handle(interaction: CommandInteraction): Promise<void> {
        const chat = asChatInput(interaction)
        const { guildId } = await requireGuildContext(chat)
        await this.audioManager.clearQueue(guildId)
        await chat.reply('Queue cleared')
    }
}

@injectable()
export class GetAudioSource implements SlashCommandHandler {
    constructor(public audioManager: AudioManager) {}

    public async handle(interaction: CommandInteraction): Promise<void> {
        const chat = asChatInput(interaction)
        const { guildId } = await requireGuildContext(chat)
        const queue = await this.audioManager.getQueue(guildId)
        await chat.reply(queue.length > 0 ? queue[0].getYoutubeUrl() : 'Queue empty')
    }
}

@injectable()
export class ReplaceAudioQueueItem implements SlashCommandHandler {
    constructor(public audioManager: AudioManager) {}

    public async handle(interaction: CommandInteraction): Promise<void> {
        const chat = asChatInput(interaction)
        const { guildId, member, channel } = await requireGuildContext(chat)
        const query = chat.options.getString('query', true)
        await chat.deferReply()
        const item = await this.audioManager.replaceQueueItem(guildId, member, channel, query)
        await chat.editReply(`Replaced with: **${item.title}**`)
    }
}
