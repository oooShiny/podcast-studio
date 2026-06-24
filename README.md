# Podcast Studio

A minimal, browser-based podcast recording platform. No installs required — guests join via a link in their browser.

## What it does

- **WebRTC mesh** connects up to 4–5 participants with real-time audio/video
- **Local recording** captures each person's microphone directly in the browser (full quality, not compressed WebRTC audio)
- **Multi-track workflow** — each participant downloads their own high-quality recording, you combine them in post
- **Live audio meters** and speaking indicators
- **Camera support** (optional) so you can see each other while recording
- **Chat, soundboard, and screenshots** alongside the recording session
- **Prep Notes** (`/prep`) — a separate prep workspace for building episodes ahead of recording: upload source files (video, audio, images, PDFs) or bookmark URLs, scrub video and drop in timestamps/screenshots, OCR text from images, and write up two collaborative docs per episode (Shared Notes and My Notes)

## Installation

### Prerequisites

- [Node.js](https://nodejs.org/) 18 or later
- npm (bundled with Node.js)

### Steps

```bash
# Clone the repository
git clone https://github.com/oooShiny/podcast-studio.git
cd podcast-studio

# Install dependencies
npm install

# Copy the example environment file
cp .env.example .env
```

Edit `.env` and fill in your own values:

| Variable | Required | Purpose |
|---|---|---|
| `PORT` | No — defaults to `3000` | Port the server listens on |
| `HOST_PASSWORD` | Recommended | Password for the **host** role (recording controls, `/settings`, plugin management) |
| `MEMBER_PASSWORD` | Recommended | Password for the **member** role (co-host/regular participant) |
| `GUEST_PASSWORD` | Recommended | Password for the **guest** role (invited participants) |
| `WEBHOOK_SECRET` | No | Secret for the GitHub auto-deploy webhook (`POST /webhook`); leave unset to disable |
| `GOOGLE_VISION_API_KEY` | No | Enables OCR in Prep Notes, via the bundled `google-vision-ocr` plugin |

> If a role password is left unset, that role falls back to an insecure default (`host123` / `member123` / `guest`, see `lib/auth.js`). Always set your own before running anywhere beyond `localhost`.

## Getting Started

```bash
npm start
```

Open `http://localhost:3000` in your browser and log in with one of the passwords from your `.env`.

- **Host** — full control: recording, `/settings` (branding/theme, plugin management), everything members and guests can do.
- **Member / Guest** — join recording sessions. Share `http://<your-server>:3000` with them (or your local IP, e.g. `http://192.168.1.x:3000`, for same-network testing) so they can log in with their own role password.

Typical flow:

1. Everyone opens the link and joins the same room, connecting over WebRTC (grant camera/mic permissions when prompted).
2. Each participant clicks record — audio is captured locally in their own browser (see [How Recording Works](#how-recording-works) below).
3. After the session, each participant downloads their own recording; the host collects and syncs them in post.
4. Optional: use `/prep` ahead of time to build out an episode — upload sources, scrub video for timestamps, write shared notes.
5. Optional: use `/settings` (host only) to customize the UI theme/branding and enable or disable [plugins](#plugins).

To test with multiple participants on the same machine, just open additional browser tabs.

## How Recording Works

Each participant records their own microphone audio locally in the browser using the MediaRecorder API. This means:

1. **Full quality** — audio is captured before any WebRTC compression
2. **No server upload needed** — recordings stay on each person's machine
3. **Independent tracks** — each person downloads their own `.webm` file

After recording, you (the host) collect everyone's audio files and sync them in your DAW or editor (Audacity, Reaper, Descript, etc.).

## Deployment Options

### Option A: VPS (Recommended for simplicity)

1. Get a small VPS ($5/month — DigitalOcean, Hetzner, Linode, etc.)
2. Install Node.js 18+
3. Clone this project and run `npm install`
4. Set up a reverse proxy (Nginx/Caddy) with HTTPS (required for WebRTC)
5. Run with `node server.js` or use PM2 for process management

Example Caddy config:
```
podcast.yourdomain.com {
    reverse_proxy localhost:3000
}
```

### Option B: Fly.io (Free tier available)

```bash
fly launch
fly deploy
```

### Option C: Railway / Render

Push to a Git repo and connect it — both platforms auto-detect Node.js.

## HTTPS Requirement

WebRTC requires HTTPS in production (except on localhost). Any deployment method above handles this — just make sure you're not trying to run plain HTTP on a public server.

## Architecture

```
┌─────────────────┐     WebSocket      ┌──────────────┐
│  Participant A   │◄──── signaling ───►│   Server     │
│  (Browser)       │                    │  (Node.js)   │
│                  │     WebSocket      │              │
│  ┌────────────┐  │◄──── signaling ───►│  - Rooms     │
│  │ MediaRec.  │  │                    │  - Relay     │
│  │ (local)    │  │     WebRTC p2p     │              │
│  └────────────┘  │◄═══════════════════►  No media    │
│                  │     audio/video    │  touches     │
└─────────────────┘                    │  the server  │
        ▲                              └──────────────┘
        │ WebRTC p2p
        ▼
┌─────────────────┐
│  Participant B   │
│  (Browser)       │
│  ┌────────────┐  │
│  │ MediaRec.  │  │
│  │ (local)    │  │
│  └────────────┘  │
└─────────────────┘
```

The server only handles signaling (helping peers find each other). All audio/video flows directly between participants — the server never sees or processes any media.

## Plugins

Podcast Studio has a small plugin system: drop a folder into `plugins/`, restart the server, and it's picked up automatically — no edits to `server.js` or the frontend needed. Two examples ship in the repo:

- `plugins/hello-world` — the minimal scaffold, good starting point for a copy/paste
- `plugins/google-vision-ocr` — a real plugin: adds `POST /api/ocr` (used by Prep Notes' OCR feature), backed by `GOOGLE_VISION_API_KEY`

### Managing plugins

- **Hard gate, boot-time:** set `PLUGINS_ENABLED` in `.env` to a comma-separated list of plugin names to load only those (omit it to load every plugin found under `plugins/`).
- **Soft toggle, live:** as host, go to `/settings` → Plugins, and flip any plugin on/off. No restart needed — its routes and sidebar tab stop matching immediately. This is persisted in `plugins-settings.json`.

### Creating a plugin

1. Create a folder under `plugins/`, e.g. `plugins/my-plugin/`.

2. Add `manifest.json`:

   ```json
   {
     "name": "my-plugin",
     "version": "1.0.0"
   }
   ```

3. Add `index.js`, exporting any combination of:

   ```js
   module.exports = {
     // HTTP routes, checked in order against every incoming request
     routes: [
       { method: "GET", match: (url) => url === "/api/plugins/my-plugin", handler: handleMyRoute },
     ],

     // WebSocket message handlers, keyed by msg.type
     wsHandlers: {
       "my-message-type": (ws, msg, state) => { /* ... */ },
     },

     // Called once at server boot with a context scoped to this plugin
     init(ctx) {
       // ctx.rootDir          — project root
       // ctx.dirs             — core data directories (recordings, prep-notes, etc.)
       // ctx.rooms            — live room/participant state
       // ctx.broadcast(...)   — send a message to everyone in a room
       // ctx.pluginDir(name)  — creates/returns plugins-data/<name>, your own storage namespace
     },

     // Called when a WebSocket connection closes
     onClose(ws, state) {},
   };
   ```

4. Optional — add a sidebar tab in the studio UI via `plugins/my-plugin/public/tab.js`. It's auto-injected on page load whenever the plugin is enabled:

   ```js
   window.PodcastStudioPlugins.registerSidebarTab({
     id: "my-plugin",
     label: "My Plugin",
     panelHTML: `<div class="panel-section">Hello from my plugin!</div>`,
     onMount(panel) {
       // panel is the mounted DOM node for panelHTML — wire up fetch calls, listeners, etc.
     },
   });
   ```

   Any other static file under `plugins/my-plugin/public/` is served at `/plugins/my-plugin/<filename>`.

5. Restart the server. Your plugin now shows up in `GET /api/plugins` and in the host's `/settings` → Plugins list.

Plugins write to their own isolated directory (`plugins-data/<name>/`, via `ctx.pluginDir(name)`) rather than the core `recordings/`, `prep-notes/`, etc. directories.

## Limitations (Prototype)

- **No automatic upload** — participants manually download recordings
- **No auto-sync** — tracks need to be aligned in post-production
- **Mesh networking** — works well for 2–5 people, would need an SFU for larger groups
- **No reconnection** — if a participant's connection drops, they need to rejoin
- **WebM format** — some DAWs prefer WAV/MP3 (easy to convert with ffmpeg)

## Future Improvements

- [ ] Server-side upload with auto-sync markers (beep tone at start)
- [ ] WAV recording option for higher quality
- [ ] Automatic track alignment
- [ ] Session history and file management
- [ ] Video recording (separate high-quality track per participant)
- [ ] Progressive upload (chunked, crash-resistant)
- [ ] Inline playback/timestamping for uploaded audio sources in Prep Notes

## Converting WebM to WAV

```bash
# Single file
ffmpeg -i recording.webm -ar 44100 recording.wav

# Batch convert all files in a directory
for f in *.webm; do ffmpeg -i "$f" -ar 44100 "${f%.webm}.wav"; done
```
