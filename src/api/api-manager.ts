import { container, singleton } from 'tsyringe'
import { Config } from '../config.js'
import {
    ChatInputCommandInteraction,
    Client,
    GatewayIntentBits,
    Message,
    MessageContextMenuCommandInteraction,
    TextChannel,
} from 'discord.js'
import { BotError } from '../audio/model/error/bot-error.js'
import { ApiV1 } from './api-v1.js'
import { GrokManager } from '../grok/grok-manager.js'

const api = new ApiV1()

@singleton()
export class ApiManager {
    constructor(private config: Config) {}

    public async init(): Promise<void> {
        const client = await this.createDiscordClient()
        await client.login(this.config.botToken)
    }

    private async createDiscordClient(): Promise<Client> {
        const client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.GuildVoiceStates,
            ],
        })

        return client
            .once('clientReady', async () => {
                console.log('Ready')
                client.user.setActivity({
                    name: `/cyan | /ask | @me`,
                })
                try {
                    await client.application.commands.set(api.commands.map((c) => c.data.toJSON()))
                    console.log(`Registered ${api.commands.length} application commands`)
                } catch (err) {
                    console.error('Failed to register slash commands:', err)
                }
            })
            .once('reconnecting', () => {
                console.log('Reconnecting')
            })
            .once('disconnect', () => {
                console.log('Disconnected')
            })
            .on('interactionCreate', async (interaction) => {
                if (interaction.isChatInputCommand() || interaction.isMessageContextMenuCommand()) {
                    await this.routeCommand(interaction)
                }
            })
            .on('messageCreate', async (message) => {
                await this.routeMention(message)
            })
    }

    private async routeMention(message: Message): Promise<void> {
        if (message.author.bot) return
        if (message.guildId == null) return
        if (message.client.user == null) return

        const botId = message.client.user.id
        const mentionedInContent =
            message.content.includes(`<@${botId}>`) || message.content.includes(`<@!${botId}>`)
        if (!mentionedInContent) return

        const grokManager = container.resolve(GrokManager)
        try {
            await grokManager.askFromMention(message)
        } catch (err) {
            console.error(`@mention error: ${err}`)
            if (err instanceof Error) {
                console.error(err.stack ?? err)
            }
            const msg =
                err instanceof BotError && err.sendMessage
                    ? 'Error: ' + err.sendMessage
                    : 'Something bad happened (˚ ˃̣̣̥⌓˂̣̣̥ )'
            try {
                await message.reply({ content: msg, allowedMentions: { repliedUser: false } })
            } catch (replyErr) {
                console.error('Failed to send mention error reply:', replyErr)
                if (message.channel.isTextBased()) {
                    await (message.channel as TextChannel).send(msg)
                }
            }
        }
    }

    private async routeCommand(
        interaction: ChatInputCommandInteraction | MessageContextMenuCommandInteraction
    ): Promise<void> {
        const route = api.commands.find((command) => command.name === interaction.commandName)
        if (route == null) return
        const handler = container.resolve(route.handler)
        try {
            await handler.handle(interaction)
        } catch (err) {
            console.error(`/${interaction.commandName} error: ${err}`)
            if (err instanceof Error) {
                console.error(err.stack ?? err)
            }
            const msg =
                err instanceof BotError && err.sendMessage
                    ? 'Error: ' + err.sendMessage
                    : 'Something bad happened (˚ ˃̣̣̥⌓˂̣̣̥ )'
            try {
                if (interaction.deferred || interaction.replied) {
                    await interaction.followUp({ content: msg, ephemeral: true })
                } else {
                    await interaction.reply({ content: msg, ephemeral: true })
                }
            } catch (replyErr) {
                console.error('Failed to send error reply:', replyErr)
                if (interaction.channel?.isTextBased()) {
                    await (interaction.channel as TextChannel).send(msg)
                }
            }
        }
    }
}
