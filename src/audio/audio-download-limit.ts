import { MP3_BITRATE_KBPS } from '../util/ffmpeg-util.js'

/**
 * Used when the interaction does not say how large an attachment may be.
 * 8MB stays under Discord's historical 10MB default with room for multipart framing.
 */
export const MAX_AUDIO_DOWNLOAD_BYTES = 8 * 1024 * 1024

const ATTACHMENT_FRAMING_MARGIN_BYTES = 64 * 1024

/** ID3/Xing header room so a CBR estimate does not land just over the cap. */
const MP3_CONTAINER_MARGIN_BYTES = 16 * 1024

/**
 * yt-dlp bestaudio can be a higher bitrate than the 128kbps mp3 we upload.
 * Allow that source to buffer, then re-encode down. Still far below a video file.
 */
const RAW_AUDIO_CAP_MULTIPLIER = 3

const MAX_AUDIO_FILENAME_BASE = 80

/** Thrown when a download is killed because the raw audio passed the byte cap. */
export class AudioDownloadTooLargeError extends Error {
    constructor() {
        super('audio download exceeded size limit')
    }
}

/** Byte budget for the uploaded mp3. Prefers the interaction's attachment limit. */
export function resolveAudioUploadByteLimit(
    attachmentSizeLimit: number | null | undefined,
): number {
    if (
        attachmentSizeLimit == null ||
        !Number.isFinite(attachmentSizeLimit) ||
        attachmentSizeLimit <= 0
    ) {
        return MAX_AUDIO_DOWNLOAD_BYTES
    }
    if (attachmentSizeLimit <= ATTACHMENT_FRAMING_MARGIN_BYTES) return attachmentSizeLimit
    return attachmentSizeLimit - ATTACHMENT_FRAMING_MARGIN_BYTES
}

/** Expected size of a CBR mp3 at {@link MP3_BITRATE_KBPS}. */
export function estimatedMp3Bytes(durationSeconds: number): number {
    const payload = durationSeconds * MP3_BITRATE_KBPS * (1000 / 8)
    return Math.ceil(payload) + MP3_CONTAINER_MARGIN_BYTES
}

/** True when the encoded file would not fit, or the duration cannot be trusted. */
export function audioExceedsUploadLimit(durationSeconds: number, maxBytes: number): boolean {
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return true
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) return true
    return estimatedMp3Bytes(durationSeconds) > maxBytes
}

/** Backstop for the raw yt-dlp buffer, before ffmpeg squeezes it to 128kbps. */
export function rawAudioByteCap(maxUploadBytes: number): number {
    return maxUploadBytes * RAW_AUDIO_CAP_MULTIPLIER
}

/** Discord attachment name. Falls back when the title is empty after sanitizing. */
export function audioDownloadFilename(title: string): string {
    const cleaned = [...title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim()]
        .slice(0, MAX_AUDIO_FILENAME_BASE)
        .join('')
        .trim()
        .replace(/[. ]+$/g, '')
    const base = cleaned.length > 0 ? cleaned : 'audio'
    return `${base}.mp3`
}
