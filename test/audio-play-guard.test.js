import { isPlayStillValid, shouldDequeueOnIdle } from '../target/audio/audio-play-guard.js'

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
})
