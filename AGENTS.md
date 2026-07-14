# AGENTS.md

Guidance for AI agents and contributors working on this repo.

## Project overview

`cyan` is a Discord bot (Node.js / TypeScript) themed around Cyan Hijirikawa. It is a **single long-running process** with:

- **No HTTP server, no database, no Docker, no listening ports**
- Outbound connections only: Discord gateway, YouTube, xAI (Grok), and media download
- In-memory per-guild state (audio / voice); state is lost on restart

Main capabilities: YouTube voice playback and queueing, AI chat (mentions / replies / context menu), image generation, and channel message export. See slash commands and `/cyan` for the live command list.

## Commands

Prefer `package.json` scripts over ad-hoc invocations:

| Script | What it does |
|--------|----------------|
| `npm install` | Install deps (allowlisted postinstalls fetch bundled binaries) |
| `npm run build` | Wipe `target/`, compile `src/` → ESM in `target/` |
| `npm start` | Run the compiled bot (`target/main.js`; build first) |
| `npm test` | Build, then run Jest |

There is **no lint script** — type-checking is the build. Format with Prettier (`.prettierrc.json`).

## Environment

Copy `.env.example` → `.env` (gitignored). Required and optional keys are documented there; without a valid `BOT_TOKEN`, login fails. YouTube and xAI keys are needed for music search and AI features respectively.

## Architecture

```
src/
  main.ts       # bootstrap
  config.ts     # env
  api/          # Discord command registry & routing (not an HTTP API)
  audio/        # playback / queue / media pipeline
  bot-state/    # in-memory per-guild state
  channel/      # channel helpers
  grok/         # xAI chat & image orchestration
  util/         # shared helpers
```

Conventions that matter when editing:

- **ESM**: local imports use `.js` extensions even though sources are `.ts`.
- **DI**: `tsyringe`; handlers are container-resolved.
- **Commands**: register in `api/`, implement `SlashCommandHandler` under `api/routes/`.
- **User-facing errors**: throw `BotError` with optional `sendMessage` for Discord replies.
- **Tests**: under `test/`, import compiled code from `target/`. Always rebuild (or use `npm test`) after changing `src/`, or tests run stale output.

## Bundled binaries

ffmpeg and yt-dlp come from npm postinstalls (`allowScripts` in `package.json`). No system install of those tools is required; yt-dlp needs network at install and Python at runtime.

## End-to-end testing

Automated tests exercise units against compiled output. Full bot behavior needs live infra: a valid bot token, a guild with the bot invited, and a voice channel for audio.
