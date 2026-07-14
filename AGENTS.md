# AGENTS.md

## Cursor Cloud specific instructions

`cyan-bot` is a single Node.js/TypeScript Discord bot process (`discord.js` v14). There is
**no HTTP server, no database, no docker, and no listening ports** — it makes only outbound
connections (Discord gateway, YouTube, xAI). Standard commands live in `package.json`
(`npm run build`, `npm start`, `npm test`); prefer those instead of ad-hoc invocations.

Non-obvious notes for future agents (deps are already installed by the startup update script):

- **Running the bot requires a real Discord bot token.** Copy `.env.example` to `.env` and set
  `BOT_TOKEN`. Without a valid token, `npm start` reaches Discord login and exits with
  `DiscordjsError [TokenInvalid]`. `YOUTUBE_API_KEY` is required for music/`/play`; `XAI_API_KEY`
  is optional (enables AI chat, `/draw`, `Ask Cyan`). `.env` is gitignored.
- **There is no lint script.** Type-checking is done by the build: `npm run build` runs
  `bin/build.js`, which wipes `target/` and runs `npx tsc` (output ESM in `target/`).
- **Tests run against compiled output, not `src`.** Jest matches `test/**/*.test.js` and imports
  from `target/`. Always build before running Jest — `npm test` already does `npm run build`
  first. After editing `src`, rebuild or your test changes won't be picked up.
- **Bundled binaries** come from npm postinstall scripts allowlisted in `package.json`
  (`allowScripts`): `ffmpeg-static` provides ffmpeg and `youtube-dl-exec` fetches the `yt-dlp`
  binary at install time (needs network + Python at runtime). No system-level ffmpeg/yt-dlp
  install is required.
- **Full end-to-end testing needs live infrastructure** that cannot be emulated locally: a valid
  `BOT_TOKEN`, a Discord server (guild) with the bot invited, and a voice channel for audio.
