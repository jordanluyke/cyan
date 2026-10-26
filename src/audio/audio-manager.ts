import { injectable } from 'tsyringe'
import { Config } from '../config.js'
import { AudioQueueItem } from './model/audio-queue-item.js'
import { PlayAttempt } from './model/play-attempt.js'
import {
    AudioPlayerStatus,
    createAudioResource,
    DiscordGatewayAdapterCreator,
    entersState,
    getVoiceConnection,
    joinVoiceChannel,
    VoiceConnection,
    VoiceConnectionStatus,
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
    AudioDownloadTooLargeError,
    audioDownloadFilename,
    audioExceedsUploadLimit,
    rawAudioByteCap,
} from './audio-download-limit.js'
import {
    isPlayStillValid,
    shouldDequeueOnIdle,
    shouldForceStopOnSkip,
    shouldKeepHeadOnClear,
    shouldRejoinDisconnectedVoice,
    shouldScheduleVoiceIdleDisconnect,
    shouldDeferPlaybackUntilVoiceReady,
    preventUnhandledSubprocessRejection,
    shouldSkipQueueItemForVoice,
    shouldStartPlaybackOnEnqueue,
    shouldStopPlayerAfterVoiceDisconnectFailure,
    shouldStopPlayerForSkip,
    voiceRejoinDelayMs,
} from './audio-play-guard.js'

/** A440 → A444 (≈ C528) pitch scale */
const DEFAULT_PITCH_SCALE = 444 / 440

/** Wait for Discord to reclaim a Disconnected connection (channel move / blip). */
const VOICE_DISCONNECT_RECOVERY_MS = TimeUnit.SECONDS.toMillis(5)

/** Spacing between voice rejoin attempts after the connection is destroyed. */
const VOICE_REJOIN_RETRY_MS = TimeUnit.SECONDS.toMillis(5)

/** Attach disconnect/error watchers once per VoiceConnection instance. */
const watchedVoiceConnections = new WeakSet<VoiceConnection>()

/** Audio-only. Playback may fall back to a video format; a file upload must not. */
const DOWNLOAD_AUDIO_FORMAT = 'bestaudio[acodec=opus]/bestaudio'

export type DownloadedAudio = {
    title: string
    url: string
    filename: string
    buffer: Buffer
}

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
        // A pending resubscribe would attach the new connection to the skipped resource.
        this.clearVoiceRejoin(botState)

        const status = botState.audioPlayer.state.status
        if (shouldStopPlayerForSkip(status)) {
            // Idle handler dequeues the finished head and starts the next item.
            // Includes Buffering: player already owns a resource (not download-in-flight).
            // Must force: stop(false) only arms silence padding, and Paused/AutoPaused
            // never consume those frames — Idle would never fire and the queue stalls.
            botState.audioPlayer.stop(shouldForceStopOnSkip())
            return true
        }

        // Idle: download in flight — stop() would not fire Idle.
        this.clearPlayAttempt(botState)
        botState.audioQueueItems = botState.audioQueueItems.slice(1)
        if (botState.audioQueueItems.length >= 1) {
            await this.playNextInQueue(guildId)
        } else {
            // No second Idle event — schedule leave or the bot stays in VC forever.
            this.scheduleVoiceIdleDisconnectIfEmpty(guildId, botState)
        }
        return true
    }

    public async stop(guildId: string): Promise<void> {
        const botState = this.getBotStateOrCreate(guildId)
        this.clearVoiceIdleTimeout(botState)
        this.clearVoiceRejoin(botState)
        this.clearPlayAttempt(botState)
        botState.audioQueueItems = []
        botState.audioPlayer.stop(true)
        const connection = getVoiceConnection(guildId)
        connection?.destroy()
        // destroy() arms a resubscribe; /stop already left voice on purpose.
        this.clearVoiceRejoin(botState)
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
            const status = botState.audioPlayer.state.status
            // Keep the head only when it will still reach Idle (Playing/Buffering/
            // AutoPaused). User-Paused never finishes without unpause — keeping it
            // after clear leaves the bot in VC forever with a zombie track.
            if (shouldKeepHeadOnClear(status)) {
                botState.audioQueueItems = botState.audioQueueItems.slice(0, 1)
            } else {
                // Idle: cancel in-flight download/shift. Paused: stop so Idle does
                // not keep a resource after we empty the queue.
                this.clearVoiceRejoin(botState)
                this.clearPlayAttempt(botState)
                botState.audioQueueItems = []
                if (status === AudioPlayerStatus.Paused) {
                    botState.audioPlayer.stop(true)
                }
                // Already Idle, or Paused→stopped without a playing attempt —
                // no Idle dequeue path will schedule leave.
                this.scheduleVoiceIdleDisconnectIfEmpty(guildId, botState)
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
        this.clearVoiceRejoin(botState)
        this.clearPlayAttempt(botState)
        botState.audioQueueItems[0] = queueItems[0]
        const status = botState.audioPlayer.state.status
        if (shouldStopPlayerForSkip(status)) {
            botState.audioPlayer.stop(true)
        }
        await this.playNextInQueue(guildId)
        return queueItems[0]
    }

    /**
     * Download one video's audio and encode it to an mp3 that fits `maxBytes`.
     * Does not join voice or touch the guild queue.
     */
    public async downloadAudio(query: string, maxBytes: number): Promise<DownloadedAudio> {
        const video = await this.resolveSingleVideo(query)
        if (audioExceedsUploadLimit(video.durationSeconds, maxBytes)) {
            throw new BotError('audio too long', "That video's audio is too long to upload here")
        }

        console.log('Downloading audio file:', video.title, video.videoId)
        let raw: Buffer
        try {
            raw = await this.getYoutubeVideo(video.videoId, new PlayAttempt(), {
                maxBytes: rawAudioByteCap(maxBytes),
                format: DOWNLOAD_AUDIO_FORMAT,
            })
        } catch (err) {
            if (err instanceof AudioDownloadTooLargeError) {
                throw new BotError(
                    'audio too large',
                    "That video's audio is too long to upload here",
                )
            }
            if (err instanceof BotError) throw err
            console.error('Audio file download failed:', err)
            throw new BotError('download failed', 'Download fail (˚ ˃̣̣̥⌓˂̣̣̥ )')
        }
        if (raw.length === 0) {
            throw new BotError('empty audio', 'Download fail (˚ ˃̣̣̥⌓˂̣̣̥ )')
        }

        let buffer: Buffer
        try {
            buffer = await FfmpegUtil.toMp3(raw)
        } catch (err) {
            console.error('Audio file encode failed:', err)
            throw new BotError('encode failed', "Couldn't convert that to an audio file")
        }
        if (buffer.length === 0) {
            throw new BotError('empty audio', "Couldn't convert that to an audio file")
        }
        if (buffer.length > maxBytes) {
            throw new BotError('audio too large', "That video's audio is too long to upload here")
        }

        return {
            title: video.title,
            url: `https://www.youtube.com/watch?v=${video.videoId}`,
            filename: audioDownloadFilename(video.title),
            buffer,
        }
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
                // Live stdout downloads never end — chunks grow until the process OOMs.
                if (YoutubeUtil.isLiveOrUpcomingBroadcast(snippet.liveBroadcastContent)) {
                    throw new BotError(
                        'live video',
                        "I can't play live streams or premieres — try a finished video",
                    )
                }
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
            // Prefer the first non-live hit; a live top result would buffer forever.
            const item = items.find(
                (candidate) =>
                    !YoutubeUtil.isLiveOrUpcomingBroadcast(candidate.snippet?.liveBroadcastContent),
            )
            if (item == null) {
                throw new BotError(
                    'live video',
                    "I can't play live streams or premieres — try a different search",
                )
            }
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

    private clearVoiceRejoin(botState: BotState): void {
        if (botState.voiceRejoinTimeout != null) {
            clearTimeout(botState.voiceRejoinTimeout)
            botState.voiceRejoinTimeout = undefined
        }
    }

    /**
     * Leave voice after the idle grace period when the queue is empty.
     * Idle after a finished track is one path; skip/clear/download-fail/voice-skip
     * can also empty the queue while already Idle — those must schedule here or
     * the connection is never destroyed.
     */
    private scheduleVoiceIdleDisconnectIfEmpty(guildId: string, botState: BotState): void {
        if (!shouldScheduleVoiceIdleDisconnect(botState.audioQueueItems.length)) return
        this.clearVoiceIdleTimeout(botState)
        botState.idleTimeout = setTimeout(() => {
            const voiceConnection = getVoiceConnection(guildId)
            voiceConnection?.destroy()
            // Idle leave is intentional — don't rejoin the channel we just left.
            this.clearVoiceRejoin(botState)
        }, TimeUnit.MINUTES.toMillis(30))
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
        // Failed-disconnect destroy() schedules a resubscribe. Advancing (or
        // restarting) playback joins on its own; leaving that timer armed would
        // subscribe the skipped resource.
        this.clearVoiceRejoin(botState)
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
            } else {
                this.scheduleVoiceIdleDisconnectIfEmpty(guildId, botState)
            }
            return
        }
        if (voiceConnection == null) {
            // Requester is in voice (guarded above); join their channel.
            voiceConnection = this.joinAndWatchVoice(voiceChannel!)
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
                return FfmpegUtil.shift(buffer, pitchScale, attempt)
            })
            .then(async (buffer) => {
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
                // Do not reuse the pre-download connection — it may have been
                // destroyed (untracked) or disconnected while yt-dlp/ffmpeg ran.
                // subscribe() on Destroyed is a no-op; Disconnected never becomes
                // playable → AutoPaused forever and the queue stalls.
                const readyConnection = await this.ensureVoiceForPlayback(guildId, item)
                if (readyConnection == null) return
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
                if (shouldDeferPlaybackUntilVoiceReady(readyConnection.state.status)) {
                    // joinVoiceChannel() moves to Disconnected synchronously when
                    // sendPayload fails, and that happens before our listener is
                    // attached — handleVoiceDisconnect never runs, and nothing
                    // will call rejoin() again. subscribe() on that connection
                    // AutoPauses with no Ready subscriber and the queue stalls.
                    // Hold the resource (AutoPaused) and retry until it can play.
                    this.scheduleVoiceRejoin(guildId, readyConnection.joinConfig.channelId, 0)
                } else {
                    readyConnection.subscribe(botState.audioPlayer)
                }
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
                } else {
                    this.scheduleVoiceIdleDisconnectIfEmpty(guildId, botState)
                }
            })
    }

    private joinAndWatchVoice(
        voiceChannel: NonNullable<GuildMember['voice']['channel']>,
    ): VoiceConnection {
        const guildId = voiceChannel.guild.id
        const voiceConnection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId,
            adapterCreator: <DiscordGatewayAdapterCreator>voiceChannel.guild.voiceAdapterCreator,
        })
        if (watchedVoiceConnections.has(voiceConnection)) {
            return voiceConnection
        }
        watchedVoiceConnections.add(voiceConnection)
        // Networking/WebSocket failures emit `error` on the connection.
        // Without a listener, Node treats that as an uncaught exception and
        // kills the single bot process.
        voiceConnection.on('error', (error) => {
            console.error('Voice connection error:', error)
        })
        // Kick / 4014 leave the connection Disconnected with no auto-rejoin.
        // The player then AutoPauses (no Ready subscriber) and the queue stalls.
        voiceConnection.on(VoiceConnectionStatus.Disconnected, () => {
            void this.handleVoiceDisconnect(guildId, voiceConnection)
        })
        // Shard disconnect and guild removal destroy the adapter, which calls
        // VoiceConnection.destroy() directly. That emits `destroyed` and drops
        // the player subscription — it does not emit `disconnected`. The player
        // then sits AutoPaused (resource kept, no Ready subscriber) and Idle
        // never advances. Resubscribe the same player so the track resumes.
        voiceConnection.on(VoiceConnectionStatus.Destroyed, () => {
            this.scheduleVoiceRejoin(guildId, voiceConnection.joinConfig.channelId, 0)
        })
        return voiceConnection
    }

    /**
     * Recover from Disconnected, or destroy and unblock the player so Idle can
     * advance the queue. Network blips transition to Signalling themselves;
     * channel moves often reach Connecting within the grace period.
     */
    private async handleVoiceDisconnect(
        guildId: string,
        voiceConnection: VoiceConnection,
    ): Promise<void> {
        try {
            await Promise.race([
                entersState(
                    voiceConnection,
                    VoiceConnectionStatus.Signalling,
                    VOICE_DISCONNECT_RECOVERY_MS,
                ),
                entersState(
                    voiceConnection,
                    VoiceConnectionStatus.Connecting,
                    VOICE_DISCONNECT_RECOVERY_MS,
                ),
            ])
            return
        } catch {
            // Grace elapsed without reclaim — treat as permanent disconnect.
        }

        try {
            if (voiceConnection.state.status !== VoiceConnectionStatus.Destroyed) {
                voiceConnection.destroy()
            }
        } catch (err) {
            console.error('Failed to destroy disconnected voice connection:', err)
        }

        const botState = this.botStateManager.getState(guildId)
        if (botState == null) return
        // destroy() schedules a same-track resubscribe. This disconnect already
        // failed the grace period — cancel that and let Idle skip the head.
        this.clearVoiceRejoin(botState)
        if (shouldStopPlayerAfterVoiceDisconnectFailure(botState.audioPlayer.state.status)) {
            // Idle dequeues the interrupted head and starts the next item (or
            // schedules leave). Without stop(), AutoPaused never reaches Idle.
            botState.audioPlayer.stop(true)
        }
    }

    /**
     * Try to put the guild back in the channel it was in before the connection
     * was destroyed, and subscribe the existing player. The queued resource stays
     * on the player (AutoPaused); a new Ready subscriber resumes it.
     */
    private scheduleVoiceRejoin(guildId: string, channelId: string | null, attempt: number): void {
        const botState = this.botStateManager.getState(guildId)
        if (botState == null) return
        const delay = voiceRejoinDelayMs(attempt, VOICE_REJOIN_RETRY_MS)
        this.clearVoiceRejoin(botState)
        if (delay == null) {
            const item = botState.audioQueueItems[0]
            if (
                item != null &&
                shouldStopPlayerAfterVoiceDisconnectFailure(botState.audioPlayer.state.status)
            ) {
                void item
                    .sendMessage("lost voice and couldn't rejoin — /skip to keep going")
                    .catch((err) => console.error('Failed to send voice rejoin message:', err))
            }
            return
        }
        botState.voiceRejoinTimeout = setTimeout(() => {
            botState.voiceRejoinTimeout = undefined
            try {
                this.rejoinVoiceAfterLoss(guildId, channelId, attempt)
            } catch (err) {
                console.error('Voice rejoin failed:', err)
                this.scheduleVoiceRejoin(guildId, channelId, attempt + 1)
            }
        }, delay)
    }

    private rejoinVoiceAfterLoss(guildId: string, channelId: string | null, attempt: number): void {
        const botState = this.botStateManager.getState(guildId)
        if (botState == null || botState.audioQueueItems.length === 0) return
        const item = botState.audioQueueItems[0]
        const voiceChannel = this.resolveRejoinChannel(item, channelId)
        if (voiceChannel == null) {
            // Channel cache / requester voice may be briefly stale during a
            // gateway blip. Retry until the budget is gone; don't skip the track.
            this.scheduleVoiceRejoin(guildId, channelId, attempt + 1)
            return
        }

        const voiceConnection = this.joinAndWatchVoice(voiceChannel)
        if (shouldDeferPlaybackUntilVoiceReady(voiceConnection.state.status)) {
            // Shard not Ready: sendPayload fails and the new connection stays
            // Disconnected. Subscribing it would leave the player AutoPaused.
            this.scheduleVoiceRejoin(guildId, channelId, attempt + 1)
            return
        }
        voiceConnection.subscribe(botState.audioPlayer)
        console.log('Rejoined voice after connection loss')
    }

    private resolveRejoinChannel(item: AudioQueueItem, channelId: string | null) {
        if (channelId != null) {
            const cached = item.channel.guild.channels.cache.get(channelId)
            if (cached?.isVoiceBased()) return cached
        }
        return item.member.voice.channel
    }

    /**
     * Re-resolve a usable voice connection after async media prep. Returns null
     * when the queue head was skipped because nobody remains to hear it.
     */
    private async ensureVoiceForPlayback(
        guildId: string,
        item: AudioQueueItem,
    ): Promise<VoiceConnection | null> {
        const botState = this.botStateManager.getStateOrThrow(guildId)
        let voiceConnection = getVoiceConnection(guildId)
        const requesterChannel = item.member.voice.channel

        if (
            voiceConnection != null &&
            shouldRejoinDisconnectedVoice(voiceConnection.state.status)
        ) {
            if (requesterChannel != null) {
                voiceConnection = this.joinAndWatchVoice(requesterChannel)
            } else {
                voiceConnection.destroy()
                // Requester is gone — destroy() must not resubscribe us to that channel.
                this.clearVoiceRejoin(botState)
                voiceConnection = getVoiceConnection(guildId)
            }
        }

        if (shouldSkipQueueItemForVoice(voiceConnection != null, requesterChannel != null)) {
            console.error('Skipping queue item after download; voice unavailable')
            try {
                await item.sendMessage("can't play — nobody's in voice (˚ ˃̣̣̥⌓˂̣̣̥ )")
            } catch (sendErr) {
                console.error('Failed to send voice-channel error message:', sendErr)
            }
            if (botState.audioQueueItems[0] !== item) return null
            voiceConnection = getVoiceConnection(guildId)
            if (
                !shouldSkipQueueItemForVoice(
                    voiceConnection != null,
                    item.member.voice.channel != null,
                )
            ) {
                return this.ensureVoiceForPlayback(guildId, item)
            }
            this.clearPlayAttempt(botState)
            botState.audioQueueItems = botState.audioQueueItems.slice(1)
            if (botState.audioQueueItems.length >= 1) {
                try {
                    await this.playNextInQueue(guildId)
                } catch (advanceErr) {
                    console.error('Failed to advance queue after voice loss:', advanceErr)
                }
            } else {
                this.scheduleVoiceIdleDisconnectIfEmpty(guildId, botState)
            }
            return null
        }

        if (voiceConnection == null) {
            voiceConnection = this.joinAndWatchVoice(requesterChannel!)
        } else if (voiceConnection.state.status === VoiceConnectionStatus.Destroyed) {
            // Defensive: should already be untracked, but never subscribe destroyed.
            voiceConnection = this.joinAndWatchVoice(requesterChannel!)
        }

        return voiceConnection
    }

    private getYoutubeVideo(
        videoId: string,
        attempt: PlayAttempt,
        options?: { maxBytes?: number; format?: string },
    ): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            const chunks: Buffer[] = []
            const stderrChunks: Buffer[] = []
            let totalBytes = 0
            let capped = false
            // reject: false — tinyspawn also returns a Promise; without this a non-zero
            // exit becomes an unhandled rejection and kills the process.
            // Spawn failures still reject that promise; see preventUnhandledSubprocessRejection.
            const subprocess = youtubedl.exec(
                `https://www.youtube.com/watch?v=${videoId}`,
                {
                    output: '-',
                    format: options?.format ?? 'bestaudio[acodec=opus]/bestaudio/best',
                    formatSort: ['abr'],
                    // Prefer android client; default web client often 403s on media URLs.
                    // Not in youtube-dl-exec Flags typings yet.
                    extractorArgs: 'youtube:player_client=android',
                    // Backstop when API metadata missed a live item (e.g. playlist
                    // entries lack liveBroadcastContent) — live stdout never ends.
                    matchFilter: '!is_live',
                    // Keep stdout clean for the audio pipe; stderr still gets real errors.
                    quiet: true,
                    noWarnings: true,
                } as Parameters<typeof youtubedl.exec>[1],
                { reject: false } as Parameters<typeof youtubedl.exec>[2],
            )
            preventUnhandledSubprocessRejection(subprocess)
            attempt.attachDownload(subprocess)
            subprocess.stdout.on('data', (chunk: Buffer) => {
                if (capped) return
                const maxBytes = options?.maxBytes
                if (maxBytes != null && totalBytes + chunk.length > maxBytes) {
                    // Kill before the buffer can grow into a video-sized download.
                    capped = true
                    attempt.cancel()
                    reject(new AudioDownloadTooLargeError())
                    return
                }
                totalBytes += chunk.length
                chunks.push(chunk)
            })
            subprocess.stderr?.on('data', (chunk: Buffer) => {
                stderrChunks.push(chunk)
            })
            subprocess.on('error', (err) => {
                attempt.clearDownload()
                if (capped) return
                reject(err)
            })
            subprocess.on('close', (code, signal) => {
                // Drop the handle so later cancel() does not signal a dead pid.
                attempt.clearDownload()
                if (capped) return
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

    private async resolveSingleVideo(query: string): Promise<{
        title: string
        videoId: string
        durationSeconds: number
    }> {
        const trimmed = query.trim()
        if (trimmed.length === 0) {
            throw new BotError('query empty', 'Send a YouTube search or video link')
        }

        const youtube = new youtube_v3.Youtube({
            auth: this.config.youtubeApiKey,
        })
        const input = trimmed.split(/\s+/)[0]
        let videoId: string

        if (YoutubeUtil.isYoutubeUrl(input)) {
            const parsed = YoutubeUtil.parseVideoId(input)
            if (parsed == null) {
                if (YoutubeUtil.parsePlaylistId(input) != null) {
                    throw new BotError(
                        'playlist url',
                        'Send one video — a playlist is more than one audio file',
                    )
                }
                throw new BotError('Invalid url', 'Invalid YouTube url')
            }
            videoId = parsed
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
            if (items.length === 0) throw new BotError('no results', 'No search results')
            const item = items.find(
                (candidate) =>
                    !YoutubeUtil.isLiveOrUpcomingBroadcast(candidate.snippet?.liveBroadcastContent),
            )
            if (item == null) {
                throw new BotError(
                    'live video',
                    "I can't download live streams or premieres — try a finished video",
                )
            }
            const id = item.id?.videoId
            if (id == null) throw new BotError('videoId null', 'videoId not found')
            videoId = id
        }

        const res = await youtube.videos.list({
            part: ['snippet', 'contentDetails'],
            id: [videoId],
        })
        const items = res.data.items
        if (items == null || items.length === 0) {
            throw new BotError('video not found', 'Video not found')
        }
        const snippet = items[0].snippet
        if (snippet == null) throw new BotError('snippet null', 'snippet not found')
        if (YoutubeUtil.isLiveOrUpcomingBroadcast(snippet.liveBroadcastContent)) {
            throw new BotError(
                'live video',
                "I can't download live streams or premieres — try a finished video",
            )
        }
        const title = snippet.title
        if (title == null) throw new BotError('title null', 'title not found')
        const durationSeconds = YoutubeUtil.parseIsoDurationSeconds(
            items[0].contentDetails?.duration,
        )
        if (durationSeconds == null || durationSeconds <= 0) {
            throw new BotError('duration unknown', "I couldn't read that video's length")
        }
        return { title, videoId, durationSeconds }
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
                this.scheduleVoiceIdleDisconnectIfEmpty(guildId, botState)
            })
            .on('unsubscribe', () => {
                console.log('unsubscribe')
            })
    }
}
