import { MAX_IMAGE_BYTES } from '../../target/util/discord-util.js'
import {
    ResponseTooLargeError,
    contentLengthExceedsLimit,
    readResponseBodyWithLimit,
} from '../../target/util/response-body-limit.js'

function streamBytes(total, chunkSize, onPull) {
    let sent = 0
    return new ReadableStream({
        pull(controller) {
            if (sent >= total) {
                controller.close()
                return
            }
            const n = Math.min(chunkSize, total - sent)
            sent += n
            onPull?.(sent)
            controller.enqueue(new Uint8Array(n))
        },
    })
}

describe('response body limit', () => {
    test('content-length over the cap is rejected before the body is trusted', () => {
        expect(contentLengthExceedsLimit(null, 10)).toBe(false)
        expect(contentLengthExceedsLimit('', 10)).toBe(false)
        expect(contentLengthExceedsLimit('nope', 10)).toBe(false)
        expect(contentLengthExceedsLimit('10', 10)).toBe(false)
        expect(contentLengthExceedsLimit('11', 10)).toBe(true)
    })

    test('returns a body that fits', async () => {
        const response = new Response(streamBytes(40, 16))
        const bytes = await readResponseBodyWithLimit(response, 40)
        expect(bytes).toHaveLength(40)
    })

    test('stops reading once the body passes the cap', async () => {
        let pulled = 0
        const response = new Response(
            streamBytes(50_000, 100, (sent) => {
                pulled = sent
            }),
        )
        await expect(readResponseBodyWithLimit(response, 250)).rejects.toBeInstanceOf(
            ResponseTooLargeError,
        )
        expect(pulled).toBeLessThan(1000)
    })

    test('rejects a declared length above the draw image cap without draining', async () => {
        let pulled = 0
        const response = new Response(
            streamBytes(MAX_IMAGE_BYTES, 1024, (sent) => {
                pulled = sent
            }),
            {
                headers: { 'content-length': String(MAX_IMAGE_BYTES + 1) },
            },
        )
        await expect(readResponseBodyWithLimit(response, MAX_IMAGE_BYTES)).rejects.toBeInstanceOf(
            ResponseTooLargeError,
        )
        expect(pulled).toBe(0)
    })

    test('counts bytes when content-length understates the body', async () => {
        let pulled = 0
        const response = new Response(
            streamBytes(50_000, 100, (sent) => {
                pulled = sent
            }),
            { headers: { 'content-length': '10' } },
        )
        await expect(readResponseBodyWithLimit(response, 250)).rejects.toBeInstanceOf(
            ResponseTooLargeError,
        )
        expect(pulled).toBeLessThan(1000)
    })

    test('rejects a non-finite cap', async () => {
        const response = new Response(streamBytes(8, 8))
        await expect(
            readResponseBodyWithLimit(response, Number.POSITIVE_INFINITY),
        ).rejects.toBeInstanceOf(ResponseTooLargeError)
    })
})
