import { DateUtil } from '../util/date-util.js'
import { TimeUnit } from '../util/time-unit.js'

/** Silence this long is a topic break, not a pause in the same conversation. */
const TOPIC_GAP_MS = TimeUnit.MINUTES.toMillis(30)

export interface ChatContextDraft {
    id: string
    author: string
    timestamp: number
    text: string
    hasImage?: boolean
    mentionsBot?: boolean
    fromBot?: boolean
    /** Same-channel message this one replies to. Null when it is not a reply. */
    replyToId?: string | null
}

export interface ChatContextLine {
    author: string
    age: string
    text: string
    hasImage?: boolean
    mentionsBot?: boolean
    fromBot?: boolean
    /** Set when the replied-to message is in this same list. */
    replyToAuthor?: string
    /** Replies to a message that is not in this list. */
    repliesToEarlier?: boolean
    /** Compact gap since the previous line, e.g. "2h". */
    gapBefore?: string
}

/**
 * How long the silence before this message lasted, when it is long enough to be a new stretch of chat.
 * Short pauses return null.
 */
export function formatTopicGap(deltaMs: number): string | null {
    if (!(deltaMs >= TOPIC_GAP_MS)) return null
    return DateUtil.formatRelativeAge(deltaMs).replace(/ ago$/, '')
}

/**
 * A capped reply chain should not point at a parent that was left out.
 * Channel history keeps those pointers so a reply to something off-screen stays marked.
 */
export function dropRepliesOutside(drafts: readonly ChatContextDraft[]): ChatContextDraft[] {
    const ids = new Set(drafts.map((draft) => draft.id))
    return drafts.map((draft) => {
        if (draft.replyToId == null || ids.has(draft.replyToId)) return draft
        return { ...draft, replyToId: null }
    })
}

/** Oldest → newest. Reply targets resolve against this list. */
export function toContextLines(drafts: readonly ChatContextDraft[], now: number): ChatContextLine[] {
    const byId = new Map(drafts.map((draft) => [draft.id, draft]))
    let previous: number | null = null
    return drafts.map((draft) => {
        const gapBefore = previous == null ? null : formatTopicGap(draft.timestamp - previous)
        previous = draft.timestamp
        const replyToId = draft.replyToId
        const parent =
            replyToId != null && replyToId.length > 0 ? byId.get(replyToId) : undefined
        return {
            author: draft.author,
            age: DateUtil.formatRelativeAge(now - draft.timestamp),
            text: draft.text,
            hasImage: draft.hasImage === true,
            mentionsBot: draft.mentionsBot === true,
            fromBot: draft.fromBot === true,
            replyToAuthor: parent?.author,
            repliesToEarlier: replyToId != null && replyToId.length > 0 && parent == null,
            gapBefore: gapBefore ?? undefined,
        }
    })
}

export function formatContextLine(line: ChatContextLine): string {
    const bits = [line.age]
    if (line.mentionsBot) bits.push('to Cyan')
    if (line.fromBot) bits.push('from you')
    if (line.replyToAuthor != null && line.replyToAuthor.length > 0) {
        bits.push(`replying to ${line.replyToAuthor}`)
    } else if (line.repliesToEarlier) {
        bits.push('replying to an earlier message')
    }
    if (line.hasImage && line.text.length > 0) bits.push('with pic')
    const body = line.text.length > 0 ? line.text : line.hasImage ? 'sent a pic' : ''
    if (
        body.length === 0 &&
        !line.mentionsBot &&
        (line.replyToAuthor == null || line.replyToAuthor.length === 0) &&
        !line.repliesToEarlier
    ) {
        return ''
    }
    const who = `${line.author} (${bits.join(', ')})`
    return body.length > 0 ? `${who}: ${body}` : who
}

export function formatContextLines(lines: readonly ChatContextLine[]): string {
    const parts: string[] = []
    for (const line of lines) {
        const formatted = formatContextLine(line)
        if (formatted.length === 0) continue
        if (line.gapBefore != null && line.gapBefore.length > 0) {
            parts.push(`— ${line.gapBefore} later —`)
        }
        parts.push(formatted)
    }
    return parts.join('\n')
}

const CHAT_HEADER = 'Channel messages, oldest first. Answer the last one.'

const ASK_ABOUT_HEADER =
    'They asked you about the last message below. Earlier lines are the chain that led there, oldest first.'

/**
 * One transcript for an @mention and a Discord reply. Reply targets are labels on the lines.
 * A single message with no earlier chat stays the raw text.
 */
export function formatChatPrompt(
    lines: readonly ChatContextLine[],
    imageNote?: string | null
): string {
    const note = imageNote != null && imageNote.length > 0 ? imageNote : null
    if (lines.length <= 1 && note == null) {
        const only = lines[0]
        if (only != null && only.replyToAuthor == null && !only.repliesToEarlier) {
            if (only.text.length > 0) return only.text
            if (only.hasImage) return "what's in this pic?"
        }
    }

    const body = formatContextLines(lines)
    const chunks: string[] = []
    if (lines.length > 1) chunks.push(CHAT_HEADER)
    if (body.length > 0) chunks.push(body)
    if (note != null) chunks.push(note)
    return chunks.join('\n\n')
}

export function formatAskAboutPrompt(opts: {
    chain: readonly ChatContextLine[]
    hasImages: boolean
    imageNote?: string | null
}): string {
    const body = formatContextLines(opts.chain)
    const note = opts.imageNote != null && opts.imageNote.length > 0 ? opts.imageNote : null
    if (body.length === 0) {
        return opts.hasImages
            ? "what's in this pic?"
            : 'help them out with whatever they were talking about'
    }
    const chunks = [ASK_ABOUT_HEADER, body]
    if (note != null) chunks.push(note)
    if (opts.hasImages) chunks.push("what's in this?")
    return chunks.join('\n\n')
}

