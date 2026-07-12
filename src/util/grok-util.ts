import { GrokPrompt } from '../grok/model/grok-prompt.js'

interface ChatCompletionMessage {
    role: string
    content: string | ChatContent[] | null
    tool_calls?: ToolCall[]
    tool_call_id?: string
}

interface ToolCall {
    id: string
    type: string
    function: { name: string; arguments: string }
}

interface ChatCompletionResponse {
    choices: {
        message: ChatCompletionMessage
        finish_reason: string
    }[]
}

interface ImageGenerationResponse {
    data: { url?: string; b64_json?: string }[]
}

type ChatContent =
    | string
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string; detail: string } }

export interface GrokChatResult {
    text: string
    images: Buffer[]
}

/** Cyan Hijirikawa (Show by Rock!!) — shared across mentions, replies, and Ask Cyan. */
export const CYAN_SYSTEM_PROMPT =
    'You are Cyan Hijirikawa (Cyan) chatting in a Discord server. ' +
    'You are the shy but earnest white-cat Myumon guitarist/vocalist of Plasmagica from Show by Rock!! — ' +
    'a nerdy D&D girl who also gets excited about music, games, rules minutiae, character builds, and weird lore. ' +
    'Be casual and actually helpful: talk like a slightly nervous friend who warms up once she gets going. ' +
    'Not a corporate assistant, not a heavy in-character roleplay bot, and not stuck in D&D or band mode every reply. ' +
    'When the topic fits (dice, TTRPGs, music, anime, tech), lean into that shy-nerd enthusiasm; otherwise just be useful and chill. ' +
    'Keep answers fairly short unless they ask for detail. Skip catchphrases, disclaimers, and stiff intros. ' +
    'You may get recent chat messages for context — use them when relevant, but focus on the latest ask. ' +
    'You can draw and edit images with your tools. ' +
    'When someone asks you to draw/create something, call draw_image. ' +
    'Only call edit_image when they clearly want a change to an attached/referenced image ' +
    '(e.g. "too realistic", "make it anime", "add a hat"). ' +
    'If they are just reacting, praising, or commenting with no requested change ' +
    '(e.g. "very good", "lol", "nice", "love this"), reply with text only — do not redraw or edit. ' +
    'After an image tool succeeds, keep any caption short (or empty).'

export const IMAGE_MODEL = 'grok-imagine-image-quality'

const DRAW_IMAGE_TOOL = {
    type: 'function' as const,
    function: {
        name: 'draw_image',
        description:
            'Generate a new image from a text description. Use when the user asks you to draw, create, or generate an image.',
        parameters: {
            type: 'object',
            properties: {
                prompt: {
                    type: 'string',
                    description: 'Detailed description of the image to generate',
                },
            },
            required: ['prompt'],
        },
    },
}

const EDIT_IMAGE_TOOL = {
    type: 'function' as const,
    function: {
        name: 'edit_image',
        description:
            'Edit an attached/referenced image. Only use when the user explicitly asks for a change ' +
            '(style, content, lighting, etc.). Do not use for praise, reactions, or comments with no change requested ' +
            '(e.g. "very good", "nice", "lol").',
        parameters: {
            type: 'object',
            properties: {
                prompt: {
                    type: 'string',
                    description:
                        'Concrete description of the changes to apply (e.g. "restyle as anime illustration, less photorealistic")',
                },
                image_index: {
                    type: 'integer',
                    description:
                        'Which attached image to edit (0-based). Defaults to 0 — the first/most relevant image.',
                },
            },
            required: ['prompt'],
        },
    },
}

const MAX_TOOL_ROUNDS = 3

export class GrokUtil {
    public static async chat(
        apiKey: string,
        prompt: GrokPrompt,
        systemPrompt: string = CYAN_SYSTEM_PROMPT
    ): Promise<GrokChatResult> {
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

        const tools =
            prompt.imageUrls.length > 0
                ? [DRAW_IMAGE_TOOL, EDIT_IMAGE_TOOL]
                : [DRAW_IMAGE_TOOL]

        const messages: ChatCompletionMessage[] = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
        ]

        const images: Buffer[] = []

        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
            const data = await this.chatCompletion(apiKey, messages, tools)
            const message = data.choices[0]?.message
            if (message == null) {
                throw new Error('xAI API returned no message')
            }

            const toolCalls = message.tool_calls
            if (toolCalls == null || toolCalls.length === 0) {
                return {
                    text: typeof message.content === 'string' ? message.content : '',
                    images,
                }
            }

            messages.push({
                role: 'assistant',
                content: message.content,
                tool_calls: toolCalls,
            })

            for (const toolCall of toolCalls) {
                const result = await this.executeImageTool(
                    apiKey,
                    toolCall,
                    prompt.imageUrls,
                    images
                )
                messages.push({
                    role: 'tool',
                    tool_call_id: toolCall.id,
                    content: result,
                })
            }
        }

        return { text: '', images }
    }

    /** Returns raw image bytes from xAI Imagine (base64 decoded). */
    public static async generateImage(
        apiKey: string,
        prompt: string,
        aspectRatio?: string | null
    ): Promise<Buffer> {
        const body: Record<string, unknown> = {
            model: IMAGE_MODEL,
            prompt,
            n: 1,
            response_format: 'b64_json',
        }
        if (aspectRatio != null && aspectRatio.length > 0) {
            body.aspect_ratio = aspectRatio
        }

        const response = await fetch('https://api.x.ai/v1/images/generations', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(body),
        })
        if (!response.ok) {
            const text = await response.text()
            throw new Error(`xAI image API error (${response.status}): ${text}`)
        }
        return this.decodeImageResponse(await response.json())
    }

    /** Edit an existing image via xAI Imagine edits API. */
    public static async editImage(
        apiKey: string,
        prompt: string,
        imageUrl: string
    ): Promise<Buffer> {
        const response = await fetch('https://api.x.ai/v1/images/edits', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model: IMAGE_MODEL,
                prompt,
                image: { url: imageUrl, type: 'image_url' },
                n: 1,
                response_format: 'b64_json',
            }),
        })
        if (!response.ok) {
            const text = await response.text()
            throw new Error(`xAI image edit API error (${response.status}): ${text}`)
        }
        return this.decodeImageResponse(await response.json())
    }

    private static async chatCompletion(
        apiKey: string,
        messages: ChatCompletionMessage[],
        tools: typeof DRAW_IMAGE_TOOL[]
    ): Promise<ChatCompletionResponse> {
        const response = await fetch('https://api.x.ai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model: 'grok-4.5',
                messages,
                tools,
                tool_choice: 'auto',
                parallel_tool_calls: false,
                stream: false,
            }),
        })
        if (!response.ok) {
            const text = await response.text()
            throw new Error(`xAI API error (${response.status}): ${text}`)
        }
        return (await response.json()) as ChatCompletionResponse
    }

    private static async executeImageTool(
        apiKey: string,
        toolCall: ToolCall,
        imageUrls: string[],
        images: Buffer[]
    ): Promise<string> {
        let args: { prompt?: string; image_index?: number }
        try {
            args = JSON.parse(toolCall.function.arguments) as {
                prompt?: string
                image_index?: number
            }
        } catch {
            return JSON.stringify({ error: 'invalid tool arguments' })
        }

        const promptText = args.prompt?.trim() ?? ''
        if (promptText.length === 0) {
            return JSON.stringify({ error: 'prompt is required' })
        }

        try {
            if (toolCall.function.name === 'draw_image') {
                const image = await this.generateImage(apiKey, promptText)
                images.push(image)
                return JSON.stringify({
                    ok: true,
                    note: 'Image generated; it will be attached to the Discord reply.',
                })
            }

            if (toolCall.function.name === 'edit_image') {
                if (imageUrls.length === 0) {
                    return JSON.stringify({
                        error: 'no source image available to edit',
                    })
                }
                const index =
                    typeof args.image_index === 'number' &&
                    Number.isInteger(args.image_index) &&
                    args.image_index >= 0 &&
                    args.image_index < imageUrls.length
                        ? args.image_index
                        : 0
                const image = await this.editImage(apiKey, promptText, imageUrls[index])
                images.push(image)
                return JSON.stringify({
                    ok: true,
                    note: 'Edited image ready; it will be attached to the Discord reply.',
                })
            }

            return JSON.stringify({ error: `unknown tool: ${toolCall.function.name}` })
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            console.error(`image tool ${toolCall.function.name} failed:`, err)
            return JSON.stringify({ error: message })
        }
    }

    private static decodeImageResponse(data: unknown): Buffer {
        const parsed = data as ImageGenerationResponse
        const b64 = parsed.data?.[0]?.b64_json
        if (b64 == null || b64.length === 0) {
            throw new Error('xAI image API returned no image data')
        }
        return Buffer.from(b64, 'base64')
    }
}
