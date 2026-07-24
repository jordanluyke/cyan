/**
 * One download→play attempt. Identity (`===`) detects cancellation;
 * `playing` is set when a resource is committed to the audio player so Idle
 * can ignore stop/replace races during a newer download.
 */
export class PlayAttempt {
    isPlaying = false
    private _cancelled = false
    private download: { kill: (signal?: NodeJS.Signals | number) => boolean } | null = null
    private ffmpeg: { kill: (signal?: string) => void } | null = null

    get cancelled(): boolean {
        return this._cancelled
    }

    markPlaying(): void {
        this.isPlaying = true
    }

    /** Track the live yt-dlp process so skip/stop/replace/clear can abort it. */
    attachDownload(download: { kill: (signal?: NodeJS.Signals | number) => boolean }): void {
        this.download = download
        if (this._cancelled) {
            try {
                download.kill('SIGTERM')
            } catch {
                // Process may already have exited.
            }
        }
    }

    /** Drop the download handle after the process exits (success or failure). */
    clearDownload(): void {
        this.download = null
    }

    /**
     * Track the live pitch-shift ffmpeg job. Without this, skip/clear during
     * FfmpegUtil.shift leaves the encode running and holding full-track buffers
     * while the next download starts — long mixes can OOM the process.
     *
     * fluent-ffmpeg's kill() is a no-op until the process has spawned, so
     * FfmpegUtil also checks `cancelled` on the `start` event.
     */
    attachFfmpeg(command: { kill: (signal?: string) => void }): void {
        this.ffmpeg = command
        if (this._cancelled) {
            try {
                command.kill('SIGTERM')
            } catch {
                // Encode may not have spawned yet.
            }
        }
    }

    /** Drop the ffmpeg handle after encode finishes or fails. */
    clearFfmpeg(): void {
        this.ffmpeg = null
    }

    /**
     * Abort in-flight download and pitch-shift work. Without this, skip/stop/
     * replace/clear only invalidates the attempt token while yt-dlp/ffmpeg keep
     * buffering a superseded track into memory — repeated cancels on long videos
     * can OOM the process.
     */
    cancel(): void {
        this._cancelled = true
        const download = this.download
        const ffmpeg = this.ffmpeg
        this.download = null
        this.ffmpeg = null
        try {
            download?.kill('SIGTERM')
        } catch {
            // Process may already have exited.
        }
        try {
            ffmpeg?.kill('SIGTERM')
        } catch {
            // Encode may already have finished or not spawned yet.
        }
    }
}
