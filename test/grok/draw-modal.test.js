import { ComponentType, TextInputStyle } from 'discord.js'
import {
    buildDrawModal,
    drawModalCustomId,
    isDrawModalCustomId,
    parseDrawModalCustomId,
} from '../../target/grok/draw-modal.js'

describe('draw modal id', () => {
    test('round-trips a channel and message id', () => {
        const customId = drawModalCustomId('123456789012345678', '987654321098765432')
        expect(customId).toBe('draw:123456789012345678:987654321098765432')
        expect(isDrawModalCustomId(customId)).toBe(true)
        expect(parseDrawModalCustomId(customId)).toEqual({
            channelId: '123456789012345678',
            messageId: '987654321098765432',
        })
    })

    test('includes a prompt field', () => {
        expect(buildDrawModal('123', '456').toJSON()).toEqual({
            custom_id: 'draw:123:456',
            title: 'Draw',
            components: [
                {
                    type: ComponentType.Label,
                    label: 'What to draw',
                    component: {
                        type: ComponentType.TextInput,
                        custom_id: 'prompt',
                        style: TextInputStyle.Paragraph,
                        required: true,
                        max_length: 4000,
                        placeholder: 'watercolor of this at night',
                    },
                },
            ],
        })
    })

    test('rejects anything that is not a draw modal id', () => {
        expect(isDrawModalCustomId('ask:1:2')).toBe(false)
        expect(parseDrawModalCustomId('draw:')).toBeNull()
        expect(parseDrawModalCustomId('draw:123')).toBeNull()
        expect(parseDrawModalCustomId('draw:abc:456')).toBeNull()
        expect(parseDrawModalCustomId('draw:123:456:789')).toBeNull()
        expect(parseDrawModalCustomId('ask:123:456')).toBeNull()
    })
})
