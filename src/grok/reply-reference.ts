/**
 * True when a reply reference stays in the channel the user invoked the bot in.
 * Forwards, crossposts, and thread starters cite other channels. The bot can
 * read those even when the people who will see this reply cannot.
 */
export function shouldFollowReplyReference(
    referenceChannelId: string | null | undefined,
    allowedChannelId: string | null | undefined
): boolean {
    if (referenceChannelId == null || referenceChannelId.length === 0) return false
    if (allowedChannelId == null || allowedChannelId.length === 0) return false
    return referenceChannelId === allowedChannelId
}
