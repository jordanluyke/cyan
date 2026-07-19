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
    expectedItem: unknown
): boolean {
    return attempt === playAttempt && queueHead === expectedItem
}

/**
 * Idle means the resource that was actively playing finished.
 * Only dequeue when the live attempt was committed to the player — otherwise
 * we are still downloading (or were cancelled) and Idle is from a prior stop.
 */
export function shouldDequeueOnIdle(
    playAttempt: PlayAttempt | null
): playAttempt is PlayAttempt {
    return playAttempt != null && playAttempt.isPlaying
}

/**
 * Skip/replace must stop the player whenever a resource is already committed
 * (Playing, Paused, Buffering, or AutoPaused). Buffering/AutoPaused are not
 * "download in flight" — the AudioPlayer already owns a resource. AutoPaused
 * (default noSubscriber behavior) still holds that resource and will resume it
 * when a voice connection becomes playable; skipping without stop() leaves the
 * old track playing while the queue advances.
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
 * Queue advance should keep using an existing guild voice connection even if
 * the original requester left VC. Only skip the head when we would need to
 * join and have no channel to join.
 */
export function shouldSkipQueueItemForVoice(
    hasExistingConnection: boolean,
    requesterInVoice: boolean
): boolean {
    return !hasExistingConnection && !requesterInVoice
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
    newItemCount: number
): boolean {
    return newItemCount > 0 && previousQueueLength === 0
}

/**
 * After Idle dequeues the finished head, only schedule the voice leave timer
 * when nothing remains. Scheduling it while the next download is starting lets
 * a prior empty-queue timer (or one set mid-advance) destroy the connection
 * before the new track reaches Playing — silent no-audio failure.
 */
export function shouldScheduleVoiceIdleDisconnect(queueLengthAfterDequeue: number): boolean {
    return queueLengthAfterDequeue === 0
}
