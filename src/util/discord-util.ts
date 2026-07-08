import { Message } from 'discord.js'

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

        const attachments = message.attachments.map((attachment) => attachment.url).join('\n')
        if (attachments.length > 0) return `[Attachments]\n${attachments}`

        return ''
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
}
