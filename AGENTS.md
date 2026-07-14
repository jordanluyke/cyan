# AGENTS.md

Guidance for AI agents and contributors working on this repo.

## Project overview

`cyan` is a Discord bot (Node.js / TypeScript, `discord.js` v14) themed around Cyan Hijirikawa. It is a **single long-running process** with:

- **No HTTP server, no database, no Docker, no listening ports**
- Outbound connections only: Discord gateway, YouTube Data API, xAI (Grok), and media download
- In-memory per-guild state (audio queues / voice); state is lost on restart

Features:

- Voice music: YouTube search / URL / playlist → queue → ffmpeg → Discord voice
- AI chat: `@` mention or reply to the bot; message context menu **Ask Cyan**
- Image gen: `/draw` (and draw/edit tools inside chat when `XAI_API_KEY` is set)
- Admin: `/download_messages` (export channel history as JSON)

## Commands

Prefer `package.json` scripts over ad-hoc invocations:

| Script | What it does |
|--------|----------------|
| `npm install` | Install deps (runs allowlisted postinstalls for ffmpeg / yt-dlp) |
| `npm run build` | Wipe `target/`, compile `src/` → ESM in `target/` via `bin/build.js` + `tsc` |
| `npm start` | Run `node target/main.js` (build first) |
| `npm test` | Build, then Jest on `test/**/*.test.js` |

There is **no lint script**. Type-checking is the build. Prettier config is in `.prettierrc.json`
(no semis, width 100, 4-space tabs, single quotes).

## Environment

Copy `.env.example` → `.env` (gitignored):

| Variable | Required | Purpose |
|----------|----------|---------|
| `BOT_TOKEN` | Yes | Discord login; invalid/missing → `DiscordjsError [TokenInvalid]` |
| `YOUTUBE_API_KEY` | For `/play` search & metadata | YouTube Data API |
| `XAI_API_KEY` | Optional | Mentions, **Ask Cyan**, `/draw` |

## Architecture

```
src/
  main.ts              # tsyringe bootstrap → ApiManager.init()
  config.ts            # dotenv + env vars
  api/                 # Discord command registry & routing (not an HTTP API)
    api-v1.ts          # Slash / context-menu command list
    api-manager.ts     # Client, login, interaction + mention handlers
    routes/            # SlashCommandHandler implementations
  audio/               # Playback, queue, yt-dlp/ffmpeg pipeline
  bot-state/           # In-memory Map<guildId, BotState>
  channel/             # Channel export helpers
  grok/                # xAI chat / image orchestration + persona prompt
  util/                # Discord, YouTube, ffmpeg, HTTP, Grok helpers
```

Conventions that matter when editing:

- **ESM**: `"type": "module"`, `module`/`moduleResolution` `nodenext`. Local imports use
  `.js` extensions (e.g. `from './config.js'`) even though sources are `.ts`.
- **DI**: `tsyringe` (`@singleton` / `@injectable`); `reflect-metadata` imported in `main.ts`.
  Handlers are resolved from the container in `ApiManager`.
- **Commands**: register in `api/api-v1.ts`; implement `SlashCommandHandler` in `api/routes/`.
- **User-facing errors**: throw `BotError` with optional `sendMessage` for Discord replies.
- **Tests**: live under `test/` as plain `.js`, import from `target/`. Always rebuild (or use
  `npm test`) after changing `src/` or tests will run stale code.

## Bundled binaries

Postinstall scripts allowlisted in `package.json` `allowScripts`:

- `ffmpeg-static` → ffmpeg
- `youtube-dl-exec` → yt-dlp (needs network at install; Python at runtime)

No system ffmpeg/yt-dlp install is required.

## End-to-end testing

Unit tests cover pure helpers (e.g. play-guard, YouTube URL parsing). Full bot behavior needs
live infra: valid `BOT_TOKEN`, a guild with the bot invited, and a voice channel for audio.
