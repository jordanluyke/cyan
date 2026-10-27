/** Thrown when a response body is larger than the allowed byte cap. */
export class ResponseTooLargeError extends Error {
    constructor() {
        super('response exceeded byte limit')
    }
}

/**
 * True when Content-Length is a finite number above `maxBytes`.
 * Missing or non-numeric lengths are not treated as over — the caller still
 * has to count bytes, because the header can be absent or smaller than the body.
 */
export function contentLengthExceedsLimit(
    contentLength: string | null | undefined,
    maxBytes: number,
): boolean {
    if (contentLength == null || contentLength.length === 0) return false
    const length = Number(contentLength)
    if (!Number.isFinite(length)) return false
    return length > maxBytes
}

/**
 * Read a fetch body without buffering past `maxBytes`.
 * `response.arrayBuffer()` would hold the entire payload; a multi-gigabyte
 * image URL would OOM the process before any size check could run.
 */
export async function readResponseBodyWithLimit(
    response: Response,
    maxBytes: number,
): Promise<Buffer> {
    if (!Number.isFinite(maxBytes) || maxBytes < 0) {
        await cancelResponseBody(response)
        throw new ResponseTooLargeError()
    }
    if (contentLengthExceedsLimit(response.headers.get('content-length'), maxBytes)) {
        await cancelResponseBody(response)
        throw new ResponseTooLargeError()
    }

    const body = response.body
    if (body == null) return Buffer.alloc(0)

    const reader = body.getReader()
    const chunks: Buffer[] = []
    let total = 0
    let tooLarge = false
    try {
        while (true) {
            const { done, value } = await reader.read()
            if (done || value == null) break
            total += value.byteLength
            if (total > maxBytes) {
                tooLarge = true
                break
            }
            chunks.push(Buffer.from(value))
        }
    } finally {
        await reader.cancel().catch(() => {})
    }
    if (tooLarge) throw new ResponseTooLargeError()
    return Buffer.concat(chunks)
}

async function cancelResponseBody(response: Response): Promise<void> {
    await response.body?.cancel().catch(() => {})
}
