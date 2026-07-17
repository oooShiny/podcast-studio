# Video Recording — Scope & Implementation Plan

## Context

The studio already acquires video via `getUserMedia` and transmits it over WebRTC to participants. However, the recording engine (`actuallyStartRecording()` in `public/index.html`) wires `MediaRecorder` to AudioContext destination nodes — audio-only streams. Adding video means routing the existing video track into a composite MediaStream and updating downstream handling.

Phases are independently shippable.

---

## Three Key Questions

### What does video recording actually capture?
The proposed approach captures the **raw webcam feed** from `getUserMedia` — not the studio interface or the participant grid layout. Each participant's recording would be their own camera view only, identical to what is already being sent over WebRTC to other participants. This is the correct approach for podcast post-production (raw per-person footage, edit/compose later).

To capture the studio grid UI (tiles, labels, layout) you'd need `getDisplayMedia()` (screen capture) — a fundamentally different approach that requires a user permission prompt and captures whatever is on screen.

### Can video recording be optional, controlled by settings.html?
Yes. The `studio-settings.json` system already has a `PUT /api/studio-settings` API and the settings UI already uses checkboxes. Adding a `recordVideo: false` boolean to studio settings, a checkbox on the settings page, and a guard in `actuallyStartRecording()` is straightforward — same pattern as existing permission toggles.

### Storage considerations
Video is ~20–50× larger than audio:

| | Per track | 60-min 3-person session |
|---|---|---|
| Audio only (128 kbps) | ~1 MB/min | ~18 MB |
| Video 640×480 (~500 kbps) | ~3.75 MB/min | ~675 MB |

**Current gaps to address before shipping video recording:**
- No disk-space check before accepting chunks — server could fill up silently
- No per-session or per-user quota
- No cleanup/archiving mechanism (manual delete only via `/api/sessions/:id`)
- Docker `recordings/` volume mount becomes critical (currently may be lost on container rebuild)
- Should add a disk-space warning in the editor or admin area when sessions are large

---

## What's Already Free

- Video capture via `getUserMedia` (640×480, device-selectable) — exists
- WebRTC video transmission to all peers — exists
- Live device switching (`replaceTrack`) — exists
- Per-participant video tile UI — exists
- Server chunk upload, finalize, and concatenation — works unchanged for video `.webm`

---

## Settings Integration (~30 lines across 2 files)

**Files: `public/settings.html`, `lib/studio-settings.js`**  
**Complexity: Easy**

Add `recordVideo: false` to the default settings object in `studio-settings.js` and a checkbox row in the "Permissions" section of `settings.html`:

```html
<label class="checkbox-row">
  <input type="checkbox" id="record-video"> Record video tracks (uses ~20× more disk space)
</label>
```

Wire it into the existing `handlePutStudioSettings` + `GET /api/studio-settings` flow. The studio client already receives settings updates via WebSocket and can gate the video track on `studioSettings.recordVideo`.

---

## Phase 1 — Capture video to disk (~50 lines, one file)

**File: `public/index.html`, `actuallyStartRecording()` ~line 2758**  
**Complexity: Easy**

The audio processing chain (`state.recordingDest`) already handles sync tones + soundboard mixing correctly. Graft the local video track onto it:

```js
const videoTracks = state.localStream.getVideoTracks().filter(t => t.readyState === 'live')
const recordStream = videoTracks.length > 0
  ? new MediaStream([...state.recordingDest.stream.getAudioTracks(), ...videoTracks])
  : state.recordingDest.stream   // audio-only fallback
```

Then select a video-aware MIME type (`video/webm;codecs=vp8,opus` → `video/webm;codecs=vp9,opus` → `video/webm` → `audio/webm;codecs=opus`), save to `state.recordingMimeType`, and reference it in `finalizeUpload()` instead of the current hardcoded string.

**Mix recorder stays audio-only** — real-time canvas compositing of multiple video streams is unreliable for professional use. Individual tracks give producers everything needed.

**Settings guard:** Check `state.studioSettings.recordVideo !== true` and skip video if disabled.

After Phase 1: video files download and play in any browser/VLC.

---

## Phase 2 — Server-side fixes (~20 lines)

**File: `lib/recording.js`**  
**Complexity: Easy–Medium**

1. `handleDownload()`: change Content-Type from `audio/webm` → `video/webm` (valid for both).
2. `handleFinalize()`: store `hasVideo: mimeType.includes('video')` in the participant entry written to `session.json`.
3. *(Optional)* After concatenating chunks, run `ffmpeg -y -i in.webm -c copy out_remuxed.webm` to add a proper seek index. Without it, files are valid but seeking in a video player is sluggish. Skip gracefully if FFmpeg is unavailable.

---

## Phase 3 — Editor support

**Files: `lib/editor.js`, `public/editor.html`**  
**Complexity: Medium–Hard**

### 3a. Session API (Easy)
`handleGetSession()` already reads `session.json`. With the `hasVideo` flag stored in Phase 2, surface it in the tracks array. Add `.mp4` to the exports file filter.

### 3b. Video export — MVP (Medium)
Add `buildFfmpegVideoArgs()` that produces: first video track + amix of all audio tracks → MP4 (`-c:v libx264 -c:a aac`). `handleExport()` branches on an `outputFormat` request parameter.

### 3c. Video export — grid compositing (Hard, post-MVP)
Full N-up layout using FFmpeg `xstack` with per-track scaling and black-frame placeholders for audio-only participants. Multiple input permutations to handle.

### 3d. Editor UI (Easy)
- Export format toggle: "Audio (MP3)" / "Video (MP4)"
- `[VIDEO]` badge on video-capable tracks
- Filename extension hint updates to match format
- WaveSurfer.js waveforms: expected to work unchanged — Web Audio API decodes audio from video WebM containers

---

## Complexity Summary

| Area | Effort | Notes |
|---|---|---|
| Settings toggle | Easy | New `recordVideo` boolean |
| Composite stream + MIME type selection | Easy | Phase 1 |
| Dynamic mimeType in `finalizeUpload` | Easy | Phase 1 |
| Server Content-Type + `hasVideo` flag | Easy | Phase 2 |
| Optional FFmpeg seek-index remux | Medium | Phase 2, requires FFmpeg |
| Editor session API `hasVideo` | Easy | Phase 3a |
| Video export MVP (first track + mixed audio) | Medium | Phase 3b |
| Video export with xstack grid | Hard | Phase 3c, post-MVP |
| Editor UI additions | Easy | Phase 3d |
| Disk space safeguards | Medium | No quota/warning exists today |
| Mix recording with video | Very Hard / Not recommended | Canvas compositing, unreliable A/V sync |

---

## Critical Files

| File | Phase | What changes |
|---|---|---|
| `public/settings.html` | Settings | Add `record-video` checkbox |
| `lib/studio-settings.js` | Settings | Add `recordVideo: false` default |
| `public/index.html` | 1 | `actuallyStartRecording()`, MIME selection, `finalizeUpload()`, settings guard |
| `lib/recording.js` | 2 | `handleDownload()`, `handleFinalize()` |
| `lib/editor.js` | 3 | `handleGetSession()`, `handleExport()`, new `buildFfmpegVideoArgs()` |
| `public/editor.html` | 3 | Format toggle, track badges, filename hint |

## Verification (per phase)

- **Phase 1**: Start a session, record, stop, download the `.webm` — verify it opens in VLC/Chrome with both video and audio tracks present
- **Phase 2**: Check Content-Type header on `/api/download/...`; verify `session.json` has `hasVideo: true` in participant entries
- **Phase 3**: Open the editor for a video session, export as MP4, verify the file plays with correct video and synced audio
