import {
    ApplicationCommandType,
    ContextMenuCommandBuilder,
    SlashCommandBuilder,
} from 'discord.js'
import { SlashCommand } from './model/slash-command.js'
import {
    ClearAudioQueue,
    GetAudioQueue,
    GetAudioSource,
    GetNowPlaying,
    PauseAudio,
    PlayAudio,
    ReplaceAudioQueueItem,
    SkipAudio,
    StopAudio,
} from './routes/audio-routes.js'
import { Commands } from './routes/misc-routes.js'
import { DownloadMessages } from './routes/channel-routes.js'
import { Draw, Grok } from './routes/grok-routes.js'

export class ApiV1 {
    constructor(
        public commands: SlashCommand[] = [
            new SlashCommand(
                new SlashCommandBuilder().setName('cyan').setDescription('List bot commands'),
                Commands
            ),
            new SlashCommand(
                new SlashCommandBuilder()
                    .setName('clear')
                    .setDescription('Clear the audio queue'),
                ClearAudioQueue
            ),
            new SlashCommand(
                new SlashCommandBuilder()
                    .setName('download_messages')
                    .setDescription('Export this channel’s message history as JSON'),
                DownloadMessages
            ),
            new SlashCommand(
                new SlashCommandBuilder()
                    .setName('now')
                    .setDescription('Show what’s currently playing'),
                GetNowPlaying
            ),
            new SlashCommand(
                new SlashCommandBuilder().setName('pause').setDescription('Pause playback'),
                PauseAudio
            ),
            new SlashCommand(
                new SlashCommandBuilder()
                    .setName('play')
                    .setDescription('Play or queue YouTube audio')
                    .addStringOption((option) =>
                        option
                            .setName('query')
                            .setDescription('YouTube search, video URL, or playlist URL')
                            .setRequired(true)
                    )
                    .addNumberOption((option) =>
                        option
                            .setName('pitch')
                            .setDescription('Pitch scale (e.g. 1.5)')
                            .setRequired(false)
                    ),
                PlayAudio
            ),
            new SlashCommand(
                new SlashCommandBuilder().setName('queue').setDescription('Show the audio queue'),
                GetAudioQueue
            ),
            new SlashCommand(
                new SlashCommandBuilder()
                    .setName('replace')
                    .setDescription('Replace the currently playing track')
                    .addStringOption((option) =>
                        option
                            .setName('query')
                            .setDescription('YouTube search, video URL, or playlist URL')
                            .setRequired(true)
                    )
                    .addNumberOption((option) =>
                        option
                            .setName('pitch')
                            .setDescription('Pitch scale (e.g. 1.5)')
                            .setRequired(false)
                    ),
                ReplaceAudioQueueItem
            ),
            new SlashCommand(
                new SlashCommandBuilder().setName('skip').setDescription('Skip the current track'),
                SkipAudio
            ),
            new SlashCommand(
                new SlashCommandBuilder()
                    .setName('source')
                    .setDescription('Link to the currently playing video'),
                GetAudioSource
            ),
            new SlashCommand(
                new SlashCommandBuilder()
                    .setName('stop')
                    .setDescription('Stop playback and leave voice'),
                StopAudio
            ),
            new SlashCommand(
                new SlashCommandBuilder()
                    .setName('ask')
                    .setDescription('Ask Cyan')
                    .addStringOption((option) =>
                        option.setName('prompt').setDescription('What to ask').setRequired(false)
                    )
                    .addAttachmentOption((option) =>
                        option
                            .setName('image')
                            .setDescription('Optional image to look at')
                            .setRequired(false)
                    ),
                Grok
            ),
            new SlashCommand(
                new SlashCommandBuilder()
                    .setName('draw')
                    .setDescription('Ask Cyan to draw something')
                    .addStringOption((option) =>
                        option
                            .setName('prompt')
                            .setDescription('What to draw')
                            .setRequired(true)
                    )
                    .addStringOption((option) =>
                        option
                            .setName('aspect')
                            .setDescription('Aspect ratio')
                            .setRequired(false)
                            .addChoices(
                                { name: '1:1', value: '1:1' },
                                { name: '16:9', value: '16:9' },
                                { name: '9:16', value: '9:16' },
                                { name: '4:3', value: '4:3' },
                                { name: '3:4', value: '3:4' }
                            )
                    ),
                Draw
            ),
            new SlashCommand(
                new ContextMenuCommandBuilder()
                    .setName('Ask Cyan')
                    .setType(ApplicationCommandType.Message),
                Grok
            ),
        ]
    ) {}
}
