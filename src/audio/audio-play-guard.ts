/**
 * Guards async download→play against skip/stop/replace races.
 * Each play attempt captures an epoch; later control commands bump playEpoch
 * so stale downloads must not call audioPlayer.play().
 */
export function isPlayStillValid(
    startedEpoch: number,
    playEpoch: number,
    queueHead: unknown,
    expectedItem: unknown
): boolean {
    return startedEpoch === playEpoch && queueHead === expectedItem
}

/**
 * Idle means the resource that was actively playing finished.
 * Only dequeue when that play is still the current generation — otherwise
 * replace/stop already invalidated the head and owns the queue.
 */
export function shouldDequeueOnIdle(
    activePlayEpoch: number | null,
    playEpoch: number
): boolean {
    return activePlayEpoch != null && activePlayEpoch === playEpoch
}

/**
 * Skip/replace must stop the player whenever a resource is already committed
 * (Playing, Paused, or Buffering). Buffering is not "download in flight" —
 * the AudioPlayer already owns a resource and will reach Playing without stop().
 */
export function shouldStopPlayerForSkip(status: string): boolean {
    return status === 'playing' || status === 'paused' || status === 'buffering'
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
