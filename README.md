# cyan

## Setup

```bash
npm install
cp .env.example .env
```

Fill in `.env`

### Raspberry Pi (Ubuntu)

If `@discordjs/opus` fails to build:

```bash
sudo apt update
sudo apt install -y build-essential python3 make g++ pkg-config libopus-dev
```

```bash
rm -rf node_modules/@discordjs/opus
export CFLAGS="-Wno-error=implicit-function-declaration"
npm install @discordjs/opus --build-from-source
```

## Run

```bash
npm run build
npm start
```

## Test

```bash
npm test
```
