import { spawn } from 'node:child_process'
import youtubedl from 'youtube-dl-exec'
import { AudioDownloadTooLargeError } from '../audio/audio-download-limit.js'
import { PlayAttempt } from '../audio/model/play-attempt.js'
import { ytDlpSpawnEnv } from './yt-dlp-env.js'

/**
 * Keep only the tail of yt-dlp's stderr. A failed download used to buffer
 * stderr without a limit; the error text we surface is at the end.
 */
export const YT_DLP_STDERR_TAIL_BYTES = 16 * 1024

interface YoutubeDlModule {
    constants: { YOUTUBE_DL_PATH: string }
}

export function ytDlpBinaryPath(): string {
    return (youtubedl as unknown as YoutubeDlModule).constants.YOUTUBE_DL_PATH
}

/**
 * One selector for /play and /download_audio. Opus, then any audio-only
 * format, then a muxed file. Leave the player client to yt-dlp: pinning
 * android currently drops audio-only URLs.
 *
 * `--` keeps a video id that starts with `-` from being parsed as a flag.
 * `!is_live` is the backstop when API metadata missed a live item (playlist
 * entries lack liveBroadcastContent) — live stdout never ends.
 */
export function ytDlpArguments(videoId: string): string[] {
    return [
        '--output',
        '-',
        '--format',
        'bestaudio[acodec=opus]/bestaudio/best',
        '--format-sort',
        'abr',
        '--match-filter',
        '!is_live',
        '--quiet',
        '--no-warnings',
        '--',
        `https://www.youtube.com/watch?v=${videoId}`,
    ]
}

export function downloadYtDlpStdout(
    videoId: string,
    attempt: PlayAttempt,
    options?: { maxBytes?: number },
): Promise<Buffer> {
    return collectChildStdout(ytDlpBinaryPath(), ytDlpArguments(videoId), {
        env: ytDlpSpawnEnv(),
        maxBytes: options?.maxBytes,
        attempt,
    })
}

/**
 * Stream a child process's stdout into a Buffer.
 *
 * youtube-dl-exec's exec() is tinyspawn. tinyspawn keeps every stdout chunk
 * and, on a non-zero close (skip/stop sends SIGTERM, so the code is null),
 * stringifies that entire buffer inside the close handler. Cancelling a long
 * download therefore allocates a second copy of the audio and can OOM the
 * process the kill was meant to save. Spawn yt-dlp ourselves and only keep
 * the bytes we still need.
 */
export function collectChildStdout(
    command: string,
    args: readonly string[],
    options?: {
        env?: NodeJS.ProcessEnv
        maxBytes?: number
        attempt?: PlayAttempt | null
        stderrTailBytes?: number
    },
): Promise<Buffer> {
    const stderrTailBytes = options?.stderrTailBytes ?? YT_DLP_STDERR_TAIL_BYTES
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = []
        let stderrTail = Buffer.alloc(0)
        let totalBytes = 0
        let capped = false
        let settled = false

        const fail = (err: Error) => {
            if (settled) return
            settled = true
            // Drop the audio immediately. The close handler used to keep it
            // alive long enough to stringify a second copy.
            chunks.length = 0
            reject(err)
        }
        const succeed = (buffer: Buffer) => {
            if (settled) return
            settled = true
            resolve(buffer)
        }

        const child = spawn(command, args, {
            windowsHide: true,
            ...(options?.env != null ? { env: options.env } : {}),
        })
        options?.attempt?.attachDownload(child)

        const stopReading = () => capped || settled || options?.attempt?.cancelled === true

        child.stdout?.on('error', (err: Error) => fail(err))
        // stderr can error when we kill the process. With no listener that
        // becomes an uncaught exception and takes down every guild.
        child.stderr?.on('error', () => {})
        child.stdout?.on('data', (chunk: Buffer) => {
            if (stopReading()) return
            const maxBytes = options?.maxBytes
            if (maxBytes != null && totalBytes + chunk.length > maxBytes) {
                // Reject first. kill() can emit a stream error on the same
                // turn, and that must not replace the size error.
                capped = true
                fail(new AudioDownloadTooLargeError())
                try {
                    child.kill('SIGTERM')
                } catch {
                    // Process may already have exited.
                }
                options?.attempt?.cancel()
                return
            }
            totalBytes += chunk.length
            chunks.push(chunk)
        })
        child.stderr?.on('data', (chunk: Buffer) => {
            stderrTail = appendTail(stderrTail, chunk, stderrTailBytes)
        })
        child.on('error', (err) => {
            options?.attempt?.clearDownload()
            fail(err)
        })
        child.on('close', (code, signal) => {
            options?.attempt?.clearDownload()
            if (capped || settled) return
            if (code === 0) {
                succeed(Buffer.concat(chunks))
                return
            }
            // SIGTERM from PlayAttempt.cancel() — cancellation, not a bad file.
            if (signal === 'SIGTERM' || child.killed) {
                fail(new Error('yt-dlp download cancelled'))
                return
            }
            const stderr = stderrTail.toString('utf8').trim()
            const detail = stderr || '(no stderr)'
            fail(new Error(`yt-dlp exited with code ${code}: ${detail}`))
        })
    })
}

function appendTail(existing: Uint8Array, chunk: Uint8Array, max: number): Buffer<ArrayBuffer> {
    if (max <= 0) return Buffer.alloc(0)
    const combined = Buffer.concat([existing, chunk])
    if (combined.length <= max) return combined
    // Copy. A subarray would keep the whole oversized chunk alive.
    return Buffer.from(combined.subarray(combined.length - max))
}
