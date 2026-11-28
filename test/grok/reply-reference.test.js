import {
    isForwardReference,
    shouldFollowReplyReference,
} from '../../target/grok/reply-reference.js'

describe('forward references', () => {
    test('a forward is not a reply, even with snapshots and no type', () => {
        expect(isForwardReference(1)).toBe(true)
        expect(isForwardReference(1, 0)).toBe(true)
        expect(isForwardReference(undefined, 1)).toBe(true)
        expect(isForwardReference(0)).toBe(false)
        expect(isForwardReference(0, 0)).toBe(false)
        expect(isForwardReference(undefined)).toBe(false)
        expect(isForwardReference(null, null)).toBe(false)
    })
})

describe('shouldFollowReplyReference', () => {
    test('follows a reply in the channel the user invoked the bot from', () => {
        expect(shouldFollowReplyReference('111', '111')).toBe(true)
        expect(shouldFollowReplyReference('111', '111', 0, 0)).toBe(true)
    })

    test('does not follow a forward into the same channel', () => {
        expect(shouldFollowReplyReference('111', '111', 1, 1)).toBe(false)
        expect(shouldFollowReplyReference('111', '111', undefined, 2)).toBe(false)
    })

    test('does not follow a reference into another channel', () => {
        expect(shouldFollowReplyReference('222', '111')).toBe(false)
    })

    test('does not follow when the reference channel is missing', () => {
        expect(shouldFollowReplyReference(null, '111')).toBe(false)
        expect(shouldFollowReplyReference(undefined, '111')).toBe(false)
        expect(shouldFollowReplyReference('', '111')).toBe(false)
    })

    test('does not follow when the invoking channel is missing', () => {
        expect(shouldFollowReplyReference('111', null)).toBe(false)
        expect(shouldFollowReplyReference('111', undefined)).toBe(false)
        expect(shouldFollowReplyReference('111', '')).toBe(false)
    })
})
