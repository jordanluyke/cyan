import { AudioDownloadTooLargeError } from '../../target/audio/audio-download-limit.js'
import { PlayAttempt } from '../../target/audio/model/play-attempt.js'
import {
    collectChildStdout,
    ytDlpArguments,
    ytDlpBinaryPath,
} from '../../target/util/yt-dlp-download.js'

const node = process.execPath

describe('ytDlpArguments', () => {
    test('asks yt-dlp for audio on stdout and rejects live streams', () => {
        const args = ytDlpArguments('dQw4w9WgXcQ')
        expect(args).toEqual([
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
            'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        ])
    })

    test('keeps a video id that starts with a dash from being parsed as a flag', () => {
        const args = ytDlpArguments('--help')
        expect(args.at(-2)).toBe('--')
        expect(args.at(-1)).toBe('https://www.youtube.com/watch?v=--help')
    })

    test('binary path points at the bundled yt-dlp', () => {
        expect(ytDlpBinaryPath().endsWith('yt-dlp')).toBe(true)
    })
})

describe('collectChildStdout', () => {
    test('returns stdout bytes when the process exits 0', async () => {
        const buffer = await collectChildStdout(node, [
            '-e',
            'process.stdout.write(Buffer.from("abc"))',
        ])
        expect(buffer.toString()).toBe('abc')
    })

    test('kills the process and rejects when stdout exceeds the cap', async () => {
        await expect(
            collectChildStdout(
                node,
                ['-e', 'process.stdout.write(Buffer.alloc(8000)); setInterval(() => {}, 1000)'],
                { maxBytes: 100 },
            ),
        ).rejects.toBeInstanceOf(AudioDownloadTooLargeError)
    })

    test('cancel rejects and does not keep the payload on the error', async () => {
        const attempt = new PlayAttempt()
        const pending = collectChildStdout(
            node,
            [
                '-e',
                'process.stdout.write(Buffer.alloc(64 * 1024, 65)); setInterval(() => {}, 1000)',
            ],
            { attempt },
        )
        attempt.cancel()
        await expect(pending).rejects.toThrow('yt-dlp download cancelled')
    })

    test('a missing binary rejects instead of raising an unhandled error', async () => {
        await expect(collectChildStdout('/no/such/yt-dlp-binary', ['--version'])).rejects.toThrow()
    })

    test('stderr in the error is only the tail', async () => {
        const pending = collectChildStdout(
            node,
            ['-e', 'process.stderr.write("A".repeat(5000) + "END"); process.exit(1)'],
            { stderrTailBytes: 64 },
        )
        await expect(pending).rejects.toThrow(/END/)
        try {
            await pending
        } catch (err) {
            expect(err.message).toContain('END')
            expect(err.message.length).toBeLessThan(200)
            expect(err.message).not.toContain('A'.repeat(200))
        }
    })

    test('non-zero exit with no stderr still rejects', async () => {
        await expect(collectChildStdout(node, ['-e', 'process.exit(2)'])).rejects.toThrow(
            'yt-dlp exited with code 2: (no stderr)',
        )
    })
})
