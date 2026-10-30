import { PlayAttempt } from './model/play-attempt.js'

/**
 * Guards async download→play against skip/stop/replace races.
 * Each play attempt is a PlayAttempt token; later control commands clear or
 * replace playAttempt so stale downloads must not call audioPlayer.play().
 */
export function isPlayStillValid(
    attempt: PlayAttempt,
    playAttempt: PlayAttempt | null,
    queueHead: unknown,
    expectedItem: unknown,
): boolean {
    return attempt === playAttempt && queueHead === expectedItem
}

/**
 * Idle means the resource that was actively playing finished.
 * Only dequeue when the live attempt was committed to the player — otherwise
 * we are still downloading (or were cancelled) and Idle is from a prior stop.
 */
export function shouldDequeueOnIdle(playAttempt: PlayAttempt | null): playAttempt is PlayAttempt {
    return playAttempt != null && playAttempt.isPlaying
}

/**
 * Skip/replace must stop the player whenever a resource is already committed
 * (Playing, Paused, Buffering, or AutoPaused). Buffering/AutoPaused are not
 * "download in flight" — the AudioPlayer already owns a resource. AutoPaused
 * (default noSubscriber behavior) still holds that resource and will resume it
 * when a voice connection becomes playable; skipping without stop() leaves the
 * old track playing while the queue advances.
 *
 * Callers must use `audioPlayer.stop(true)`. Default silence padding is 5 frames;
 * `stop(false)` only arms that padding and leaves status unchanged. Paused and
 * AutoPaused never read those frames in `_stepPrepare`, so Idle never fires —
 * the queue head sticks and voice leave never schedules.
 */
export function shouldStopPlayerForSkip(status: string): boolean {
    return (
        status === 'playing' ||
        status === 'paused' ||
        status === 'buffering' ||
        status === 'autopaused'
    )
}

/**
 * Whether skip/replace must pass `force=true` to `audioPlayer.stop`. Always true:
 * without force, Paused/AutoPaused never reach Idle (see shouldStopPlayerForSkip).
 */
export function shouldForceStopOnSkip(): boolean {
    return true
}

/**
 * `/clear` may keep the committed head only when that resource will still reach
 * Idle on its own: Playing/Buffering finish normally; AutoPaused resumes when a
 * subscriber is playable. User-Paused audio never emits Idle without unpause
 * (there is no `/resume`) or an explicit stop — keeping that head after clear
 * leaves a zombie track and never arms the voice leave timer.
 */
export function shouldKeepHeadOnClear(status: string): boolean {
    return status === 'playing' || status === 'buffering' || status === 'autopaused'
}

/**
 * Queue advance should keep using an existing guild voice connection even if
 * the original requester left VC. Only skip the head when we would need to
 * join and have no channel to join.
 */
export function shouldSkipQueueItemForVoice(
    hasExistingConnection: boolean,
    requesterInVoice: boolean,
): boolean {
    return !hasExistingConnection && !requesterInVoice
}

/**
 * After download/pitch, a tracked connection may be Disconnected (kick, move,
 * voice server change). subscribe() still attaches, but playable requires Ready
 * — with default NoSubscriberBehavior.Pause the player sits AutoPaused forever
 * and Idle never advances the queue. joinVoiceChannel() rejoins Disconnected
 * connections; Destroyed ones are already untracked (getVoiceConnection → null).
 */
export function shouldRejoinDisconnectedVoice(
    connectionStatus: string | null | undefined,
): boolean {
    return connectionStatus === 'disconnected'
}

/**
 * @discordjs/voice emits `error` then immediately transitions to Idle in the
 * same turn. Only Idle should dequeue the failed head. If the error handler
 * also dequeues (especially after an await), Idle removes one track and the
 * error handler removes the next — a single stream failure skips two songs.
 */
export function shouldAdvanceQueueFromPlayerErrorHandler(): boolean {
    return false
}

/**
 * `/play` should only kick `playNextInQueue` when the queue was empty before
 * enqueue. Calling it for an empty result set throws "Queue empty" to the user
 * instead of "No search results". Calling it while Idle/Buffering with an
 * existing head restarts the current download/track.
 */
export function shouldStartPlaybackOnEnqueue(
    previousQueueLength: number,
    newItemCount: number,
): boolean {
    return newItemCount > 0 && previousQueueLength === 0
}

/**
 * Schedule the voice leave timer only when the queue is empty. Applies to Idle
 * after the finished head is removed, and to any other path that empties the
 * queue without going through Idle (skip/clear while downloading, download
 * fail, post-download voice skip) — otherwise the bot stays in VC forever.
 * Do not schedule while the next download is starting: a prior empty-queue
 * timer (or one set mid-advance) would destroy the connection before the new
 * track reaches Playing — silent no-audio failure.
 */
export function shouldScheduleVoiceIdleDisconnect(queueLengthAfterDequeue: number): boolean {
    return queueLengthAfterDequeue === 0
}

/**
 * After a voice connection fails to recover from Disconnected (kick / 4014 with
 * no rejoin), stop the player if it still owns a resource. Otherwise the player
 * sits AutoPaused forever (no Ready subscriber), Idle never fires, and the rest
 * of the queue never plays until a manual /skip or /stop.
 */
export function shouldStopPlayerAfterVoiceDisconnectFailure(playerStatus: string): boolean {
    return shouldStopPlayerForSkip(playerStatus)
}

/**
 * How many rejoin attempts to make after the voice connection is destroyed,
 * including the immediate one. attempt 0 runs on the next turn so an
 * intentional destroy()/stop() can cancel it in the same stack.
 */
export const VOICE_REJOIN_MAX_ATTEMPTS = 12

/**
 * A destroyed or still-disconnected connection cannot carry audio. Signalling
 * and Connecting can reach Ready; Ready already can.
 */
export function shouldDeferPlaybackUntilVoiceReady(
    connectionStatus: string | null | undefined,
): boolean {
    return connectionStatus === 'disconnected' || connectionStatus === 'destroyed'
}

/**
 * Delay before voice rejoin attempt `attempt` (0-based). Null means give up.
 * Attempt 0 is immediate (next turn) so a shard blip can resubscribe the
 * AutoPaused player without waiting out a full retry interval. Later attempts
 * wait `retryMs`.
 */
export function voiceRejoinDelayMs(attempt: number, retryMs: number): number | null {
    if (!Number.isInteger(attempt) || attempt < 0 || attempt >= VOICE_REJOIN_MAX_ATTEMPTS) {
        return null
    }
    if (attempt === 0) return 0
    return retryMs
}

/**
 * youtube-dl-exec returns tinyspawn's promise. `{ reject: false }` only stops
 * a non-zero *exit* from rejecting that promise. A failed spawn (`error`,
 * e.g. missing or non-executable yt-dlp) still rejects it, and nothing awaits
 * the promise. Node's default `unhandledRejection=throw` then kills the
 * process — one `/play` takes down every guild.
 *
 * Streaming downloads do not use that promise: tinyspawn stringifies all of
 * stdout when the child is killed. Spawn yt-dlp directly (`yt-dlp-download`)
 * and keep this only if a tinyspawn promise is introduced again.
 */
export function preventUnhandledSubprocessRejection(subprocess: Promise<unknown>): void {
    void subprocess.catch((err) => {
        console.error('yt-dlp subprocess promise rejected:', err)
    })
}
