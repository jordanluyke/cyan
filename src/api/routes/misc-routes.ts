import { Message, TextChannel } from 'discord.js'
import { RandomUtil } from '../../util/random-util.js'
import { MessageRouteHandler } from '../model/message-route-handler.js'

export class RollDie implements MessageRouteHandler {
    public async handle(message: Message, args: string[]): Promise<void> {
        const channel = message.channel as TextChannel
        try {
            if (args.length != 1) throw new Error('Invalid input')
            const inputSplit = args[0].split('d')
            const kilobytes = 64
            const bytes = kilobytes * 1024
            let numberRolls = 1
            if (inputSplit.length == 2) {
                numberRolls = parseInt(inputSplit[0])
                if (isNaN(numberRolls) || numberRolls <= 0) throw new Error('Invalid input')
            }
            const maxValue = parseInt(inputSplit.slice(-1)[0])
            if (isNaN(maxValue) || maxValue <= 1) throw new Error('Invalid input')

            const rolls: number[] = []
            for (let i = 0; i < numberRolls; i++) {
                const roll = RandomUtil.generateNumber(1, maxValue, bytes)
                rolls.push(roll)
            }
            const total = rolls.reduce((previous, current) => previous + current, 0)
            const multiRollOutput = `[${rolls.join(', ')}] = ${total}`

            await channel.send(`ଘ(੭ ˘ ᵕ˘)━☆ﾟ.*･｡ﾟ ♡ ${numberRolls > 1 ? multiRollOutput : total} ♡`)
        } catch (err) {
            await channel.send('Example: !roll 2d8')
        }
    }
}

export class Commands implements MessageRouteHandler {
    public async handle(message: Message, args: string[]): Promise<void> {
        const channel = message.channel as TextChannel
        await channel.send(
            [
                '### Audio',
                '!clear',
                '!pause',
                '!play [search/url/playlist]',
                '!queue',
                '!replace [search/url/playlist]',
                '!skip',
                '!source',
                '!stop',
                '',
                '### Channel',
                '!download_messages',
                '',
                '### Misc',
                '!roll [dice/number]',
                '!grok [prompt]',
            ].join('\n')
        )
    }
}
