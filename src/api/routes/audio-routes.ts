import { Message, TextChannel } from 'discord.js'
import { injectable } from 'tsyringe'
import { MessageRouteHandler } from '../model/message-route-handler.js'
import { AudioManager } from '../../audio/audio-manager.js'

@injectable()
export class PlayAudio implements MessageRouteHandler {
    constructor(public audioManager: AudioManager) {}

    public async handle(message: Message, args: string[]): Promise<void> {
        if (message.guild == null) throw new Error('guild null')
        const guildId = message.guild.id
        return this.audioManager.play(guildId, message, args)
    }
}

@injectable()
export class PauseAudio implements MessageRouteHandler {
    constructor(public audioManager: AudioManager) {}

    public async handle(message: Message, args: string[]): Promise<void> {
        if (message.guild == null) throw new Error('guild null')
        const guildId = message.guild.id
        return this.audioManager.pause(guildId)
    }
}

@injectable()
export class StopAudio implements MessageRouteHandler {
    constructor(public audioManager: AudioManager) {}

    public async handle(message: Message, args: string[]): Promise<void> {
        if (message.guild == null) throw new Error('guild null')
        const guildId = message.guild.id
        return this.audioManager.stop(guildId)
    }
}

@injectable()
export class SkipAudio implements MessageRouteHandler {
    constructor(public audioManager: AudioManager) {}

    public async handle(message: Message, args: string[]): Promise<void> {
        if (message.guild == null) throw new Error('guild null')
        const guildId = message.guild.id
        this.audioManager.skip(guildId, message)
    }
}

@injectable()
export class GetAudioQueue implements MessageRouteHandler {
    constructor(public audioManager: AudioManager) {}

    public async handle(message: Message, args: string[]): Promise<void> {
        if (message.guild == null) throw new Error('guild null')
        const guildId = message.guild.id
        const queue = await this.audioManager.getQueue(guildId)
        let response = ''
        if (queue.length > 0) {
            for (let i = 0; i < queue.length; i++) {
                const item = queue[i]
                response += `${i == 0 ? 'Now playing' : i + 1}: ${item.title}\n\n`
            }
        } else {
            response = 'Queue empty'
        }
        const channel = message.channel as TextChannel
        await channel.send(response)
    }
}

@injectable()
export class ClearAudioQueue implements MessageRouteHandler {
    constructor(public audioManager: AudioManager) {}

    public async handle(message: Message, args: string[]): Promise<void> {
        if (message.guild == null) throw new Error('guild null')
        const guildId = message.guild.id
        return this.audioManager.clearQueue(guildId)
    }
}

@injectable()
export class GetAudioSource implements MessageRouteHandler {
    constructor(public audioManager: AudioManager) {}

    public async handle(message: Message, args: string[]): Promise<void> {
        if (message.guild == null) throw new Error('guild null')
        const guildId = message.guild.id
        const queue = await this.audioManager.getQueue(guildId)
        let response = ''
        if (queue.length > 0) {
            response = queue[0].getYoutubeUrl()
        } else {
            response = 'Queue empty'
        }
        const channel = message.channel as TextChannel
        await channel.send(response)
    }
}

@injectable()
export class ReplaceAudioQueueItem implements MessageRouteHandler {
    constructor(public audioManager: AudioManager) {}

    public async handle(message: Message, args: string[]): Promise<void> {
        if (message.guild == null) throw new Error('guild null')
        const guildId = message.guild.id
        return this.audioManager.replaceQueueItem(guildId, message, args)
    }
}
