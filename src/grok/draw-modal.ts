import { LabelBuilder, ModalBuilder, TextInputBuilder } from '@discordjs/builders'
import { TextInputStyle } from 'discord.js'

export const DRAW_MODAL_PREFIX = 'draw:'

export function drawModalCustomId(channelId: string, messageId: string): string {
    return `${DRAW_MODAL_PREFIX}${channelId}:${messageId}`
}

export function isDrawModalCustomId(customId: string): boolean {
    return customId.startsWith(DRAW_MODAL_PREFIX)
}

/** Channel and message the Draw modal was opened from. Null when the id is not ours. */
export function parseDrawModalCustomId(
    customId: string
): { channelId: string; messageId: string } | null {
    const match = /^draw:(\d+):(\d+)$/.exec(customId)
    if (match == null) return null
    return { channelId: match[1], messageId: match[2] }
}

/**
 * Prompt modal for a pic already in chat.
 * Builders must come from one package. Mixing discord.js with @discordjs/builders
 * drops the text field during toJSON.
 */
export function buildDrawModal(channelId: string, messageId: string): ModalBuilder {
    return new ModalBuilder()
        .setCustomId(drawModalCustomId(channelId, messageId))
        .setTitle('Draw')
        .addLabelComponents(
            new LabelBuilder().setLabel('What to draw').setTextInputComponent(
                new TextInputBuilder()
                    .setCustomId('prompt')
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(true)
                    .setMaxLength(4000)
                    .setPlaceholder('watercolor of this at night')
            )
        )
}
