import { GuildMember, TextChannel } from 'discord.js'
import { InputFlag } from './input-flag.js'

const youtubeUrlPrefix = 'https://www.youtube.com/watch?v='

export class AudioQueueItem {
    constructor(
        public title: string,
        public videoId: string,
        public member: GuildMember,
        public channel: TextChannel,
        public inputFlags: InputFlag[]
    ) {}

    public getYoutubeUrl(): string {
        return youtubeUrlPrefix + this.videoId
    }

    public get requesterDisplayName(): string {
        return this.member.displayName
    }

    public async sendMessage(msg: string): Promise<void> {
        await this.channel.send(msg)
    }
}
