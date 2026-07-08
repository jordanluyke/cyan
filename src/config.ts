import { singleton } from 'tsyringe'
import { config } from 'dotenv'

config({ quiet: true })

@singleton()
export class Config {
    public botToken = process.env.BOT_TOKEN
    public youtubeApiKey = process.env.YOUTUBE_API_KEY
    public xaiApiKey = process.env.XAI_API_KEY
}
