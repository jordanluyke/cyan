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
}
