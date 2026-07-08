import { container, singleton } from 'tsyringe'
import { Config } from '../config.js'
import { Client, GatewayIntentBits, Message, TextChannel } from 'discord.js'
import { BotError } from '../audio/model/error/bot-error.js'
import { ApiV1 } from './api-v1.js'

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
            .once('clientReady', () => {
                console.log('Ready')
                client.user.setActivity({
                    name: `!cyan | !roll`,
                })
            })
            .once('reconnecting', () => {
                console.log('Reconnecting')
            })
            .once('disconnect', () => {
                console.log('Disconnected')
            })
            .on('messageCreate', async (message) => {
                if (message.author.bot) return
                if (!message.content.startsWith(api.prefix)) return
                if (message.member == null) return
                if (message.guildId == null) return
                await this.routeCommand(message)
            })
    }

    private async routeCommand(message: Message): Promise<void> {
        const parts = message.content
            .trim()
            .split(' ')
            .filter((part) => part != '')
        const command = parts[0].slice(api.prefix.length).toLowerCase()
        const args = parts.slice(1)
        const route = api.commandRoutes.find((route) => route.command == command)
        if (route == null) return
        const handler = container.resolve(route.handler)
        try {
            await handler.handle(message, args)
        } catch (err) {
            console.error(`!${command} error: ${err}`)
            if (err instanceof Error) {
                console.error(err.stack ?? err)
            }
            const msg =
                err instanceof BotError && err.sendMessage
                    ? 'Error: ' + err.sendMessage
                    : 'Something bad happened (˚ ˃̣̣̥⌓˂̣̣̥ )'
            const channel = message.channel as TextChannel
            await channel.send(msg)
        }
    }
}
