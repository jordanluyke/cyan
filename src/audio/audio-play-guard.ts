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
