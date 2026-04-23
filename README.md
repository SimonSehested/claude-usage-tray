# Claude Usage Tray

Windows system tray app showing Claude AI token usage with a Liquid Glass popup.

## Setup

```
npm install
npm start
```

Requires Claude Code to be logged in (`claude` CLI) — reads credentials from `~/.claude/.credentials.json`.

## Build installer

```
npm run build
```

Produces a one-click `.exe` installer in `dist/`.
