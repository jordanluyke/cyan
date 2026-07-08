import { Message } from 'discord.js'

const SUPPORTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png'])
const MAX_IMAGE_BYTES = 20 * 1024 * 1024

export class DiscordUtil {
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
            urls.push(attachment.url)
        }
        for (const embed of message.embeds) {
            if (embed.image?.url != null && this.isSupportedImageUrl(embed.image.url)) {
                urls.push(embed.image.url)
            }
        }
        return urls
    }

    public static hasMessageContent(message: Message): boolean {
        return this.getMessageText(message).length > 0 || this.getMessageImages(message).length > 0
    }

    public static async getMemberDisplayName(
        contextMessage: Message,
        targetMessage: Message
    ): Promise<string> {
        if (targetMessage.member != null) return targetMessage.member.displayName
        if (contextMessage.guild != null) {
            try {
                const member = await contextMessage.guild.members.fetch(targetMessage.author.id)
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
            return pathname.endsWith('.jpg') || pathname.endsWith('.jpeg') || pathname.endsWith('.png')
        } catch {
            return false
        }
    }
}
