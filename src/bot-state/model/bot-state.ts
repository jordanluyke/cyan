import { createAudioPlayer } from '@discordjs/voice'
import { AudioQueueItem } from '../../audio/model/audio-queue-item.js'

export class BotState {
    constructor(
        public audioQueueItems: AudioQueueItem[] = [],
        public audioPlayer = createAudioPlayer(),
        public idleTimeout?: any,
        /** Bumped to invalidate in-flight downloads (skip/stop/replace). */
        public playEpoch: number = 0,
        /** Epoch of the resource currently playing; null when nothing is playing. */
        public activePlayEpoch: number | null = null
    ) {}
}
