import { spawnSync } from 'node:child_process'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FfmpegUtil } from '../../target/util/ffmpeg-util.js'
import { PlayAttempt } from '../../target/audio/model/play-attempt.js'

const ffmpegPath = fileURLToPath(import.meta.resolve('ffmpeg-static/ffmpeg'))

/** ~10.6 MB/min for stereo s16le @ 44.1kHz — WAV PCM footprint. */
function wavStereoBytesForSeconds(seconds) {
    return Math.floor(seconds * 44100 * 2 * 2)
}

function generateOpusFixture(dir, seconds, name = 'in.ogg') {
    const inputPath = join(dir, name)
    const gen = spawnSync(
        ffmpegPath,
        [
            '-y',
            '-f',
            'lavfi',
            '-i',
            `sine=frequency=440:duration=${seconds}`,
            '-ac',
            '2',
            '-c:a',
            'libopus',
            '-b:a',
            '128k',
            inputPath,
        ],
        { encoding: 'utf8' }
    )
    expect(gen.status).toBe(0)
    return readFileSync(inputPath)
}

describe('FfmpegUtil.shift', () => {
    let dir

    beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), 'cyan-pitch-'))
    })

    afterAll(() => {
        rmSync(dir, { recursive: true, force: true })
    })

    test('pitch shift keeps compressed MP3 size (does not expand to WAV PCM)', () => {
        const seconds = 30
        const input = generateOpusFixture(dir, seconds)
        const scale = 444 / 440

        return FfmpegUtil.shift(input, scale).then((output) => {
            expect(output.length).toBeGreaterThan(1000)
            // Compressed mp3 must stay far below WAV PCM (~10MB/min stereo).
            expect(output.length).toBeLessThan(wavStereoBytesForSeconds(seconds) / 3)
            // Roughly same order as the compressed input, not a PCM blow-up.
            expect(output.length).toBeLessThan(input.length * 3)
        })
    }, 60000)

    test('cancel during pitch shift rejects and does not hang', async () => {
        // Long enough that shift is still running when we cancel.
        const input = generateOpusFixture(dir, 20, 'cancel-in.ogg')
        const scale = 444 / 440
        const attempt = new PlayAttempt()

        const shiftPromise = FfmpegUtil.shift(input, scale, attempt)
        // Yield so ffmpeg has started and attachFfmpeg has run.
        await new Promise((resolve) => setTimeout(resolve, 50))
        attempt.cancel()

        await expect(shiftPromise).rejects.toThrow()
    }, 60000)
})
