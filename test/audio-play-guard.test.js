import {
    isPlayStillValid,
    shouldAdvanceQueueFromPlayerErrorHandler,
    shouldDequeueOnIdle,
    shouldSkipQueueItemForVoice,
    shouldStartPlaybackOnEnqueue,
    shouldStopPlayerForSkip,
} from '../target/audio/audio-play-guard.js'

describe('audio-play-guard', () => {
    test('rejects stale downloads after epoch bump (skip/stop/replace)', () => {
        const item = { id: 'a' }
        expect(isPlayStillValid(1, 1, item, item)).toBe(true)
        expect(isPlayStillValid(1, 2, item, item)).toBe(false)
    })

    test('rejects play when queue head was replaced', () => {
        const original = { id: 'a' }
        const replaced = { id: 'b' }
        expect(isPlayStillValid(1, 1, replaced, original)).toBe(false)
    })

    test('Idle only dequeues the active play generation', () => {
        expect(shouldDequeueOnIdle(3, 3)).toBe(true)
        expect(shouldDequeueOnIdle(null, 3)).toBe(false)
        expect(shouldDequeueOnIdle(2, 3)).toBe(false)
    })

    test('skip/replace stops player while buffering, not only playing/paused', () => {
        expect(shouldStopPlayerForSkip('playing')).toBe(true)
        expect(shouldStopPlayerForSkip('paused')).toBe(true)
        expect(shouldStopPlayerForSkip('buffering')).toBe(true)
        expect(shouldStopPlayerForSkip('idle')).toBe(false)
        expect(shouldStopPlayerForSkip('autopaused')).toBe(false)
    })

    test('queue advance keeps existing connection when requester left VC', () => {
        expect(shouldSkipQueueItemForVoice(true, false)).toBe(false)
        expect(shouldSkipQueueItemForVoice(true, true)).toBe(false)
        expect(shouldSkipQueueItemForVoice(false, true)).toBe(false)
        expect(shouldSkipQueueItemForVoice(false, false)).toBe(true)
    })

    test('player error handler must not dequeue; Idle owns queue advance', () => {
        expect(shouldAdvanceQueueFromPlayerErrorHandler()).toBe(false)

        // Simulate error-then-Idle: both dequeuing drops an extra track.
        const queue = ['a', 'b', 'c']
        const errorHandlerDequeues = shouldAdvanceQueueFromPlayerErrorHandler()
        const idleDequeues = shouldDequeueOnIdle(1, 1)
        if (errorHandlerDequeues) queue.shift()
        if (idleDequeues) queue.shift()
        expect(queue).toEqual(['b', 'c'])
    })

    test('download-fail recheck rejects after skip bumps epoch during await', () => {
        const item = { id: 'a' }
        const startedEpoch = 1
        // Before await: still valid
        expect(isPlayStillValid(startedEpoch, 1, item, item)).toBe(true)
        // During await, /skip bumps playEpoch and replaces head
        const afterSkipHead = { id: 'b' }
        expect(isPlayStillValid(startedEpoch, 2, afterSkipHead, item)).toBe(false)
    })

    test('play only starts playback when enqueueing onto an empty queue', () => {
        expect(shouldStartPlaybackOnEnqueue(0, 1)).toBe(true)
        expect(shouldStartPlaybackOnEnqueue(0, 3)).toBe(true)
        // Empty search / no results — must not call playNextInQueue
        expect(shouldStartPlaybackOnEnqueue(0, 0)).toBe(false)
        expect(shouldStartPlaybackOnEnqueue(2, 0)).toBe(false)
        // Queue already has a head (playing, buffering, or download in flight)
        expect(shouldStartPlaybackOnEnqueue(1, 1)).toBe(false)
        expect(shouldStartPlaybackOnEnqueue(3, 2)).toBe(false)
    })
})
