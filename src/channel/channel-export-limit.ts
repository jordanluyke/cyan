/**
 * Used when the interaction does not say how large an attachment may be.
 * 8MB stays under Discord's historical 10MB default with room for multipart framing.
 */
export const MAX_CHANNEL_EXPORT_BYTES = 8 * 1024 * 1024

const ATTACHMENT_FRAMING_MARGIN_BYTES = 64 * 1024

/** Byte budget for the export file. Prefers the interaction's attachment limit. */
export function resolveChannelExportByteLimit(
    attachmentSizeLimit: number | null | undefined,
): number {
    if (
        attachmentSizeLimit == null ||
        !Number.isFinite(attachmentSizeLimit) ||
        attachmentSizeLimit <= 0
    ) {
        return MAX_CHANNEL_EXPORT_BYTES
    }
    if (attachmentSizeLimit <= ATTACHMENT_FRAMING_MARGIN_BYTES) return attachmentSizeLimit
    return attachmentSizeLimit - ATTACHMENT_FRAMING_MARGIN_BYTES
}

/**
 * Backstop so a channel of tiny messages cannot build an unbounded array
 * before the byte cap binds. Byte size is the limit that actually matters.
 */
export const MAX_CHANNEL_EXPORT_MESSAGES = 5_000

/**
 * True when another message must not be appended.
 * `bufferedBytes` is the running UTF-8 size of messages already kept.
 */
export function shouldStopChannelExport(opts: {
    count: number
    bufferedBytes: number
    nextMessageBytes: number
    maxMessages?: number
    maxBytes?: number
}): boolean {
    const maxMessages = opts.maxMessages ?? MAX_CHANNEL_EXPORT_MESSAGES
    const maxBytes = opts.maxBytes ?? MAX_CHANNEL_EXPORT_BYTES
    if (opts.count >= maxMessages) return true
    if (opts.bufferedBytes + opts.nextMessageBytes > maxBytes) return true
    return false
}

/**
 * Pagination cursor for a fetch page. Discord returns newest-first, so the
 * last id is the oldest and the correct `before` cursor. Returns null when
 * the page is empty or the cursor did not move — callers must stop, or a
 * stuck page retries the same request forever.
 */
export function exportPageCursor(
    pageIds: readonly string[],
    previousCursor: string | undefined,
): string | null {
    const next = pageIds[pageIds.length - 1]
    if (next == null || next.length === 0 || next === previousCursor) return null
    return next
}

/**
 * Keep the longest prefix of `newestFirst` that fits in `maxBytes` once
 * ordered oldest-first for the file. `encodedBytes` measures the full payload.
 */
export function fitNewestExportMessages<T>(
    newestFirst: readonly T[],
    encodedBytes: (oldestFirst: readonly T[]) => number,
    maxBytes: number,
): { messages: T[]; truncated: boolean } {
    const sizeOfCount = (count: number) => encodedBytes([...newestFirst.slice(0, count)].reverse())

    if (newestFirst.length === 0) {
        return { messages: [], truncated: false }
    }
    if (sizeOfCount(newestFirst.length) <= maxBytes) {
        return { messages: [...newestFirst].reverse(), truncated: false }
    }

    let low = 0
    let high = newestFirst.length - 1
    let best = 0
    while (low <= high) {
        const mid = Math.floor((low + high) / 2)
        if (sizeOfCount(mid) <= maxBytes) {
            best = mid
            low = mid + 1
        } else {
            high = mid - 1
        }
    }
    return {
        messages: [...newestFirst.slice(0, best)].reverse(),
        truncated: true,
    }
}
