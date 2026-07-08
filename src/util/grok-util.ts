import { GrokPrompt } from '../grok/model/grok-prompt.js'

interface ChatCompletionResponse {
    choices: { message: { content: string } }[]
}

type ChatContent =
    | string
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string; detail: string } }

export class GrokUtil {
    public static async chat(apiKey: string, prompt: GrokPrompt): Promise<string> {
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
                model: 'grok-4.3',
                messages: [
                    { role: 'system', content: 'You are Grok, a helpful AI assistant.' },
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
