import { spawnSync } from 'node:child_process'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FfmpegUtil } from '../../target/util/ffmpeg-util.js'

const ffmpegPath = fileURLToPath(import.meta.resolve('ffmpeg-static/ffmpeg'))

/** ~10.6 MB/min for stereo s16le @ 44.1kHz — the old WAV output footprint. */
function wavStereoBytesForSeconds(seconds) {
    return Math.floor(seconds * 44100 * 2 * 2)
}

describe('FfmpegUtil.shift', () => {
    let dir

    beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), 'cyan-pitch-'))
    })

    afterAll(() => {
        rmSync(dir, { recursive: true, force: true })
    })

    test('pitch shift keeps compressed size (does not expand to WAV PCM)', () => {
        const seconds = 30
        const inputPath = join(dir, 'in.ogg')
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

        const input = readFileSync(inputPath)
        // Default C528-ish scale from audio-manager
        const scale = 444 / 440

        return FfmpegUtil.shift(input, scale).then((output) => {
            expect(output.length).toBeGreaterThan(1000)
            // Old path buffered full WAV (~10MB/min stereo). Compressed opus must stay far below.
            expect(output.length).toBeLessThan(wavStereoBytesForSeconds(seconds) / 3)
            // Sanity: roughly same order as the opus input, not a PCM blow-up.
            expect(output.length).toBeLessThan(input.length * 3)
        })
    }, 60000)
})
