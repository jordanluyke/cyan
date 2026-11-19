import {
    Attachment,
    DiscordAPIError,
    Guild,
    GuildMember,
    Message,
    MessageMentionOptions,
    MessageReplyOptions,
    RESTJSONErrorCodes,
    SendableChannels,
} from 'discord.js'

const SUPPORTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png'])
/** Attachments larger than this are ignored. Draw downloads must use the same cap. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const TYPING_REFRESH_MS = 8000

export class DiscordUtil {
    /**
     * A normal channel message parses users, roles, and @everyone when this is omitted.
     * Model text is user-influenced, so replies must not ping.
     */
    public static suppressedMentions(): MessageMentionOptions {
        return { parse: [], repliedUser: false }
    }

    /** Reply to a message; no-ops if the original was deleted. */
    public static async tryReply(
        message: Message,
        options: MessageReplyOptions
    ): Promise<Message | null> {
        try {
            return await message.reply({
                ...options,
                allowedMentions: this.suppressedMentions(),
            })
        } catch (err) {
            if (err instanceof DiscordAPIError && err.code === RESTJSONErrorCodes.UnknownMessage) {
                return null
            }
            throw err
        }
    }

    /** Keeps the typing indicator alive until the returned stop fn is called. */
    public static startTyping(channel: SendableChannels): () => void {
        let stopped = false
        const send = () => {
            if (!stopped) void channel.sendTyping().catch(() => {})
        }
        send()
        const interval = setInterval(send, TYPING_REFRESH_MS)
        return () => {
            stopped = true
            clearInterval(interval)
        }
    }

    /** Resolves a full GuildMember even when the interaction only has a partial member payload. */
    public static async resolveGuildMember(
        guild: Guild,
        member: GuildMember | object | null,
        userId: string
    ): Promise<GuildMember> {
        if (member instanceof GuildMember) return member
        return guild.members.fetch(userId)
    }

    public static splitMessage(text: string, maxLength = 2000): string[] {
        if (text.length <= maxLength) return [text]
        const chunks: string[] = []
        let remaining = text
        while (remaining.length > 0) {
            if (remaining.length <= maxLength) {
                chunks.push(remaining)
                break
            }
            let splitAt = remaining.lastIndexOf('\n', maxLength)
            if (splitAt <= 0) splitAt = maxLength
            chunks.push(remaining.slice(0, splitAt))
            remaining = remaining.slice(splitAt).trimStart()
        }
        return chunks
    }

    public static getMessageText(message: Message): string {
        const content = message.content.trim()
        if (content.length > 0) return content

        const embedText = message.embeds
            .map((embed) => [embed.title, embed.description].filter(Boolean).join('\n'))
            .filter((text) => text.length > 0)
            .join('\n\n')
        if (embedText.length > 0) return embedText

        const attachments = message.attachments
            .filter((attachment) => !this.isSupportedImage(attachment.contentType, attachment.name))
            .map((attachment) => attachment.url)
            .join('\n')
        if (attachments.length > 0) return `[Attachments]\n${attachments}`

        return ''
    }

    public static getMessageImages(message: Message): string[] {
        const urls: string[] = []
        for (const attachment of message.attachments.values()) {
            if (!this.isSupportedImage(attachment.contentType, attachment.name)) continue
            if (attachment.size > MAX_IMAGE_BYTES) continue
            // Attachment URLs are Discord CDN links. Skip anything else so Draw
            // cannot be pointed at an arbitrary host.
            if (!this.isDiscordHostedMediaUrl(attachment.url)) continue
            urls.push(attachment.url)
        }
        for (const embed of message.embeds) {
            const hosted = this.discordHostedEmbedImage(embed.image)
            if (hosted != null) urls.push(hosted)
        }
        return urls
    }

    /**
     * True for HTTPS URLs on Discord's attachment and image-proxy hosts.
     *
     * Draw downloads the bytes in-process. Embed `image.url` is the page's
     * original file and can 302 to a private address; only Discord-hosted
     * URLs are safe to fetch.
     */
    public static isDiscordHostedMediaUrl(url: string): boolean {
        let parsed: URL
        try {
            parsed = new URL(url)
        } catch {
            return false
        }
        if (parsed.protocol !== 'https:') return false
        if (parsed.username !== '' || parsed.password !== '') return false
        // An explicit port is not Discord's CDN. `cdn.discordapp.com.evil.com` fails the suffix check.
        if (parsed.port !== '') return false
        const host = parsed.hostname.toLowerCase().replace(/\.$/, '')
        return host.endsWith('.discordapp.com') || host.endsWith('.discordapp.net')
    }

    /**
     * Where a 3xx from a Discord media URL is allowed to go.
     * Returns null when `status` is not a redirect.
     * Throws when the hop must not be followed.
     */
    public static discordMediaRedirectTarget(
        fromUrl: string,
        status: number,
        location: string | null,
    ): string | null {
        if (status < 300 || status >= 400) return null
        if (location == null || location.trim().length === 0) {
            throw new Error('discord media redirect missing location')
        }
        let next: string
        try {
            next = new URL(location, fromUrl).href
        } catch {
            throw new Error('discord media redirect invalid location')
        }
        if (!this.isDiscordHostedMediaUrl(next)) {
            throw new Error('discord media redirect left Discord')
        }
        return next
    }

    /**
     * Embed images to show or edit. Prefer Discord's proxy copy so the bot
     * never requests the origin host. An unproxied external image is dropped.
     */
    private static discordHostedEmbedImage(
        image: { url?: string | null; proxyURL?: string | null } | null | undefined,
    ): string | null {
        if (image == null) return null
        const originalSupported = image.url != null && this.isSupportedImageUrl(image.url)
        if (
            image.proxyURL != null &&
            this.isDiscordHostedMediaUrl(image.proxyURL) &&
            (this.isSupportedImageUrl(image.proxyURL) || originalSupported)
        ) {
            return image.proxyURL
        }
        if (
            image.url != null &&
            this.isDiscordHostedMediaUrl(image.url) &&
            this.isSupportedImageUrl(image.url)
        ) {
            return image.url
        }
        return null
    }

    public static isSupportedImageAttachment(attachment: Attachment): boolean {
        if (attachment.size > MAX_IMAGE_BYTES) return false
        return this.isSupportedImage(attachment.contentType, attachment.name)
    }

    public static hasMessageContent(message: Message): boolean {
        return this.getMessageText(message).length > 0 || this.getMessageImages(message).length > 0
    }

    public static async getMemberDisplayName(
        guild: Guild | null,
        targetMessage: Message,
    ): Promise<string> {
        if (targetMessage.member != null) return targetMessage.member.displayName
        if (guild != null) {
            try {
                const member = await guild.members.fetch(targetMessage.author.id)
                return member.displayName
            } catch {}
        }
        return targetMessage.author.displayName ?? targetMessage.author.username
    }

    private static isSupportedImage(contentType: string | null, name?: string): boolean {
        if (contentType != null && SUPPORTED_IMAGE_TYPES.has(contentType)) return true
        if (name != null) {
            const ext = name.split('.').pop()?.toLowerCase()
            return ext === 'jpg' || ext === 'jpeg' || ext === 'png'
        }
        return false
    }

    private static isSupportedImageUrl(url: string): boolean {
        try {
            const pathname = new URL(url).pathname.toLowerCase()
            return (
                pathname.endsWith('.jpg') || pathname.endsWith('.jpeg') || pathname.endsWith('.png')
            )
        } catch {
            return false
        }
    }
}
