import { createAudioPlayer } from '@discordjs/voice'
import { AudioQueueItem } from '../../audio/model/audio-queue-item.js'
import { PlayAttempt } from '../../audio/model/play-attempt.js'

export class BotState {
    constructor(
        public audioQueueItems: AudioQueueItem[] = [],
        public audioPlayer = createAudioPlayer(),
        public idleTimeout?: any,
        /** Live download/play attempt; cleared or replaced to cancel in-flight work. */
        public playAttempt: PlayAttempt | null = null,
        /** Pending resubscribe after the voice connection was destroyed. */
        public voiceRejoinTimeout?: ReturnType<typeof setTimeout>,
    ) {}
}
