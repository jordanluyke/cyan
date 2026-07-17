interface FunctionCallOutput {
    type: 'function_call'
    call_id: string
    name: string
    arguments: string
}

interface MessageOutput {
    type: 'message'
    content?: { type: string; text?: string }[]
}

type ResponseOutputItem = FunctionCallOutput | MessageOutput | { type: string }

interface ResponsesApiResult {
    id: string
    output: ResponseOutputItem[]
}

interface ImageGenerationResponse {
    data: { url?: string; b64_json?: string }[]
}

type InputContent =
    | { type: 'input_text'; text: string }
    | { type: 'input_image'; image_url: string; detail: string }

type ResponsesTool =
    | { type: 'web_search' }
    | { type: 'x_search' }
    | { type: 'code_interpreter' }
    | {
          type: 'function'
          name: string
          description: string
          parameters: Record<string, unknown>
      }

export interface GrokChatResult {
    text: string
    images: Buffer[]
}

export const IMAGE_MODEL = 'grok-imagine-image-quality'
export const CHAT_MODEL = 'grok-4.5'

const DRAW_IMAGE_TOOL: ResponsesTool = {
    type: 'function',
    name: 'draw_image',
    description:
        'Generate a new image from a text description. Only use when the user explicitly asks you to draw, create, or generate an image. ' +
        'Do not use for normal chat, explanations, or unsolicited illustrations. At most once per reply.',
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
}

const EDIT_IMAGE_TOOL: ResponsesTool = {
    type: 'function',
    name: 'edit_image',
    description:
        'Edit an attached/referenced image. Only use when the user explicitly asks for a change ' +
        '(style, content, lighting, etc.). Do not use for praise, reactions, comments, or unsolicited edits ' +
        '(e.g. "very good", "nice", "lol"). At most once per reply.',
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
}

const WEB_SEARCH_TOOL: ResponsesTool = { type: 'web_search' }
const X_SEARCH_TOOL: ResponsesTool = { type: 'x_search' }
const CODE_INTERPRETER_TOOL: ResponsesTool = { type: 'code_interpreter' }

/** Client-side image tool rounds (web/X search turns are separate via max_turns). */
const MAX_CLIENT_TOOL_ROUNDS = 3
/** Agentic search/browse turns per request — higher = deeper research. */
const MAX_SEARCH_TURNS = 10
/** Reasoning + multi-turn search can take a while. */
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000

export class GrokUtil {
    public static async chat(
        apiKey: string,
        text: string,
        imageUrls: string[] = [],
        systemPrompt?: string
    ): Promise<GrokChatResult> {
        const userContent: InputContent[] | string =
            imageUrls.length === 0
                ? text
                : [
                      ...imageUrls.map(
                          (url): InputContent => ({
                              type: 'input_image',
                              image_url: url,
                              detail: 'high',
                          })
                      ),
                      { type: 'input_text', text },
                  ]

        const tools: ResponsesTool[] = [
            WEB_SEARCH_TOOL,
            X_SEARCH_TOOL,
            CODE_INTERPRETER_TOOL,
            DRAW_IMAGE_TOOL,
            ...(imageUrls.length > 0 ? [EDIT_IMAGE_TOOL] : []),
        ]

        const images: Buffer[] = []
        let previousResponseId: string | undefined
        let input: unknown = [{ role: 'user', content: userContent }]

        for (let round = 0; round < MAX_CLIENT_TOOL_ROUNDS; round++) {
            const data = await this.createResponse(apiKey, {
                instructions: systemPrompt,
                input,
                tools,
                previousResponseId,
            })

            const functionCalls = data.output.filter(
                (item): item is FunctionCallOutput => item.type === 'function_call'
            )
            if (functionCalls.length === 0) {
                return { text: this.extractOutputText(data), images }
            }

            const toolOutputs = []
            for (const call of functionCalls) {
                const result = await this.executeImageTool(apiKey, call, imageUrls, images)
                toolOutputs.push({
                    type: 'function_call_output',
                    call_id: call.call_id,
                    output: result,
                })
            }

            previousResponseId = data.id
            input = toolOutputs
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
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
        if (!response.ok) {
            const text = await response.text()
            throw new Error(`xAI image edit API error (${response.status}): ${text}`)
        }
        return this.decodeImageResponse(await response.json())
    }

    private static async createResponse(
        apiKey: string,
        opts: {
            instructions?: string
            input: unknown
            tools: ResponsesTool[]
            previousResponseId?: string
        }
    ): Promise<ResponsesApiResult> {
        const body: Record<string, unknown> = {
            model: CHAT_MODEL,
            input: opts.input,
            tools: opts.tools,
            tool_choice: 'auto',
            parallel_tool_calls: false,
            reasoning: { effort: 'high' },
            max_turns: MAX_SEARCH_TURNS,
            stream: false,
        }
        if (opts.instructions != null && opts.previousResponseId == null) {
            body.instructions = opts.instructions
        }
        if (opts.previousResponseId != null) {
            body.previous_response_id = opts.previousResponseId
        }

        const response = await fetch('https://api.x.ai/v1/responses', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
        if (!response.ok) {
            const text = await response.text()
            throw new Error(`xAI API error (${response.status}): ${text}`)
        }
        return (await response.json()) as ResponsesApiResult
    }

    private static extractOutputText(data: ResponsesApiResult): string {
        const parts: string[] = []
        for (const item of data.output) {
            if (item.type !== 'message') continue
            const message = item as MessageOutput
            for (const part of message.content ?? []) {
                if (part.type === 'output_text' && part.text != null && part.text.length > 0) {
                    parts.push(part.text)
                }
            }
        }
        return parts.join('\n').trim()
    }

    private static async executeImageTool(
        apiKey: string,
        toolCall: FunctionCallOutput,
        imageUrls: string[],
        images: Buffer[]
    ): Promise<string> {
        let args: { prompt?: string; image_index?: number }
        try {
            args = JSON.parse(toolCall.arguments) as {
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

        if (images.length >= 1) {
            return JSON.stringify({
                error: 'already produced an image this reply; reply with text only',
            })
        }

        try {
            if (toolCall.name === 'draw_image') {
                const image = await this.generateImage(apiKey, promptText)
                images.push(image)
                return JSON.stringify({
                    ok: true,
                    note: 'Image generated; it will be attached to the Discord reply. Do not call image tools again.',
                })
            }

            if (toolCall.name === 'edit_image') {
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
                    note: 'Edited image ready; it will be attached to the Discord reply. Do not call image tools again.',
                })
            }

            return JSON.stringify({ error: `unknown tool: ${toolCall.name}` })
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            console.error(`image tool ${toolCall.name} failed:`, err)
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
