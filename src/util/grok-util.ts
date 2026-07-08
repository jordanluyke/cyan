interface ChatCompletionResponse {
    choices: { message: { content: string } }[]
}

export class GrokUtil {
    public static async chat(apiKey: string, prompt: string): Promise<string> {
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
                    { role: 'user', content: prompt },
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
}
