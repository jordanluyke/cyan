import { shouldFollowReplyReference } from '../../target/grok/reply-reference.js'

describe('shouldFollowReplyReference', () => {
    test('follows a reply in the channel the user invoked the bot from', () => {
        expect(shouldFollowReplyReference('111', '111')).toBe(true)
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
