/**
 * One download→play attempt. Identity (`===`) detects cancellation;
 * `playing` is set when a resource is committed to the audio player so Idle
 * can ignore stop/replace races during a newer download.
 */
export class PlayAttempt {
    isPlaying = false

    markPlaying(): void {
        this.isPlaying = true
    }
}
