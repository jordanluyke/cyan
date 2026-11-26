import {
    dropRepliesOutside,
    formatAskAboutPrompt,
    formatChatPrompt,
    formatTopicGap,
    speakerToken,
    toContextLines,
} from '../../target/grok/chat-context.js'

const CHAT_HEADER = 'Channel messages, oldest first. Answer the last one.'

const NOW = 1_700_000_000_000
const MINUTE = 60_000

function draft(overrides) {
    return {
        id: overrides.id,
        author: overrides.author,
        timestamp: overrides.timestamp,
        text: overrides.text,
        hasImage: overrides.hasImage ?? false,
        mentionsBot: overrides.mentionsBot ?? false,
        fromBot: overrides.fromBot ?? false,
        replyToId: overrides.replyToId ?? null,
    }
}

describe('speaker tokens', () => {
    test('people are mentions and the bot stays Cyan', () => {
        expect(speakerToken('111', false)).toBe('<@111>')
        expect(speakerToken('222', true)).toBe('Cyan')
    })
})

describe('topic gaps', () => {
    test('ignores a short pause and labels a long silence', () => {
        expect(formatTopicGap(29 * MINUTE)).toBeNull()
        expect(formatTopicGap(30 * MINUTE)).toBe('30m')
        expect(formatTopicGap(2 * 60 * MINUTE)).toBe('2h')
        expect(formatTopicGap(-1)).toBeNull()
    })
})

describe('context lines', () => {
    test('links a reply to its parent and marks a target outside the list', () => {
        const lines = toContextLines(
            [
                draft({
                    id: 'tweet',
                    author: 'News',
                    timestamp: NOW - 5 * MINUTE,
                    text: 'Sam Corcos and Legatum',
                    replyToId: 'not-in-list',
                }),
                draft({
                    id: 'joke',
                    author: 'Waeve',
                    timestamp: NOW - MINUTE,
                    text: 'destroy twitter from the inside',
                    mentionsBot: true,
                    replyToId: 'tweet',
                }),
            ],
            NOW
        )

        expect(lines[0].repliesToEarlier).toBe(true)
        expect(lines[0].replyToAuthor).toBeUndefined()
        expect(lines[1].replyToAuthor).toBe('News')
        expect(lines[1].mentionsBot).toBe(true)
        expect(lines[1].age).toBe('1m ago')
    })

    test('drops a reply target the capped chain did not include', () => {
        const lines = toContextLines(
            dropRepliesOutside([
                draft({
                    id: 'tweet',
                    author: 'News',
                    timestamp: NOW - 5 * MINUTE,
                    text: 'Sam Corcos and Legatum',
                    replyToId: 'not-in-list',
                }),
                draft({
                    id: 'cyan',
                    author: 'Cyan',
                    timestamp: NOW - MINUTE,
                    text: 'twitter destroys itself',
                    fromBot: true,
                    replyToId: 'tweet',
                }),
            ]),
            NOW
        )

        expect(lines[0].repliesToEarlier).toBe(false)
        expect(lines[1].replyToAuthor).toBe('News')
        expect(lines[1].fromBot).toBe(true)
    })

    test('inserts a gap when the channel went quiet', () => {
        const lines = toContextLines(
            [
                draft({
                    id: 'old',
                    author: 'Alice',
                    timestamp: NOW - 3 * 60 * MINUTE,
                    text: 'old topic',
                }),
                draft({
                    id: 'new',
                    author: 'Bob',
                    timestamp: NOW - MINUTE,
                    text: 'different topic',
                }),
            ],
            NOW
        )
        const prompt = formatChatPrompt(lines)

        expect(prompt).toContain('— 2h later —')
        expect(prompt.indexOf('old topic')).toBeLessThan(prompt.indexOf('— 2h later —'))
        expect(prompt.indexOf('— 2h later —')).toBeLessThan(prompt.indexOf('different topic'))
    })
})

describe('mention prompts', () => {
    test('a quiet channel is just the new message', () => {
        const [line] = toContextLines(
            [
                draft({
                    id: 'now',
                    author: 'Jordan',
                    timestamp: NOW,
                    text: 'explain your personality',
                    mentionsBot: true,
                }),
            ],
            NOW
        )

        expect(formatChatPrompt([line])).toBe('explain your personality')
    })

    test('a mention and a reply share one transcript', () => {
        const background = [
            draft({
                id: 'tweet',
                author: 'News',
                timestamp: NOW - 5 * MINUTE,
                text: 'Sam Corcos, Treasury CIO. the game is Legatum',
            }),
            draft({
                id: 'joke',
                author: 'Waeve',
                timestamp: NOW - 2 * MINUTE,
                text: 'destroy twitter from the inside',
                mentionsBot: true,
                replyToId: 'tweet',
            }),
            draft({
                id: 'cyan',
                author: 'Cyan',
                timestamp: NOW - MINUTE,
                text: 'twitter destroys itself the second you open it',
                fromBot: true,
                replyToId: 'joke',
            }),
        ]
        const mention = formatChatPrompt(
            toContextLines(
                [
                    ...background,
                    draft({
                        id: 'claiff',
                        author: 'Claiff',
                        timestamp: NOW,
                        text: 'make no mistakes',
                        mentionsBot: true,
                    }),
                ],
                NOW
            )
        )
        const reply = formatChatPrompt(
            toContextLines(
                [
                    ...background,
                    draft({
                        id: 'claiff',
                        author: 'Claiff',
                        timestamp: NOW,
                        text: 'make no mistakes',
                        mentionsBot: true,
                        replyToId: 'joke',
                    }),
                ],
                NOW
            )
        )

        expect(mention.startsWith(CHAT_HEADER)).toBe(true)
        expect(reply.startsWith(CHAT_HEADER)).toBe(true)
        expect(mention).toContain('Claiff (just now, to Cyan): make no mistakes')
        expect(reply).toContain('Claiff (just now, to Cyan, replying to Waeve): make no mistakes')
        expect(mention).toContain('Waeve (2m ago, to Cyan, replying to News): destroy twitter from the inside')
        expect(reply).toContain('Waeve (2m ago, to Cyan, replying to News): destroy twitter from the inside')
    })

    test('a pic with no caption still asks what is in it', () => {
        const [line] = toContextLines(
            [
                draft({
                    id: 'pic',
                    author: 'Jordan',
                    timestamp: NOW,
                    text: '',
                    hasImage: true,
                }),
            ],
            NOW
        )

        expect(formatChatPrompt([line])).toBe("what's in this pic?")
    })
})

describe('ask about a message', () => {
    test('the selected message is the subject and earlier lines are background', () => {
        const chain = toContextLines(
            [
                draft({
                    id: 'older',
                    author: 'Alice',
                    timestamp: NOW - 10 * MINUTE,
                    text: 'unrelated lore',
                }),
                draft({
                    id: 'picked',
                    author: 'Bob',
                    timestamp: NOW - MINUTE,
                    text: 'the actual question',
                    replyToId: 'older',
                }),
            ],
            NOW
        )
        const prompt = formatAskAboutPrompt({ chain, hasImages: false })

        expect(prompt).toContain('They asked you about the last message below.')
        expect(prompt).toContain('Bob (1m ago, replying to Alice): the actual question')
        expect(prompt.indexOf('unrelated lore')).toBeLessThan(prompt.indexOf('the actual question'))
    })
})
