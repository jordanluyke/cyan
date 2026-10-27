import { MAX_PROMPT_IMAGES } from '../util/grok-util.js'

export interface ReplyChainImageMessage {
    imageUrls: readonly string[]
    /** Who sent it and how long ago, for the prompt note. */
    label: string
}

export interface ReplyChainImages {
    /** Latest chain pic first, then the current message, then older pics. Capped. */
    imageUrls: string[]
    /** Set when that pic is not on the newest message. */
    earlierImageNote: string | null
}

/**
 * Collect pics from a reply chain (oldest → newest).
 * Text-only replies in between still leave the latest pic as image 0.
 * At most MAX_PROMPT_IMAGES are attached: that pic, then the current message, then older ones.
 */
export function replyChainImages(
    messagesOldestFirst: readonly ReplyChainImageMessage[],
    extraImageUrls: readonly string[] = []
): ReplyChainImages {
    const newestFirst = [...messagesOldestFirst].reverse()
    const latestIndex = newestFirst.findIndex((message) => message.imageUrls.length > 0)
    const latestChainUrls = latestIndex >= 0 ? newestFirst[latestIndex].imageUrls : []
    const olderChainUrls = newestFirst.flatMap((message, index) =>
        index === latestIndex ? [] : message.imageUrls
    )

    const seen = new Set<string>()
    const imageUrls: string[] = []
    for (const url of [...latestChainUrls, ...extraImageUrls, ...olderChainUrls]) {
        if (url.length === 0 || seen.has(url)) continue
        seen.add(url)
        imageUrls.push(url)
        if (imageUrls.length >= MAX_PROMPT_IMAGES) break
    }

    const earlierImageNote =
        latestIndex > 0
            ? 'Attached images are newest-first. ' +
              `Image 0 is the latest pic in this reply chain (${newestFirst[latestIndex].label}), ` +
              'from earlier in the chain. ' +
              'Edit image 0 when they want that pic changed. ' +
              'When they are only commenting, treat it as context.'
            : null

    return { imageUrls, earlierImageNote }
}
