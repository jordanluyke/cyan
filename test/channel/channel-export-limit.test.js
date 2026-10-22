import {
    exportPageCursor,
    fitNewestExportMessages,
    resolveChannelExportByteLimit,
    shouldStopChannelExport,
} from '../../target/channel/channel-export-limit.js'

describe('channel export limits', () => {
    test('stops at the message cap and the byte cap', () => {
        expect(
            shouldStopChannelExport({
                count: 2,
                bufferedBytes: 10,
                nextMessageBytes: 5,
                maxMessages: 3,
                maxBytes: 100,
            }),
        ).toBe(false)
        expect(
            shouldStopChannelExport({
                count: 3,
                bufferedBytes: 10,
                nextMessageBytes: 1,
                maxMessages: 3,
                maxBytes: 100,
            }),
        ).toBe(true)
        expect(
            shouldStopChannelExport({
                count: 1,
                bufferedBytes: 90,
                nextMessageBytes: 10,
                maxMessages: 100,
                maxBytes: 100,
            }),
        ).toBe(false)
        expect(
            shouldStopChannelExport({
                count: 1,
                bufferedBytes: 90,
                nextMessageBytes: 11,
                maxMessages: 100,
                maxBytes: 100,
            }),
        ).toBe(true)
    })

    test('byte budget follows the interaction attachment limit', () => {
        expect(resolveChannelExportByteLimit(undefined)).toBe(8 * 1024 * 1024)
        expect(resolveChannelExportByteLimit(0)).toBe(8 * 1024 * 1024)
        expect(resolveChannelExportByteLimit(Number.NaN)).toBe(8 * 1024 * 1024)
        expect(resolveChannelExportByteLimit(10 * 1024 * 1024)).toBe(10 * 1024 * 1024 - 64 * 1024)
        expect(resolveChannelExportByteLimit(1024)).toBe(1024)
    })

    test('pagination cursor advances and stops when a page repeats', () => {
        // Newest-first page: last id is the oldest, and the next `before`.
        expect(exportPageCursor(['new', 'mid', 'old'], undefined)).toBe('old')
        expect(exportPageCursor(['older-2', 'older-1'], 'old')).toBe('older-1')
        expect(exportPageCursor(['older-2', 'older-1'], 'older-1')).toBe(null)
        expect(exportPageCursor([], 'old')).toBe(null)
    })

    test('keeps the newest messages that fit, oldest-first', () => {
        const newestFirst = ['c', 'b', 'a']
        const encode = (oldestFirst) => Buffer.byteLength(JSON.stringify({ messages: oldestFirst }))

        const all = fitNewestExportMessages(newestFirst, encode, 10_000)
        expect(all.truncated).toBe(false)
        expect(all.messages).toEqual(['a', 'b', 'c'])

        const one = Buffer.byteLength(JSON.stringify({ messages: ['c'] }))
        const two = Buffer.byteLength(JSON.stringify({ messages: ['b', 'c'] }))
        const three = Buffer.byteLength(JSON.stringify({ messages: ['a', 'b', 'c'] }))
        expect(two).toBeLessThan(three)

        const fitted = fitNewestExportMessages(newestFirst, encode, two)
        expect(fitted.truncated).toBe(true)
        expect(fitted.messages).toEqual(['b', 'c'])
        expect(
            Buffer.byteLength(JSON.stringify({ messages: fitted.messages })),
        ).toBeLessThanOrEqual(two)

        const none = fitNewestExportMessages(newestFirst, encode, one - 1)
        expect(none.truncated).toBe(true)
        expect(none.messages).toEqual([])
    })
})
