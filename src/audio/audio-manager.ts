import { injectable } from 'tsyringe'
import { Config } from '../config.js'
import { AudioQueueItem } from './model/audio-queue-item.js'
import {
    AudioPlayerStatus,
    createAudioResource,
    DiscordGatewayAdapterCreator,
    getVoiceConnection,
    joinVoiceChannel,
} from '@discordjs/voice'
import youtubedl from 'youtube-dl-exec'
import { ClientUser, GuildMember, PermissionFlagsBits, TextChannel } from 'discord.js'
import { youtube_v3 } from '@googleapis/youtube'
import { BotStateManager } from '../bot-state/bot-state-manager.js'
import { BotState } from '../bot-state/model/bot-state.js'
import { TimeUnit } from '../util/time-unit.js'
import { BotError } from './model/error/bot-error.js'
import { Readable } from 'stream'
import { FfmpegUtil } from '../util/ffmpeg-util.js'
import { InputFlag } from './model/input-flag.js'
import { YoutubeUtil } from '../util/youtube-util.js'
import { isPlayStillValid, shouldDequeueOnIdle } from './audio-play-guard.js'

@injectable()
export class AudioManager {
    constructor(
        private config: Config,
        private botStateManager: BotStateManager
    ) {}

    public async play(
        guildId: string,
        member: GuildMember,
        channel: TextChannel,
        query: string,
        pitch?: number | null
    ): Promise<AudioQueueItem[]> {
        const botState = this.getBotStateOrCreate(guildId)
        const queueItems = await this.buildQueueItemsFromInput(member, channel, query, pitch)
        botState.audioQueueItems = botState.audioQueueItems.concat(queueItems)
        const status = botState.audioPlayer.state.status
        // Queue while paused/playing; only start playback when idle.
        if (status !== AudioPlayerStatus.Playing && status !== AudioPlayerStatus.Paused) {
            await this.playNextInQueue(guildId)
        }
        return queueItems
    }

    public async pause(guildId: string): Promise<void> {
        const botState = this.getBotStateOrCreate(guildId)
        botState.audioPlayer.pause()
    }

    public async skip(guildId: string): Promise<boolean> {
        const botState = this.getBotStateOrCreate(guildId)
        if (botState.audioQueueItems.length == 0) return false

        const status = botState.audioPlayer.state.status
        if (status === AudioPlayerStatus.Playing || status === AudioPlayerStatus.Paused) {
            // Idle handler dequeues the finished head and starts the next item.
            botState.audioPlayer.stop()
            return true
        }

        // Idle/Buffering: download in flight — stop() would not fire Idle.
        botState.playEpoch++
        botState.activePlayEpoch = null
        botState.audioQueueItems = botState.audioQueueItems.slice(1)
        if (botState.audioQueueItems.length >= 1) {
            await this.playNextInQueue(guildId)
        }
        return true
    }

    public async stop(guildId: string): Promise<void> {
        const botState = this.getBotStateOrCreate(guildId)
        botState.playEpoch++
        botState.activePlayEpoch = null
        botState.audioQueueItems = []
        botState.audioPlayer.stop(true)
        const connection = getVoiceConnection(guildId)
        connection?.destroy()
    }

    public async getQueue(guildId: string): Promise<AudioQueueItem[]> {
        return this.getBotStateOrCreate(guildId).audioQueueItems
    }

    public getPlayerStatus(guildId: string): AudioPlayerStatus {
        return this.getBotStateOrCreate(guildId).audioPlayer.state.status
    }

    public async clearQueue(guildId: string): Promise<void> {
        const botState = this.getBotStateOrCreate(guildId)
        if (botState.audioQueueItems.length > 0) {
            if (
                botState.audioPlayer.state.status == AudioPlayerStatus.Paused ||
                botState.audioPlayer.state.status == AudioPlayerStatus.Playing
            ) {
                botState.audioQueueItems = botState.audioQueueItems.slice(0, 1)
            } else {
                botState.audioQueueItems = []
            }
        }
    }

    public async replaceQueueItem(
        guildId: string,
        member: GuildMember,
        channel: TextChannel,
        query: string,
        pitch?: number | null
    ): Promise<AudioQueueItem> {
        const queueItems = await this.buildQueueItemsFromInput(member, channel, query, pitch)
        const botState = this.getBotStateOrCreate(guildId)
        if (botState.audioQueueItems.length == 0)
            throw new BotError('items empty', 'No items in queue')
        if (queueItems.length == 0) throw new BotError('queueItems empty', 'No item found in input')

        // Invalidate in-flight downloads and prevent Idle from dequeuing the new head
        // when stopping the track that is currently playing.
        botState.playEpoch++
        botState.activePlayEpoch = null
        botState.audioQueueItems[0] = queueItems[0]
        const status = botState.audioPlayer.state.status
        if (status === AudioPlayerStatus.Playing || status === AudioPlayerStatus.Paused) {
            botState.audioPlayer.stop(true)
        }
        await this.playNextInQueue(guildId)
        return queueItems[0]
    }

    private async buildQueueItemsFromInput(
        member: GuildMember,
        channel: TextChannel,
        query: string,
        pitch?: number | null
    ): Promise<AudioQueueItem[]> {
        const voiceChannel = member.voice.channel
        if (voiceChannel == null)
            throw new BotError('voice channel null', 'Are you in a voice channel?')
        const user = member.client.user as ClientUser | null
        if (user == null) throw new BotError('user null', 'User not found')
        const permissions = voiceChannel.permissionsFor(user)
        if (
            permissions == null ||
            !permissions.has(PermissionFlagsBits.Connect) ||
            !permissions.has(PermissionFlagsBits.Speak)
        )
            throw new BotError('Invalid permissions', "I need connect and speak privileges :'(")

        const trimmed = query.trim()
        if (trimmed.length == 0) return []

        const inputFlags: InputFlag[] = []
        if (pitch != null && !Number.isNaN(pitch)) {
            inputFlags.push(new InputFlag('-p', true, String(pitch)))
        }

        let queueItems: AudioQueueItem[] = []
        const youtube = new youtube_v3.Youtube({
            auth: this.config.youtubeApiKey,
        })

        const input = trimmed.split(/\s+/)[0]

        if (YoutubeUtil.isYoutubeUrl(input)) {
            // Prefer a concrete video id when present. Copied watch URLs often include
            // list= (mix/playlist context); treating those as playlists queues dozens of
            // unintended tracks. Pure playlist URLs have list= without v=.
            const videoId = YoutubeUtil.parseVideoId(input)
            const playlistId = videoId == null ? YoutubeUtil.parsePlaylistId(input) : null
            if (playlistId != null) {
                const res = await youtube.playlistItems.list({
                    maxResults: 50,
                    part: ['snippet'],
                    playlistId: playlistId,
                })
                if (res.data.items == null)
                    throw new BotError('playlist items null', 'No items found in playlist')
                queueItems = res.data.items.map((item) => {
                    if (item.snippet == null)
                        throw new BotError('snippet null', 'Snippet not found')
                    const title = item.snippet.title
                    if (title == null) throw new BotError('title null', 'Title not found')
                    if (item.snippet.resourceId == null)
                        throw new BotError('resourceId null', 'resourceId not found')
                    const playlistVideoId = item.snippet.resourceId.videoId
                    if (playlistVideoId == null)
                        throw new BotError('videoId null', 'videoId not found')
                    return new AudioQueueItem(title, playlistVideoId, member, channel, inputFlags)
                })
            } else {
                if (videoId == null) throw new BotError('Invalid url', 'Invalid YouTube url')
                const res = await youtube.videos.list({
                    part: ['snippet'],
                    id: [videoId],
                })
                const items = res.data.items
                if (items == null || items.length == 0)
                    throw new BotError('video not found', 'Video not found')
                const snippet = items[0].snippet
                if (snippet == null) throw new BotError('snippet null', 'snippet not found')
                const title = snippet.title
                if (title == null) throw new BotError('title null', 'title not found')
                queueItems.push(new AudioQueueItem(title, videoId, member, channel, inputFlags))
            }
        } else {
            const res = await youtube.search.list({
                part: ['snippet'],
                q: trimmed,
                type: ['video'],
                regionCode: 'US',
                safeSearch: 'none',
            })
            const items = res.data.items
            if (items == null) throw new BotError('items null', 'No search results found')
            if (items.length == 0) return []
            const item = items[0]
            const id = item.id
            if (id == null) throw new BotError('id null', 'ID not found')
            const videoId = id.videoId
            if (videoId == null) throw new BotError('videoId null', 'videoId not found')
            const snippet = item.snippet
            if (snippet == null) throw new BotError('snippet null', 'snippet not found')
            const title = snippet.title
            if (title == null) throw new BotError('title null', 'title not found')
            queueItems.push(new AudioQueueItem(title, videoId, member, channel, inputFlags))
        }

        return queueItems
    }

    private async playNextInQueue(guildId: string): Promise<void> {
        const botState = this.botStateManager.getStateOrThrow(guildId)
        if (botState.audioQueueItems.length == 0) throw new BotError('queue empty', 'Queue empty')
        const item = botState.audioQueueItems[0]
        const voiceChannel = item.member.voice.channel
        if (voiceChannel == null)
            throw new BotError('voiceChannel null', 'Are you in a voice channel?')
        let voiceConnection = getVoiceConnection(voiceChannel.guild.id)
        if (voiceConnection == null) {
            voiceConnection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: voiceChannel.guild.id,
                adapterCreator: <DiscordGatewayAdapterCreator>(
                    voiceChannel.guild.voiceAdapterCreator
                ),
            })
        }

        const pitchScaleInput = item.inputFlags.filter((flag) => flag.name == '-p')[0]?.value
        const pitchScale = typeof pitchScaleInput == 'string' ? parseFloat(pitchScaleInput) : null

        const startedEpoch = ++botState.playEpoch
        console.log('Downloading:', item.title, item.getYoutubeUrl())

        this.getYoutubeVideo(item.videoId)
            .then((buffer) => {
                if (
                    !isPlayStillValid(
                        startedEpoch,
                        botState.playEpoch,
                        botState.audioQueueItems[0],
                        item
                    )
                ) {
                    return null
                }
                if (pitchScale == null) return buffer
                return FfmpegUtil.shift(buffer, pitchScale)
            })
            .then((buffer) => {
                if (buffer == null) return
                if (
                    !isPlayStillValid(
                        startedEpoch,
                        botState.playEpoch,
                        botState.audioQueueItems[0],
                        item
                    )
                ) {
                    return
                }
                console.log('Playing...')
                botState.activePlayEpoch = startedEpoch
                botState.audioPlayer.play(createAudioResource(Readable.from(buffer)))
                voiceConnection?.subscribe(botState.audioPlayer)
            })
            .catch(async (error) => {
                console.error('Download/play failed:', error)
                if (
                    !isPlayStillValid(
                        startedEpoch,
                        botState.playEpoch,
                        botState.audioQueueItems[0],
                        item
                    )
                ) {
                    return
                }
                try {
                    await item.sendMessage('Download fail (˚ ˃̣̣̥⌓˂̣̣̥ )')
                } catch (sendErr) {
                    console.error('Failed to send download error message:', sendErr)
                }
                botState.audioQueueItems = botState.audioQueueItems.slice(1)
                if (botState.audioQueueItems.length >= 1) {
                    await this.playNextInQueue(guildId)
                }
            })
    }

    private getYoutubeVideo(videoId: string): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            const chunks: Buffer[] = []
            // reject: false — tinyspawn also returns a Promise; without this a non-zero
            // exit becomes an unhandled rejection and kills the process.
            const subprocess = youtubedl.exec(
                `https://www.youtube.com/watch?v=${videoId}`,
                {
                    output: '-',
                    format: 'bestaudio[acodec=opus]/bestaudio/best',
                    formatSort: ['abr'],
                    // Prefer android client; default web client often 403s on media URLs.
                    // Not in youtube-dl-exec Flags typings yet.
                    extractorArgs: 'youtube:player_client=android',
                    quiet: true,
                    noWarnings: true,
                } as Parameters<typeof youtubedl.exec>[1],
                { reject: false } as Parameters<typeof youtubedl.exec>[2]
            )
            subprocess.stdout.on('data', (chunk: Buffer) => {
                chunks.push(chunk)
            })
            subprocess.on('error', reject)
            subprocess.on('close', (code) => {
                if (code === 0) {
                    resolve(Buffer.concat(chunks))
                    return
                }
                reject(new Error(`yt-dlp exited with code ${code}`))
            })
        })
    }

    private getBotStateOrCreate(guildId: string): BotState {
        let botState = this.botStateManager.getState(guildId)
        if (botState == null) {
            botState = this.botStateManager.createState(guildId)
            this.subscribeOnStateCreate(guildId)
        }
        return botState
    }

    private subscribeOnStateCreate(guildId: string): void {
        const botState = this.botStateManager.getStateOrThrow(guildId)
        botState.audioPlayer
            .on('error', async (error) => {
                console.error('Player error:', error)
                if (botState.audioQueueItems.length == 0) return
                const item = botState.audioQueueItems[0]
                try {
                    await item.sendMessage('Audio stream fail (˚ ˃̣̣̥⌓˂̣̣̥ )')
                } catch (sendErr) {
                    console.error('Failed to send stream error message:', sendErr)
                }
                botState.playEpoch++
                botState.activePlayEpoch = null
                botState.audioQueueItems = botState.audioQueueItems.slice(1)
                if (botState.audioQueueItems.length >= 1) {
                    await this.playNextInQueue(guildId)
                }
            })
            .on(AudioPlayerStatus.Buffering, async () => {
                // console.log("Buffering")
            })
            .on(AudioPlayerStatus.Playing, async () => {
                if (botState.idleTimeout != null) clearTimeout(botState.idleTimeout)
                // console.log("Playing")
            })
            .on(AudioPlayerStatus.Paused, async () => {
                // console.log("Paused")
            })
            .on(AudioPlayerStatus.Idle, async () => {
                // console.log("Idle")
                botState.idleTimeout = setTimeout(() => {
                    const voiceConnection = getVoiceConnection(guildId)
                    voiceConnection?.destroy()
                }, TimeUnit.MINUTES.toMillis(30))

                const finishedEpoch = botState.activePlayEpoch
                botState.activePlayEpoch = null
                if (!shouldDequeueOnIdle(finishedEpoch, botState.playEpoch)) {
                    // stop/replace invalidated this play; do not touch the queue head.
                    return
                }

                botState.audioQueueItems = botState.audioQueueItems.slice(1)
                if (botState.audioQueueItems.length >= 1) {
                    await this.playNextInQueue(guildId)
                }
            })
            .on('unsubscribe', () => {
                console.log('unsubscribe')
            })
    }
}
