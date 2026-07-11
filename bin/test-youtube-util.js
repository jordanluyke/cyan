import { YoutubeUtil } from '../target/util/youtube-util.js'

function assertEqual(actual, expected, label) {
    if (actual !== expected) {
        throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    }
}

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

for (const [url, videoId, playlistId, target] of cases) {
    assertEqual(YoutubeUtil.parseVideoId(url), videoId, `parseVideoId ${url}`)
    assertEqual(YoutubeUtil.parsePlaylistId(url), playlistId, `parsePlaylistId ${url}`)
    assertEqual(resolvePlayTarget(url), target, `resolvePlayTarget ${url}`)
}

console.log(`ok: ${cases.length} youtube url cases`)
