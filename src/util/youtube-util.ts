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
     * YouTube contentDetails.duration. Under a day this is PT#H#M#S; at least
     * a day it is P#DT#H#M#S. Returns whole seconds, rounding fractional
     * seconds up. Null when the value is missing or not that form.
     */
    public static parseIsoDurationSeconds(iso: string | null | undefined): number | null {
        if (iso == null || iso.length === 0) return null
        const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(iso)
        if (match == null) return null
        if (match[1] == null && match[2] == null && match[3] == null && match[4] == null) {
            return null
        }
        const days = Number(match[1] ?? 0)
        const hours = Number(match[2] ?? 0)
        const minutes = Number(match[3] ?? 0)
        const seconds = Number(match[4] ?? 0)
        const total = days * 86400 + hours * 3600 + minutes * 60 + seconds
        if (!Number.isFinite(total)) return null
        return Math.ceil(total)
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
