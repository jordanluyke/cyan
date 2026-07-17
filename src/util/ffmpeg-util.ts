import ffmpeg from 'fluent-ffmpeg'
import { fileURLToPath } from 'node:url'
import { Readable } from 'stream'

ffmpeg.setFfmpegPath(fileURLToPath(import.meta.resolve('ffmpeg-static/ffmpeg')))

/** PCM sample rate for the pitch filter graph (Hz), not an encoder bitrate. */
const PITCH_SAMPLE_RATE_HZ = 44100
/** Target MP3 bitrate after pitch shift (kbps). */
const PITCH_OUTPUT_BITRATE_KBPS = 128

export class FfmpegUtil {
    /**
     * Pitch-shift audio in memory. Outputs MP3 @ 128kbps so a long track does
     * not expand to ~10MB/min of WAV PCM.
     */
    public static async shift(inBuffer: Buffer, scale: number): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            const chunks: Buffer[] = []
            console.log('Shifting pitch...')
            ffmpeg()
                .input(Readable.from(inBuffer))
                .audioCodec('libmp3lame')
                .audioBitrate(PITCH_OUTPUT_BITRATE_KBPS)
                .filterGraph(
                    `asetrate=${PITCH_SAMPLE_RATE_HZ}*${scale},aresample=${PITCH_SAMPLE_RATE_HZ},atempo=1/${scale}`
                )
                .format('mp3')
                .on('error', (err) => {
                    reject(err)
                })
                .pipe()
                .on('data', (chunk) => {
                    chunks.push(chunk)
                })
                .on('end', () => {
                    resolve(Buffer.concat(chunks))
                })
        })
    }
}
