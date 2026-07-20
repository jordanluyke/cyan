import { injectable } from 'tsyringe'
import { Config } from '../config.js'
import { AudioQueueItem } from './model/audio-queue-item.js'
import { PlayAttempt } from './model/play-attempt.js'
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
import {
    isPlayStillValid,
    shouldDequeueOnIdle,
    shouldScheduleVoiceIdleDisconnect,
    shouldSkipQueueItemForVoice,
    shouldStartPlaybackOnEnqueue,
    shouldStopPlayerForSkip,
} from './audio-play-guard.js'

/** A440 → A444 (≈ C528) pitch scale */
const DEFAULT_PITCH_SCALE = 444 / 440

@injectable()
export class AudioManager {
    constructor(
        private config: Config,
        private botStateManager: BotStateManager,
    ) {}

    public async play(
        guildId: string,
        member: GuildMember,
        channel: TextChannel,
        query: string,
    ): Promise<AudioQueueItem[]> {
        const botState = this.getBotStateOrCreate(guildId)
        const queueItems = await this.buildQueueItemsFromInput(member, channel, query)
        const previousQueueLength = botState.audioQueueItems.length
        botState.audioQueueItems = botState.audioQueueItems.concat(queueItems)
        // Only start when the queue was empty. Empty search results must not call
        // playNextInQueue (throws "Queue empty"), and enqueue while Idle/Buffering
        // must not restart the head already downloading or committed.
        if (shouldStartPlaybackOnEnqueue(previousQueueLength, queueItems.length)) {
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
        if (shouldStopPlayerForSkip(status)) {
            // Idle handler dequeues the finished head and starts the next item.
            // Includes Buffering: player already owns a resource (not download-in-flight).
            botState.audioPlayer.stop()
            return true
        }

        // Idle: download in flight — stop() would not fire Idle.
        this.clearPlayAttempt(botState)
        botState.audioQueueItems = botState.audioQueueItems.slice(1)
        if (botState.audioQueueItems.length >= 1) {
            await this.playNextInQueue(guildId)
        }
        return true
    }

    public async stop(guildId: string): Promise<void> {
        const botState = this.getBotStateOrCreate(guildId)
        this.clearVoiceIdleTimeout(botState)
        this.clearPlayAttempt(botState)
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
            // Keep the committed head whenever the player owns a resource —
            // including Buffering/AutoPaused, which still resume/finish audio.
            if (shouldStopPlayerForSkip(botState.audioPlayer.state.status)) {
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
    ): Promise<AudioQueueItem> {
        const queueItems = await this.buildQueueItemsFromInput(member, channel, query)
        const botState = this.getBotStateOrCreate(guildId)
        if (botState.audioQueueItems.length == 0)
            throw new BotError('items empty', 'No items in queue')
        if (queueItems.length == 0) throw new BotError('queueItems empty', 'No item found in input')

        // Invalidate in-flight downloads and prevent Idle from dequeuing the new head
        // when stopping the track that is currently playing.
        this.clearPlayAttempt(botState)
        botState.audioQueueItems[0] = queueItems[0]
        const status = botState.audioPlayer.state.status
        if (shouldStopPlayerForSkip(status)) {
            botState.audioPlayer.stop(true)
        }
        await this.playNextInQueue(guildId)
        return queueItems[0]
    }

    private async buildQueueItemsFromInput(
        member: GuildMember,
        channel: TextChannel,
        query: string,
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

        const inputFlags: InputFlag[] = [new InputFlag('-p', true, String(DEFAULT_PITCH_SCALE))]

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

    private clearVoiceIdleTimeout(botState: BotState): void {
        if (botState.idleTimeout != null) {
            clearTimeout(botState.idleTimeout)
            botState.idleTimeout = undefined
        }
    }

    private clearPlayAttempt(botState: BotState): void {
        botState.playAttempt?.cancel()
        botState.playAttempt = null
    }

    private async playNextInQueue(guildId: string): Promise<void> {
        const botState = this.botStateManager.getStateOrThrow(guildId)
        // Cancel a leave timer from a prior empty-queue Idle — download may take
        // longer than the remaining window, and destroy() would orphan playback.
        this.clearVoiceIdleTimeout(botState)
        if (botState.audioQueueItems.length == 0) throw new BotError('queue empty', 'Queue empty')
        const item = botState.audioQueueItems[0]
        const voiceChannel = item.member.voice.channel
        let voiceConnection = getVoiceConnection(guildId)
        if (shouldSkipQueueItemForVoice(voiceConnection != null, voiceChannel != null)) {
            // Background advance (Idle / download fail / player error) must not throw —
            // an unhandled rejection can kill the process and stalls the rest of the queue.
            console.error('Skipping queue item; requester left voice and bot is not connected')
            try {
                await item.sendMessage("can't play — nobody's in voice (˚ ˃̣̣̥⌓˂̣̣̥ )")
            } catch (sendErr) {
                console.error('Failed to send voice-channel error message:', sendErr)
            }
            // skip/stop/replace may have mutated the queue while we awaited Discord.
            if (botState.audioQueueItems[0] !== item) return
            voiceConnection = getVoiceConnection(guildId)
            if (
                !shouldSkipQueueItemForVoice(
                    voiceConnection != null,
                    item.member.voice.channel != null,
                )
            ) {
                // Connection or requester voice became available — play instead of skipping.
                await this.playNextInQueue(guildId)
                return
            }
            this.clearPlayAttempt(botState)
            botState.audioQueueItems = botState.audioQueueItems.slice(1)
            if (botState.audioQueueItems.length >= 1) {
                await this.playNextInQueue(guildId)
            }
            return
        }
        if (voiceConnection == null) {
            // Requester is in voice (guarded above); join their channel.
            voiceConnection = joinVoiceChannel({
                channelId: voiceChannel!.id,
                guildId: voiceChannel!.guild.id,
                adapterCreator: <DiscordGatewayAdapterCreator>(
                    voiceChannel!.guild.voiceAdapterCreator
                ),
            })
            // Networking/WebSocket failures emit `error` on the connection.
            // Without a listener, Node treats that as an uncaught exception and
            // kills the single bot process.
            voiceConnection.on('error', (error) => {
                console.error('Voice connection error:', error)
            })
        }

        const pitchScaleInput = item.inputFlags.filter((flag) => flag.name == '-p')[0]?.value
        const pitchScale = typeof pitchScaleInput == 'string' ? parseFloat(pitchScaleInput) : null

        // Cancel any prior in-flight download before starting a new one.
        this.clearPlayAttempt(botState)
        const attempt = new PlayAttempt()
        botState.playAttempt = attempt
        console.log('Downloading:', item.title, item.getYoutubeUrl())

        this.getYoutubeVideo(item.videoId, attempt)
            .then((buffer) => {
                if (
                    !isPlayStillValid(
                        attempt,
                        botState.playAttempt,
                        botState.audioQueueItems[0],
                        item,
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
                        attempt,
                        botState.playAttempt,
                        botState.audioQueueItems[0],
                        item,
                    )
                ) {
                    return
                }
                console.log('Playing...')
                attempt.markPlaying()
                botState.audioPlayer.play(createAudioResource(Readable.from(buffer)))
                voiceConnection?.subscribe(botState.audioPlayer)
            })
            .catch(async (error) => {
                console.error('Download/play failed:', error)
                if (
                    !isPlayStillValid(
                        attempt,
                        botState.playAttempt,
                        botState.audioQueueItems[0],
                        item,
                    )
                ) {
                    return
                }
                try {
                    await item.sendMessage('Download fail (˚ ˃̣̣̥⌓˂̣̣̥ )')
                } catch (sendErr) {
                    console.error('Failed to send download error message:', sendErr)
                }
                // skip/stop/replace may have mutated the queue while we awaited Discord.
                if (
                    !isPlayStillValid(
                        attempt,
                        botState.playAttempt,
                        botState.audioQueueItems[0],
                        item,
                    )
                ) {
                    return
                }
                this.clearPlayAttempt(botState)
                botState.audioQueueItems = botState.audioQueueItems.slice(1)
                if (botState.audioQueueItems.length >= 1) {
                    try {
                        await this.playNextInQueue(guildId)
                    } catch (advanceErr) {
                        console.error('Failed to advance queue after download error:', advanceErr)
                    }
                }
            })
    }

    private getYoutubeVideo(videoId: string, attempt: PlayAttempt): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            const chunks: Buffer[] = []
            const stderrChunks: Buffer[] = []
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
                    // Keep stdout clean for the audio pipe; stderr still gets real errors.
                    quiet: true,
                    noWarnings: true,
                } as Parameters<typeof youtubedl.exec>[1],
                { reject: false } as Parameters<typeof youtubedl.exec>[2],
            )
            attempt.attachDownload(subprocess)
            subprocess.stdout.on('data', (chunk: Buffer) => {
                chunks.push(chunk)
            })
            subprocess.stderr?.on('data', (chunk: Buffer) => {
                stderrChunks.push(chunk)
            })
            subprocess.on('error', (err) => {
                attempt.clearDownload()
                reject(err)
            })
            subprocess.on('close', (code, signal) => {
                // Drop the handle so later cancel() does not signal a dead pid.
                attempt.clearDownload()
                if (code === 0) {
                    resolve(Buffer.concat(chunks))
                    return
                }
                // SIGTERM from PlayAttempt.cancel() — treat as cancellation, not failure.
                if (signal === 'SIGTERM' || subprocess.killed) {
                    reject(new Error('yt-dlp download cancelled'))
                    return
                }
                const stderr = Buffer.concat(stderrChunks).toString('utf8').trim()
                const detail = stderr || '(no stderr)'
                reject(new Error(`yt-dlp exited with code ${code}: ${detail}`))
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
                // @discordjs/voice emits `error` then immediately transitions to Idle.
                // Only notify here — Idle dequeues the failed head. Dequeuing in both
                // handlers races across the await below and drops an extra queued track.
                console.error('Player error:', error)
                if (botState.audioQueueItems.length == 0) return
                const item = botState.audioQueueItems[0]
                try {
                    await item.sendMessage('Audio stream fail (˚ ˃̣̣̥⌓˂̣̣̥ )')
                } catch (sendErr) {
                    console.error('Failed to send stream error message:', sendErr)
                }
            })
            .on(AudioPlayerStatus.Buffering, async () => {
                // console.log("Buffering")
            })
            .on(AudioPlayerStatus.Playing, async () => {
                this.clearVoiceIdleTimeout(botState)
                // console.log("Playing")
            })
            .on(AudioPlayerStatus.Paused, async () => {
                // console.log("Paused")
            })
            .on(AudioPlayerStatus.Idle, async () => {
                // console.log("Idle")
                const attempt = botState.playAttempt
                if (!shouldDequeueOnIdle(attempt)) {
                    // Still downloading, or stop/replace cleared the attempt.
                    return
                }
                // Narrowed: shouldDequeueOnIdle requires non-null + playing
                attempt.isPlaying = false

                botState.audioQueueItems = botState.audioQueueItems.slice(1)
                if (botState.audioQueueItems.length >= 1) {
                    try {
                        await this.playNextInQueue(guildId)
                    } catch (advanceErr) {
                        console.error('Failed to advance queue after idle:', advanceErr)
                    }
                    return
                }

                // Nothing left to play — leave voice after idle grace period.
                if (shouldScheduleVoiceIdleDisconnect(botState.audioQueueItems.length)) {
                    this.clearVoiceIdleTimeout(botState)
                    botState.idleTimeout = setTimeout(() => {
                        const voiceConnection = getVoiceConnection(guildId)
                        voiceConnection?.destroy()
                    }, TimeUnit.MINUTES.toMillis(30))
                }
            })
            .on('unsubscribe', () => {
                console.log('unsubscribe')
            })
    }
}
