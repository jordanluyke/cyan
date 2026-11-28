/**
 * Discord `message_reference.type` for a forward.
 * Omitted or 0 is a normal reply.
 * @see https://discord.com/developers/docs/resources/message#message-reference-types
 */
const FORWARD_REFERENCE_TYPE = 1

/**
 * A forward cites the source message. It is not a reply to that message, even
 * when the source is in this channel or was sent by the bot.
 * `snapshotCount` covers a payload that includes snapshots but omits the type.
 */
export function isForwardReference(
    referenceType: number | null | undefined,
    snapshotCount?: number | null
): boolean {
    if (referenceType === FORWARD_REFERENCE_TYPE) return true
    return typeof snapshotCount === 'number' && snapshotCount > 0
}

/**
 * True when a reply reference stays in the channel the user invoked the bot in.
 * Forwards are not replies. Crossposts and thread starters cite other channels.
 * The bot can read those even when the people who will see this reply cannot.
 */
export function shouldFollowReplyReference(
    referenceChannelId: string | null | undefined,
    allowedChannelId: string | null | undefined,
    referenceType?: number | null,
    snapshotCount?: number | null
): boolean {
    if (isForwardReference(referenceType, snapshotCount)) return false
    if (referenceChannelId == null || referenceChannelId.length === 0) return false
    if (allowedChannelId == null || allowedChannelId.length === 0) return false
    return referenceChannelId === allowedChannelId
}
