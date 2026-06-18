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

## Quick Start (Local Development)

```bash
# Install dependencies
npm install

# Start the server
npm start
```

Then open `http://localhost:3000` in your browser.

To test with multiple participants on the same machine, open additional browser tabs.
To test across machines on the same network, use your local IP (e.g., `http://192.168.1.x:3000`).

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
