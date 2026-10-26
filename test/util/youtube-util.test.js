import { YoutubeUtil } from '../../target/util/youtube-util.js'

function resolvePlayTarget(input) {
    if (!YoutubeUtil.isYoutubeUrl(input)) return 'invalid'
    const videoId = YoutubeUtil.parseVideoId(input)
    if (videoId != null) return 'video'
    if (YoutubeUtil.parsePlaylistId(input) != null) return 'playlist'
    return 'invalid'
}

const cases = [
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ', null, 'video'],
    [
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ',
        'dQw4w9WgXcQ',
        'RDdQw4w9WgXcQ',
        'video',
    ],
    [
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLtest123',
        'dQw4w9WgXcQ',
        'PLtest123',
        'video',
    ],
    ['https://www.youtube.com/playlist?list=PLtest123', null, 'PLtest123', 'playlist'],
    ['https://www.youtube.com/shorts/dQw4w9WgXcQ', 'dQw4w9WgXcQ', null, 'video'],
    ['https://www.youtube.com/embed/dQw4w9WgXcQ', 'dQw4w9WgXcQ', null, 'video'],
    ['https://www.youtube.com/live/dQw4w9WgXcQ', 'dQw4w9WgXcQ', null, 'video'],
    ['https://youtu.be/dQw4w9WgXcQ', 'dQw4w9WgXcQ', null, 'video'],
    ['https://youtu.be/dQw4w9WgXcQ?list=PLtest123', 'dQw4w9WgXcQ', 'PLtest123', 'video'],
    ['https://music.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ', null, 'video'],
]

describe('YoutubeUtil', () => {
    test.each(cases)('%s', (url, videoId, playlistId, target) => {
        expect(YoutubeUtil.parseVideoId(url)).toBe(videoId)
        expect(YoutubeUtil.parsePlaylistId(url)).toBe(playlistId)
        expect(resolvePlayTarget(url)).toBe(target)
    })

    test('parseIsoDurationSeconds reads YouTube contentDetails.duration', () => {
        expect(YoutubeUtil.parseIsoDurationSeconds('PT1H2M3S')).toBe(3723)
        expect(YoutubeUtil.parseIsoDurationSeconds('PT15M')).toBe(900)
        expect(YoutubeUtil.parseIsoDurationSeconds('PT45S')).toBe(45)
        expect(YoutubeUtil.parseIsoDurationSeconds('PT1H')).toBe(3600)
        expect(YoutubeUtil.parseIsoDurationSeconds('PT1M30.2S')).toBe(91)
        expect(YoutubeUtil.parseIsoDurationSeconds('PT0S')).toBe(0)
        expect(YoutubeUtil.parseIsoDurationSeconds('P1DT1H')).toBe(90_000)
        expect(YoutubeUtil.parseIsoDurationSeconds('P1DT2H3M4.2S')).toBe(93_785)
        expect(YoutubeUtil.parseIsoDurationSeconds('PT')).toBe(null)
        expect(YoutubeUtil.parseIsoDurationSeconds('P1W')).toBe(null)
        expect(YoutubeUtil.parseIsoDurationSeconds(null)).toBe(null)
        expect(YoutubeUtil.parseIsoDurationSeconds('')).toBe(null)
        expect(YoutubeUtil.parseIsoDurationSeconds('nope')).toBe(null)
    })

    test('isLiveOrUpcomingBroadcast rejects live and upcoming only', () => {
        expect(YoutubeUtil.isLiveOrUpcomingBroadcast('live')).toBe(true)
        expect(YoutubeUtil.isLiveOrUpcomingBroadcast('upcoming')).toBe(true)
        expect(YoutubeUtil.isLiveOrUpcomingBroadcast('none')).toBe(false)
        expect(YoutubeUtil.isLiveOrUpcomingBroadcast(undefined)).toBe(false)
        expect(YoutubeUtil.isLiveOrUpcomingBroadcast(null)).toBe(false)
        expect(YoutubeUtil.isLiveOrUpcomingBroadcast('')).toBe(false)
    })

    test('search prefers first non-live result', () => {
        const items = [
            { id: { videoId: 'live1' }, snippet: { liveBroadcastContent: 'live', title: 'Live' } },
            {
                id: { videoId: 'vod1' },
                snippet: { liveBroadcastContent: 'none', title: 'VOD' },
            },
            {
                id: { videoId: 'live2' },
                snippet: { liveBroadcastContent: 'upcoming', title: 'Soon' },
            },
        ]
        const item = items.find(
            (candidate) =>
                !YoutubeUtil.isLiveOrUpcomingBroadcast(candidate.snippet?.liveBroadcastContent)
        )
        expect(item?.id.videoId).toBe('vod1')
    })
})
