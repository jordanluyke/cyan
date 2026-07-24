export class YoutubeUtil {
    public static isYoutubeUrl(input: string): boolean {
        try {
            const host = new URL(input).hostname.replace(/^www\./, '')
            return host === 'youtu.be' || host.endsWith('youtube.com')
        } catch {
            return false
        }
    }

    public static parseVideoId(input: string): string | null {
        try {
            const url = new URL(input)
            const host = url.hostname.replace(/^www\./, '')
            if (host === 'youtu.be') {
                const videoId = url.pathname.slice(1).split('/')[0]
                return videoId || null
            }
            if (host.endsWith('youtube.com')) {
                const pathId = url.pathname.match(/^\/(?:shorts|embed|live)\/([^/?#]+)/)
                if (pathId?.[1]) return pathId[1]
                return url.searchParams.get('v')
            }
        } catch {
            return null
        }
        return null
    }

    public static parsePlaylistId(input: string): string | null {
        try {
            return new URL(input).searchParams.get('list')
        } catch {
            return null
        }
    }

    /**
     * True when YouTube snippet.liveBroadcastContent is live or upcoming.
     * Playing those via yt-dlp stdout buffers indefinitely (live) or fails
     * (upcoming) — live downloads can OOM the single bot process.
     */
    public static isLiveOrUpcomingBroadcast(
        liveBroadcastContent: string | null | undefined
    ): boolean {
        return liveBroadcastContent === 'live' || liveBroadcastContent === 'upcoming'
    }
}
