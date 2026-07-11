import { injectable } from 'tsyringe'
import {
    ChatInputCommandInteraction,
    Collection,
    MessageFlags,
    PermissionFlagsBits,
    TextChannel,
} from 'discord.js'
import { BotError } from '../audio/model/error/bot-error.js'
import { DiscordUtil } from '../util/discord-util.js'

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
            interaction.user.id
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
            let messages: any[] = []
            while (true) {
                const limit = 100
                const msgs = await channel.messages
                    .fetch({
                        limit,
                        before: messages.length > 0 ? messages[messages.length - 1].id : undefined,
                    })
                    .then((msgMap) =>
                        Array.from(msgMap.values()).map((msg) => {
                            const json = msg.toJSON()
                            for (const [key, value] of Object.entries(msg)) {
                                if (value instanceof Collection) {
                                    json[key] = Object.fromEntries(value.entries())
                                } else if (value && typeof value.toJSON === 'function') {
                                    json[key] = value.toJSON()
                                }
                            }
                            return json
                        })
                    )

                if (msgs.length == 0) break
                messages = messages.concat(msgs)
                if (msgs.length != limit) break
            }

            messages = messages.reverse()

            const data = {
                guildName: guild.name,
                channelName: channel.name,
                guildId,
                channelId,
                timestamp: new Date().getTime(),
                messages,
            }
            await interaction.editReply({
                content: `Exported **${messages.length}** messages`,
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
}
