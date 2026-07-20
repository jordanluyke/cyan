/**
 * One download→play attempt. Identity (`===`) detects cancellation;
 * `playing` is set when a resource is committed to the audio player so Idle
 * can ignore stop/replace races during a newer download.
 */
export class PlayAttempt {
    isPlaying = false
    private download: { kill: (signal?: NodeJS.Signals | number) => boolean } | null = null

    markPlaying(): void {
        this.isPlaying = true
    }

    /** Track the live yt-dlp process so skip/stop/replace can abort it. */
    attachDownload(download: { kill: (signal?: NodeJS.Signals | number) => boolean }): void {
        this.download = download
    }

    /** Drop the download handle after the process exits (success or failure). */
    clearDownload(): void {
        this.download = null
    }

    /**
     * Abort an in-flight download. Without this, skip/stop/replace only
     * invalidates the attempt token while yt-dlp keeps buffering the full
     * track into memory — repeated cancels on long videos can OOM the process.
     */
    cancel(): void {
        const download = this.download
        this.download = null
        try {
            download?.kill('SIGTERM')
        } catch {
            // Process may already have exited.
        }
    }
}
