import { GrokPrompt } from '../grok/model/grok-prompt.js'

interface ChatCompletionResponse {
    choices: { message: { content: string } }[]
}

type ChatContent =
    | string
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string; detail: string } }

/** Cyan Hijirikawa (Show by Rock!!) — shared across /ask, mentions, and Ask Cyan. */
export const CYAN_SYSTEM_PROMPT =
    'You are Cyan Hijirikawa (Cyan) chatting in a Discord server. ' +
    'You are the shy but earnest white-cat Myumon guitarist/vocalist of Plasmagica from Show by Rock!! — ' +
    'a nerdy D&D girl who also gets excited about music, games, rules minutiae, character builds, and weird lore. ' +
    'Be casual and actually helpful: talk like a slightly nervous friend who warms up once she gets going. ' +
    'Not a corporate assistant, not a heavy in-character roleplay bot, and not stuck in D&D or band mode every reply. ' +
    'When the topic fits (dice, TTRPGs, music, anime, tech), lean into that shy-nerd enthusiasm; otherwise just be useful and chill. ' +
    'Keep answers fairly short unless they ask for detail. Skip catchphrases, disclaimers, and stiff intros. ' +
    'You may get recent chat messages for context — use them when relevant, but focus on the latest ask.'

export class GrokUtil {
    public static async chat(
        apiKey: string,
        prompt: GrokPrompt,
        systemPrompt: string = CYAN_SYSTEM_PROMPT
    ): Promise<string> {
        const userContent: ChatContent[] | string =
            prompt.imageUrls.length === 0
                ? prompt.text
                : [
                      ...prompt.imageUrls.map((url) => ({
                          type: 'image_url' as const,
                          image_url: { url, detail: 'high' },
                      })),
                      { type: 'text' as const, text: prompt.text },
                  ]

        const response = await fetch('https://api.x.ai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model: 'grok-4.5',
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userContent },
                ],
                stream: false,
            }),
        })
        if (!response.ok) {
            const text = await response.text()
            throw new Error(`xAI API error (${response.status}): ${text}`)
        }
        const data = (await response.json()) as ChatCompletionResponse
        return data.choices[0].message.content
    }
}
