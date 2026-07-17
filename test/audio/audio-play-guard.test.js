import {
    isPlayStillValid,
    shouldAdvanceQueueFromPlayerErrorHandler,
    shouldDequeueOnIdle,
    shouldScheduleVoiceIdleDisconnect,
    shouldSkipQueueItemForVoice,
    shouldStartPlaybackOnEnqueue,
    shouldStopPlayerForSkip,
} from '../../target/audio/audio-play-guard.js'
import { PlayAttempt } from '../../target/audio/model/play-attempt.js'

describe('audio-play-guard', () => {
    test('rejects stale downloads after attempt is cleared (skip/stop/replace)', () => {
        const item = { id: 'a' }
        const attempt = new PlayAttempt()
        expect(isPlayStillValid(attempt, attempt, item, item)).toBe(true)
        expect(isPlayStillValid(attempt, null, item, item)).toBe(false)
        expect(isPlayStillValid(attempt, new PlayAttempt(), item, item)).toBe(false)
    })

    test('rejects play when queue head was replaced', () => {
        const original = { id: 'a' }
        const replaced = { id: 'b' }
        const attempt = new PlayAttempt()
        expect(isPlayStillValid(attempt, attempt, replaced, original)).toBe(false)
    })

    test('Idle only dequeues when the live attempt is playing', () => {
        const attempt = new PlayAttempt()
        expect(shouldDequeueOnIdle(attempt)).toBe(false)
        attempt.markPlaying()
        expect(shouldDequeueOnIdle(attempt)).toBe(true)
        expect(shouldDequeueOnIdle(null)).toBe(false)
        // Newer download not yet committed — Idle from prior stop must not dequeue
        const downloading = new PlayAttempt()
        expect(shouldDequeueOnIdle(downloading)).toBe(false)
    })

    test('replace while playing: Idle from stop must not dequeue the new head', () => {
        // A is committed to the player.
        const trackA = { id: 'a' }
        const trackB = { id: 'b' }
        const queue = [trackA]
        let playAttempt = new PlayAttempt()
        playAttempt.markPlaying()

        // /replace: clear attempt, swap head, stop player, start download of B.
        playAttempt = null
        queue[0] = trackB
        const downloadB = new PlayAttempt()
        playAttempt = downloadB
        // player.stop() → Idle fires while B is still downloading (playing=false)

        if (shouldDequeueOnIdle(playAttempt)) {
            playAttempt.isPlaying = false
            queue.shift()
        }

        expect(queue).toEqual([trackB])
        expect(playAttempt).toBe(downloadB)
        expect(downloadB.isPlaying).toBe(false)

        // Later B commits and finishes normally — Idle should dequeue.
        downloadB.markPlaying()
        if (shouldDequeueOnIdle(playAttempt)) {
            playAttempt.isPlaying = false
            queue.shift()
        }
        expect(queue).toEqual([])
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
        const attempt = new PlayAttempt()
        attempt.markPlaying()
        const errorHandlerDequeues = shouldAdvanceQueueFromPlayerErrorHandler()
        const idleDequeues = shouldDequeueOnIdle(attempt)
        if (errorHandlerDequeues) queue.shift()
        if (idleDequeues) queue.shift()
        expect(queue).toEqual(['b', 'c'])
    })

    test('download-fail recheck rejects after skip clears attempt during await', () => {
        const item = { id: 'a' }
        const attempt = new PlayAttempt()
        // Before await: still valid
        expect(isPlayStillValid(attempt, attempt, item, item)).toBe(true)
        // During await, /skip clears playAttempt and replaces head
        const afterSkipHead = { id: 'b' }
        expect(isPlayStillValid(attempt, null, afterSkipHead, item)).toBe(false)
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

    test('voice leave timer only after Idle leaves the queue empty', () => {
        // Still have tracks — advancing must not schedule destroy()
        expect(shouldScheduleVoiceIdleDisconnect(1)).toBe(false)
        expect(shouldScheduleVoiceIdleDisconnect(3)).toBe(false)
        // Truly idle — safe to leave after grace period
        expect(shouldScheduleVoiceIdleDisconnect(0)).toBe(true)

        // Prior empty-queue timer + late /play: clear on play start, schedule
        // only once the new session empties again.
        let leaveScheduled = shouldScheduleVoiceIdleDisconnect(0)
        expect(leaveScheduled).toBe(true)
        // /play starts playNextInQueue → must clear pending leave (not tested
        // here) and must not reschedule while downloading the new head.
        leaveScheduled = shouldScheduleVoiceIdleDisconnect(1)
        expect(leaveScheduled).toBe(false)
    })
})
