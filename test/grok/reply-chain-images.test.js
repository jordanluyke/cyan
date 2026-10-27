import { replyChainImages } from '../../target/grok/reply-chain-images.js'
import { MAX_PROMPT_IMAGES } from '../../target/util/grok-util.js'

describe('reply chain images', () => {
    test('keeps the latest pic when later replies are text only', () => {
        const picked = replyChainImages([
            { imageUrls: ['https://cdn.example/older.png'], label: 'Alex, 5m ago' },
            { imageUrls: ['https://cdn.example/gen.png'], label: 'Cyan, 3m ago' },
            { imageUrls: [], label: 'Jordan, 2m ago' },
            { imageUrls: [], label: 'Sam, 1m ago' },
        ])

        expect(picked.imageUrls).toEqual([
            'https://cdn.example/gen.png',
            'https://cdn.example/older.png',
        ])
        expect(picked.earlierImageNote).toContain('Cyan, 3m ago')
        expect(picked.earlierImageNote).toContain('Image 0')
        expect(picked.earlierImageNote).toContain('Edit image 0')
    })

    test('skips the earlier-pic note when the newest message has the pic', () => {
        const picked = replyChainImages([
            { imageUrls: [], label: 'Alex, 5m ago' },
            { imageUrls: ['https://cdn.example/gen.png'], label: 'Cyan, 1m ago' },
        ])

        expect(picked.imageUrls).toEqual(['https://cdn.example/gen.png'])
        expect(picked.earlierImageNote).toBeNull()
    })

    test('appends pics from the current message after the chain', () => {
        const picked = replyChainImages(
            [
                { imageUrls: ['https://cdn.example/gen.png'], label: 'Cyan, 3m ago' },
                { imageUrls: [], label: 'Jordan, 1m ago' },
            ],
            ['https://cdn.example/gen.png', 'https://cdn.example/extra.png']
        )

        expect(picked.imageUrls).toEqual([
            'https://cdn.example/gen.png',
            'https://cdn.example/extra.png',
        ])
        expect(picked.earlierImageNote).toContain('Cyan, 3m ago')
    })

    test('keeps the latest chain pic and drops pics past the cap', () => {
        const chain = Array.from({ length: MAX_PROMPT_IMAGES + 2 }, (_, i) => ({
            imageUrls: [`https://cdn.example/${i}.png`],
            label: `p${i}`,
        }))
        const extras = Array.from(
            { length: MAX_PROMPT_IMAGES },
            (_, i) => `https://cdn.example/e${i}.png`
        )

        const picked = replyChainImages(chain, extras)

        expect(picked.imageUrls).toHaveLength(MAX_PROMPT_IMAGES)
        expect(picked.imageUrls[0]).toBe(`https://cdn.example/${chain.length - 1}.png`)
        expect(picked.imageUrls).toContain('https://cdn.example/e0.png')
        expect(picked.imageUrls).not.toContain('https://cdn.example/0.png')
    })

    test('keeps an earlier chain pic when the current message has several pics', () => {
        const extras = Array.from(
            { length: MAX_PROMPT_IMAGES },
            (_, i) => `https://cdn.example/e${i}.png`
        )
        const picked = replyChainImages(
            [
                { imageUrls: ['https://cdn.example/gen.png'], label: 'Cyan, 3m ago' },
                { imageUrls: [], label: 'Jordan, 1m ago' },
            ],
            extras
        )

        expect(picked.imageUrls[0]).toBe('https://cdn.example/gen.png')
        expect(picked.imageUrls).toHaveLength(MAX_PROMPT_IMAGES)
        expect(picked.earlierImageNote).toContain('Image 0')
        expect(picked.earlierImageNote).toContain('Cyan, 3m ago')
    })

    test('returns nothing when the chain has no pics', () => {
        const picked = replyChainImages([
            { imageUrls: [], label: 'Jordan, 1m ago' },
            { imageUrls: [], label: 'Sam, just now' },
        ])

        expect(picked.imageUrls).toEqual([])
        expect(picked.earlierImageNote).toBeNull()
    })
})
