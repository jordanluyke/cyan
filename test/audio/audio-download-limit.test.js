import {
    MAX_AUDIO_DOWNLOAD_BYTES,
    audioDownloadFilename,
    audioExceedsUploadLimit,
    estimatedMp3Bytes,
    rawAudioByteCap,
    resolveAudioUploadByteLimit,
} from '../../target/audio/audio-download-limit.js'

describe('audio download limits', () => {
    test('estimates 128kbps mp3 size with container margin', () => {
        expect(estimatedMp3Bytes(600)).toBe(600 * 16_000 + 16 * 1024)
    })

    test('rejects audio that will not fit', () => {
        const maxBytes = 10 * 1024 * 1024 - 64 * 1024
        expect(audioExceedsUploadLimit(10 * 60, maxBytes)).toBe(false)
        expect(audioExceedsUploadLimit(12 * 60, maxBytes)).toBe(true)
        expect(audioExceedsUploadLimit(0, maxBytes)).toBe(true)
        expect(audioExceedsUploadLimit(Number.NaN, maxBytes)).toBe(true)
        expect(audioExceedsUploadLimit(60, 0)).toBe(true)
    })

    test('raw cap leaves room to re-encode a higher-bitrate source', () => {
        expect(rawAudioByteCap(1_000_000)).toBe(3_000_000)
    })

    test('upload limit follows the interaction attachment limit', () => {
        expect(resolveAudioUploadByteLimit(undefined)).toBe(MAX_AUDIO_DOWNLOAD_BYTES)
        expect(resolveAudioUploadByteLimit(null)).toBe(MAX_AUDIO_DOWNLOAD_BYTES)
        expect(resolveAudioUploadByteLimit(Number.NaN)).toBe(MAX_AUDIO_DOWNLOAD_BYTES)
        expect(resolveAudioUploadByteLimit(10 * 1024 * 1024)).toBe(10 * 1024 * 1024 - 64 * 1024)
        expect(resolveAudioUploadByteLimit(1024)).toBe(1024)
    })

    test('filename is a safe mp3 name', () => {
        expect(audioDownloadFilename('Song: "Name"')).toBe('Song Name.mp3')
        expect(audioDownloadFilename('a/b\\c')).toBe('abc.mp3')
        expect(audioDownloadFilename('   ')).toBe('audio.mp3')
        expect(audioDownloadFilename('...')).toBe('audio.mp3')
        expect(audioDownloadFilename('track.')).toBe('track.mp3')
        const long = 'あ'.repeat(200)
        expect(audioDownloadFilename(long)).toBe(`${'あ'.repeat(80)}.mp3`)
    })
})
