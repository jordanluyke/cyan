import { injectable } from 'tsyringe'
import {
    ChatInputCommandInteraction,
    Collection,
    Message,
    MessageFlags,
    PermissionFlagsBits,
    TextChannel,
} from 'discord.js'
import { BotError } from '../audio/model/error/bot-error.js'
import { DiscordUtil } from '../util/discord-util.js'
import {
    exportPageCursor,
    fitNewestExportMessages,
    resolveChannelExportByteLimit,
    shouldStopChannelExport,
} from './channel-export-limit.js'

@injectable()
export class ChannelManager {
    public async downloadMessages(interaction: ChatInputCommandInteraction): Promise<void> {
        const guild = interaction.guild
        if (guild == null) {
            throw new BotError('guild null', 'This command only works in a server')
        }
        if (interaction.channel == null || !interaction.channel.isTextBased()) {
            throw new BotError('channel null', 'Channel not found')
        }
        if (interaction.member == null) {
            throw new BotError('member null', 'Member not found')
        }

        const member = await DiscordUtil.resolveGuildMember(
            guild,
            interaction.member,
            interaction.user.id,
        )
        if (!member.permissions.has(PermissionFlagsBits.Administrator)) {
            throw new BotError('missing permission', 'Only admins can download messages')
        }

        const channel = interaction.channel as TextChannel
        const guildId = interaction.guildId
        const channelId = interaction.channelId

        // Acknowledge the slash command privately; show typing in-channel instead of a
        // "Preparing..." message while the export runs.
        await interaction.deferReply({ flags: MessageFlags.Ephemeral })
        const stopTyping = DiscordUtil.startTyping(channel)

        try {
            // cache:false — fetch() otherwise retains every message in
            // channel.messages.cache for the life of the process (no default
            // message sweeper). A long channel history OOMs the single bot.
            const maxBytes = resolveChannelExportByteLimit(interaction.attachmentSizeLimit)
            const collected: Record<string, unknown>[] = []
            let bufferedBytes = 0
            let truncated = false
            let before: string | undefined
            const pageSize = 100

            while (!truncated) {
                const fetched = await channel.messages.fetch({
                    limit: pageSize,
                    cache: false,
                    ...(before != null ? { before } : {}),
                })
                const page = Array.from(fetched.values())
                const nextBefore = exportPageCursor(
                    page.map((msg) => msg.id),
                    before,
                )
                if (nextBefore == null) break

                for (const msg of page) {
                    const json = this.serializeMessage(msg)
                    if (json == null) continue
                    const nextBytes = Buffer.byteLength(JSON.stringify(json))
                    if (
                        shouldStopChannelExport({
                            count: collected.length,
                            bufferedBytes,
                            nextMessageBytes: nextBytes,
                            maxBytes,
                        })
                    ) {
                        truncated = true
                        break
                    }
                    collected.push(json)
                    bufferedBytes += nextBytes
                }

                before = nextBefore
                if (page.length < pageSize) break
            }

            const timestamp = new Date().getTime()
            const encode = (messages: readonly Record<string, unknown>[]) =>
                Buffer.byteLength(
                    JSON.stringify(
                        {
                            guildName: guild.name,
                            channelName: channel.name,
                            guildId,
                            channelId,
                            timestamp,
                            messages,
                        },
                        null,
                        2,
                    ),
                )
            const fitted = fitNewestExportMessages(collected, encode, maxBytes)
            if (fitted.messages.length === 0 && (truncated || collected.length > 0)) {
                throw new BotError(
                    'export exceeds upload limit',
                    'That history is too large to upload — try a quieter channel',
                )
            }
            truncated = truncated || fitted.truncated

            const data = {
                guildName: guild.name,
                channelName: channel.name,
                guildId,
                channelId,
                timestamp,
                messages: fitted.messages,
            }
            const content = truncated
                ? `Exported **${fitted.messages.length}** most recent messages (older history omitted so the file stays uploadable)`
                : `Exported **${fitted.messages.length}** messages`
            await interaction.editReply({
                content,
                files: [
                    {
                        name: 'messages.json',
                        contentType: 'application/json',
                        attachment: Buffer.from(JSON.stringify(data, null, 2)),
                    },
                ],
            })
        } finally {
            stopTyping()
        }
    }

    /**
     * Plain JSON for one message. Returns null when a message cannot be
     * serialized (circular structure) so one bad message does not fail the export.
     */
    private serializeMessage(msg: Message): Record<string, unknown> | null {
        try {
            const json = msg.toJSON() as Record<string, unknown>
            for (const [key, value] of Object.entries(msg)) {
                if (value instanceof Collection) {
                    json[key] = Object.fromEntries(value.entries())
                } else if (value && typeof value.toJSON === 'function') {
                    json[key] = value.toJSON()
                }
            }
            JSON.stringify(json)
            return json
        } catch (err) {
            console.error('Skipping message that failed to serialize:', msg.id, err)
            return null
        }
    }
}
