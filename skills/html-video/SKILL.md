---
name: html-video
description: Make videos, animations, and MP4s by writing a self-contained HTML canvas scene, then render it with the renderVideo tool. Supports optional soundtracks from audio files or synthesized cues.
keywords:
  - video
  - mp4
  - animation
  - animate
  - canvas
  - render video
  - make a video
allowed-tools:
  - RenderVideo
  - AnalyzeAudio
  - TranscribeAudio
  - Read
  - Create
---

# HTML Video Export

Use this skill when the user asks you to **make a video**, an animation, a
"recordable" scene, or an MP4 — for example "make a video about how a black
hole works" or "animate the solar system and export it".

Your job: produce a **single, self-contained HTML document** that implements the
contract below, then render it to an MP4 with the **`renderVideo` tool**. The
tool records the scene in a hidden WebView and returns an MP4 that is delivered
to the user directly in the chat as a playable video card — the user can play,
save, or share it. No preview taps, no manual export.

Under the hood the recorder:

1. Finds the page's canvas and resizes it to the export resolution.
2. Calls `render(t, canvas, ctx, audio, speech)` once per frame at the requested
   FPS.
3. Captures the canvas with the GPU (`VideoFrame` + the hardware WebCodecs
   `VideoEncoder`) and streams the H.264 chunks to a native MP4 muxer. On
   WebViews without WebCodecs it falls back to JPEG frames re-encoded on the
   native hardware encoder.

## Contract

Define this before the body finishes loading:

```html
<script>
  window.MOBILE_AGENT_VIDEO = {
    duration: 10,      // seconds, 1–600, default 10 (over 30 s renders in 30 s segments, concatenated)
    fps: 30,           // 5–60, default 30
    width: 1280,       // export width, even number, ≤ 1920, default 1280
    height: 720,       // export height, even number, ≤ 1920, default 720
    canvasId: "scene", // optional: id of the canvas to record
    render: function (t, canvas, ctx, audio, speech) {
      // Draw the frame at time t (seconds). Must be deterministic and
      // synchronous — the recorder captures immediately after it returns.
      // audio carries precomputed soundtrack features (see Audio-reactive
      // visuals) and speech carries the transcript (see Speech sync and
      // captions). Both are always objects; check .ready first.
    },
    audio: {           // optional: omit for a silent video (see Audio below)
      master: 0.9,
      tracks: []
    },
    speech: {          // optional: transcript for captions (see Speech below)
      segments: []     // the `segments` returned by the transcribeAudio tool
    }
  };
</script>
```

The recorder picks `document.getElementById(canvasId)`, or the first visible
`<canvas>` on the page when no id is given.

### In-app playback (no debug UI in the scene)

Tapping a scene HTML file in the app opens it in a built-in player:
play/pause, a seek timeline with time labels, and a silent preview (sound
only plays after render). Never author your own preview/scrub/time-slider
or other debug chrome inside the scene — it duplicates the player and
ships scaffolding into the file. Keep the page to the canvas plus whatever
the video itself shows. Your scene only needs to honor `render(t, ...)`
being called with any `t` in `[0, duration]`; the player drives the rest.

## Delivering the MP4

When the user wants the finished file — "make a video and give me the MP4" —
call the **`renderVideo` tool** with the complete HTML document:

- `html`: the full self-contained HTML (preferred).
- `fileId`: alternatively, the id of an HTML file you already saved to the
  workspace.
- `name`: optional output name; a `.mp4` extension is added if missing.

```
renderVideo({ html: "<!doctype html>…", name: "black-hole.mp4" })
```

The tool waits for the recording to finish and returns the saved MP4
(`fileId`, `link`, `size`). It does **not** need a preview, a meta tag, or any
user interaction. Rendering is real time: a 10-second video takes ~10 seconds,
so call it once with a finished scene and do not retry needlessly.

The result also returns `sourceFileId` / `sourceLink`: the exact HTML you
rendered, saved as `<name>.source.html` in the workspace. You do not need to
keep the HTML yourself.

## Previewing a scene before rendering (storyboard first)

Rendering spends real time (a 10-second video takes ~10 seconds). After
authoring a scene — especially with user images, video clips, or tricky
layout — check it with the **`previewScene` tool** before calling
`renderVideo`. Pass the same HTML (or scene `fileId`) and the promised
`duration`: it runs the scene's `render(t, ...)` at storyboard timestamps
in a hidden host and returns the stills as workspace images (inline for
vision-capable models, file links + `ocr` fallback otherwise), so you can
fix composition, framing, and caption placement while iteration is cheap.

Rules:

- The preview is approximate: async media settles, no audio plays, file
  tracks stay silent. The render is truth — never describe motion, timing,
  or sound from the storyboard alone.
- Preview with the exact document you intend to render (same assets, same
  `duration`); the tool fails fast on a duration mismatch like render does.
- For video-heavy scenes the stills show settled frames, not motion — pair
  with `getVideoFrame` on the source clip (poster workflow) beforehand.
- Loop: preview → fix → re-preview → render → `getVideoFrame` spot-check.

## Revising a video (read the source, don't regenerate blind)

When the user asks for changes to a video you already rendered:

1. `Read` the render's `sourceFileId` (the `.source.html` file) — this is the
   exact scene, and editing it preserves everything the user didn't complain
   about.
2. Apply targeted edits to that HTML (timings, colors, copy, motion), keeping
   `duration` and the contract shape intact.
3. Re-render with `renderVideo`, passing the same `duration` you promised.
4. Never claim a change is applied without re-rendering — the MP4 is baked.

## Looking at a timestamp ("at 0:12 the logo clips")

You cannot scrub the video yourself. Use the `getVideoFrame` tool with the
video `fileId` and `time` in seconds: it saves a still frame to the workspace
and, on vision-capable models, shows it to you inline so you can describe
what's actually on screen. On models without image input you only get the
file link — use the `ocr` tool to read on-screen text, or ask the user what
they see. After inspecting, revise via the source-HTML workflow above.

To assess a whole video at once, call `getVideoFrame` several times **in one
block** at spread timestamps (e.g. start, middle, end — 2 to 4 frames, not
more): each call returns its own frame and they all arrive together, so you
can compare moments in a single step. Every frame is also saved to the
workspace, so later turns can reference individual frames by fileId without
re-fetching. Keep it to a few frames — each one costs vision context.

After the tool returns, embed the video **inline** in your response exactly
where you talk about it, the same way you would embed an image:

```
![black-hole.mp4](workspace://<fileId from the tool result>)
```

Use the returned `fileId`. The embed renders as a playable in-chat video with
its first frame as the poster — tap to play, save, or share. Do not paste a
bare `workspace://` link and do not describe the video as attached at the end;
place the embed where it belongs in your message.

When the user instead wants to **iterate on a preview**, just return the HTML in
a fenced ```html code block so it renders in the preview dialog. Do not call the
tool until the scene is ready.

## Audio (optional)

Omit `audio` for a silent video. To add sound, attach a schedule:

```html
<script>
  window.MOBILE_AGENT_VIDEO = {
    duration: 12, fps: 30, width: 1280, height: 720,
    render: function (t) { /* ... */ },
    audio: {
      master: 0.9,               // overall gain 0–1, default 1
      tracks: [
        { file: "workspace://<audio-file-id>", start: 0, loop: true, volume: 0.5, fadeOut: 2 },
        { synth: { kind: "pad", notes: ["C3", "G3", "Bb3"], attack: 2 }, start: 0, duration: 12, volume: 0.3 },
        { synth: { kind: "tone", notes: [60, 64, 67, 72], noteDur: 0.5, wave: "triangle" }, start: 4, duration: 4, volume: 0.4 },
        { synth: { kind: "noise", filterFreq: 400, filterEnd: 6000 }, start: 10, duration: 2, volume: 0.5 }
      ]
    }
  };
</script>
```

Track fields (both kinds): `start` (seconds into the video, default 0),
`duration` (default: runs to the end of the video), `volume` 0–1 (default
0.8), `fadeIn`/`fadeOut` in seconds (default 0). File tracks also take `offset`
(seconds into the source file, default 0) and `loop` (default false).

File tracks:

- Must reference an audio file **already in the workspace**: MP3, WAV, M4A,
  AAC, OGG, or WebM, max 15 MB. Ask the user to attach it, or use one they
  already gave you — never invent a `workspace://` id.
- In folder-scoped chats the reference media may live in the external folder,
  which audio tools cannot read: import it first with
  `importFolderFileToWorkspace`, then use the returned workspace fileId for
  `analyzeAudio`, `transcribeAudio`, and `file:` tracks.
- The tool inlines the file automatically. A missing, unreadable, or
  oversized file fails the render with a clear error before recording starts.

Voiceover / narration (never tell the user voiceover is impossible):

- Preferred: the **`textToSpeech` tool**. It speaks the script with the
  device's on-device voices — fully offline — and saves numbered WAV parts
  with back-to-back `start` offsets. Pass the narration language as a BCP-47
  code (`en`, `es`, `de`, `hi`, `ta`, …; omit for the device default).
  Schedule every returned part as a `file:` track at its `start` so the full
  narration plays in order. Use the `listVoices` tool first to see installed
  voices and locales when the user wants a specific language.
- If `textToSpeech` fails with a missing-voice error, either install the
  voice in the system text-to-speech settings or re-run in an installed
  language — or fall back to the network endpoint below.
- Fallback (no local voice / non-Android): fetch the narration yourself with
  the `downloadFile` tool (target `workspace`) from the Google Translate TTS
  endpoint:
  `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=<lang>&q=<url-encoded-text>`.
  `tl` is the narration language as an ISO-639-1 code (`en` English, `es`
  Spanish, `de` German, `fr` French, `hi` Hindi, `ta` Tamil, … — use the
  narration language, not always English). Each language gets its own fixed
  voice; there is no voice choice.
- Endpoint limits: keep each request under ~200 characters of text; split
  longer scripts into multiple sequential requests at sentence boundaries,
  save each part (e.g. `narration-1.mp3`, `narration-2.mp3`), and schedule
  them back-to-back with matching `start` times. Keep every part in the same
  `tl` language or the voice changes mid-narration. The endpoint is
  unofficial and needs network — if a fetch fails, retry once, then ask the
  user for an audio file instead of claiming the voiceover is done.
- Either way, prefer `transcribeAudio` on the narration audio to get word
  timings, then drive captions from the `speech` contract — but the audio
  itself is the voiceover track.

Images and video clips in scenes (user-provided visuals):

- Reference workspace files directly in the scene DOM: images inline
  automatically (JPEG/PNG/WebP/GIF, max 15 MB each — same cap as audio),
  while clips (MP4/WebM/MOV) load from the device over loopback HTTP —
  no size inflation, seeking works, any length plays: files up to 200 MB
  serve at full quality with no warning. Absurd files compress on-device
  and MOV auto-converts to MP4 the same way (audio dropped
  since clips play muted) with a warning naming the new size — tell the
  user when it happens instead of hiding it. Never invent a
  `workspace://` id: use a file the user attached or one already in the
  workspace.
- Images: hide an `<img src="workspace://<id>">` and paint it with
  `drawImage` in `render`. Guard every draw — `if (img.complete &&
  img.naturalWidth) { ... }` — so a still-loading image never throws.
  Cover-fit recipe: `var s = Math.max(canvas.width / img.naturalWidth,
  canvas.height / img.naturalHeight);` then draw centered at that scale.
  Transparent PNG/GIF alpha composites in-scene — but the MP4 itself is
  opaque, so always paint a background first (unpainted regions read as
  black).
- Cropping needs no tools: `drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh)`
  paints only the source rect — center/aspect crops, thirds framing, and
  pan-and-scan (animate `sx`/`sy` over `t` for Ken Burns). Same overload
  crops `<video>` frames. Crops apply at draw time; the source file is
  never modified.
- Clips: `<video muted playsinline preload="auto"
  src="workspace://<id>">`, driven entirely by scene JS (`currentTime`,
  `loop`, `playbackRate`) and painted with `drawImage(video, ...)` once
  `video.readyState >= 2`. `muted` is mandatory: the recorder captures its
  own audio graph, never page audio, so an unmuted clip would play sound
  you hear in preview but lose in the render.
- Timing tradeoff: `video.play()` is smoothest but drifts against the
  timeline; seek-chasing (`video.currentTime` retargeted toward the scene
  time each frame) stays glued at the cost of occasional stepped motion.
  Pick per scene and never promise both.
- Before authoring around a clip, look at it first with `getVideoFrame`
  (poster at a few timestamps) so framing and motion match the footage.
- Chroma key (green/blue screen): a clip shot against a flat screen is
  keyed at draw time through the in-page helper (present in every render
  and preview page — no tool call):
  `window.__mobileAgentChromaKey.drawKeyed(ctx, video, dx, dy, dw, dh,
  { key, similarity, smoothness, spill })`. It paints the keyed frame onto
  the scene canvas and returns true; on false (video not ready, bad key
  color) fall back to a plain `drawImage` so the scene never blanks.
  The helper keys on the GPU (WebGL shader, zero pixel readback) and falls
  back to a CPU pixel loop per draw where WebGL is missing — same call,
  same params either way. `key` is strict `#rrggbb` (`#00ff00` green, `#0000ff` blue — anything
  else is rejected); `similarity` (default 0.35) is the UV-distance cut
  threshold, `smoothness` (default 0.1) the edge ramp, `spill` (default
  0.15) the green-fringe removal. Defaults are starting points, not
  answers: sample the screen color with `getVideoFrame`, set `key` to it,
  render `previewScene` stills, then adjust (raised `similarity` eats
  screen shadows, raised `smoothness` softens halos, raised `spill` kills
  fringe on hair/edges) and re-check after every change. Limits:
  wrinkled/shadowed screens key unevenly, heavy compression fringes (push
  `spill` up), and a subject wearing the screen color is unkeyable —
  detect it from the stills and say so instead of shipping holes. One
  keyed clip per scene unless a device measurement clears more (measure
  GPU vs CPU via sustained-frame cost on a real render, not a still).

Synth cues (`synth.kind`):

- `tone`: `freq` (Hz) or `notes` played in sequence — MIDI numbers like 60 or
  note names like `"C4"`, `"F#3"`, `"Bb2"` (up to 128 notes); `noteDur`
  seconds per note; `wave` sine (default) / triangle / square / sawtooth;
  `attack`, `release`. Melodies, bass lines, arpeggios.
- `pad`: `notes` as a chord (up to 16 notes); slow `attack`/`release` by
  default (1.5 s each). Chord beds and progressions (one track per chord).
- `noise`: filtered-noise bed or sweep; `filter` lowpass (default) / highpass
  / bandpass, `filterFreq` → `filterEnd` sweep in Hz, `q`.
- `drums`: sample-free kit patterns — `stepDur` seconds per step (default
  0.25) and `steps`, one entry per step; each step lists its hits (`"kick"`,
  `"snare"`, `"hat"`, `"openhat"`, `"clap"`), e.g.
  `steps: [["kick","hat"],[],["snare"],["hat"]]`. Optional `kit` tweaks per
  piece (`level`, `decay`, `tone`). At most 512 hits per track (extras are
  skipped with a warning), and steps past the track's `duration` are cut —
  size the pattern to fit.

Effects (`fx` plus per-track sends):

- Schedule-level buses, at most one of each per video:
  `fx: { reverb: { decay }, delay: { time, feedback, mix } }` (`true`
  selects tuned defaults for either block). Reverb is a generated room
  (`decay` 0.5–3 s); echo is a single delay line, so time one `time` to the
  beat (e.g. `stepDur * 0.75`), `feedback` below 1, `mix` for the wet level.
- Per-track sends on any track — synth, drums, file, even narration:
  `reverb: 0..1`, `delay: 0..1` (default 0). Wet signal adds on top of the
  dry track: count a send of 0.5 as roughly half the track again when you
  balance volumes near 1.

Ducking music under voice (no auto-duck — declare it):

- On a music track, add `duckUnder: [{ start, end }]` in video-time seconds
  (narration part starts from `textToSpeech`, voice segments from
  `transcribeAudio`), plus `duckAmount` (level while ducked, default 0.4),
  `duckAttack` (default 0.3 s), `duckRelease` (default 0.5 s).
- Overlapping ranges merge; ranges outside the track are clipped to it.
- Ducking scales the whole track, sends included — the voice stays dry
  unless you send it too.

Check the mix before rendering (numbers, not taste):

- After authoring the `audio` schedule, run **`previewMix`** on the scene:
  it renders the mix offline and reports peak/RMS, clipping spots with
  timestamps, near-silent ranges, and applied ducking, plus one actionable
  warning (null when healthy). Fix volumes/duck ranges and re-check —
  seconds per iteration instead of a full render each time.
- It cannot judge taste: a weak kick or an ugly reverb still needs ears.

Mixing rules:

- Encoding is handled by the app: when WebView's audio encoder is unavailable,
  raw audio is encoded to AAC natively on Android. Use the same schedule for
  both paths; do not declare audio unsupported without a tool warning.
- Simple additive mix with per-track volumes. No automatic ducking — music
  ducks under voice only when you add explicit `duckUnder` ranges (see
  Ducking). Keep the sum of audible track volumes near 1 (e.g. music 0.5 +
  pad 0.3) to avoid clipping.
- Timing between audio events is sample-accurate (everything is scheduled up
  front on the audio clock), but alignment to picture drifts ~50 ms during
  realtime capture: score beds, swells, and drum hits freely, but never
  promise lip-sync.
- The schedule holds ~2000 simultaneous sound events across all tracks
  (plenty for a 45 s video); past that, extras are skipped with a warning
  instead of failing the render.
- The tool result reports `hasAudio` and `audioWarnings` (e.g. a cue that had
  to be skipped). If `hasAudio` is false after you asked for sound, tell the
  user the video came out silent and why.

## Audio-reactive visuals ("visuals as per the audio")

When the user gives you an audio track and asks for visuals that follow it,
**react to it instead of guessing**. The recorder precomputes a deterministic
feature track from the file audio **and any generated synth/drums beds**
(rendered offline into the same mix) and hands it to `render` as the fourth
argument `audio` (also mirrored at `window.MOBILE_AGENT_VIDEO_AUDIO`). A drum
pattern or bass line with no audio file attached still drives `beatPulse` —
rendering the stems adds a short pre-roll before recording starts:

```js
render: function (t, canvas, ctx, audio) {
  var pulse = audio.ready ? audio.beatPulse(t) : 0;   // 0..1, decays after each beat
  var bass  = audio.ready ? audio.lowAt(t)   : 0;     // 0..1 kick/bass energy
  var level = audio.ready ? audio.level(t)   : 0;     // 0..1 overall loudness
  // ...drive scale, glow, camera shake, colour with these...
}
```

Surface (node-safe to ignore — it is always an object):

- `audio.ready` — `false` when there was no analyzable audio (neither file
  nor generated). Every lookup then returns `0`, so you can call them
  unconditionally.
- `audio.duration` — seconds analyzed (capped at the video `duration`).
- `audio.bpm` — estimated tempo (50–220) or `null`.
- `audio.beats` — array of onset times in seconds, ascending.
- `audio.level(t)`, `audio.lowAt(t)`, `audio.midAt(t)`, `audio.highAt(t)`,
  `audio.onsetAt(t)` — normalized (0..1) envelopes at time `t`, linearly
  interpolated and clamped. `low` = bass/kick, `high` = hats/air.
- `audio.pitchAt(t)` — dominant pitch in Hz at time `t` (`0` when unvoiced:
  drums, noise, silence). Follows the loudest voice only — it cannot separate
  chord tones. `audio.pitchConfAt(t)` is the 0..1 confidence for it.
- `audio.key` — key implied by the notes (e.g. `"C major"`), or `null` when
  unknown; `audio.keyConfidence` (0..1) and `audio.tuningCents` likewise.
  `audio.pitch`/`audio.pitchConf` are the raw per-frame arrays.
- `audio.beatPulse(t, decay?)` — `1` on a beat decaying exponentially back to
  `0` (default decay 0.18 s). Falls back to the `bpm` grid when no onsets were
  detected.
- `audio.energy/low/mid/high/onset` — the raw per-frame arrays if you want to
  sample or average them yourself.

Rules:

- The features are **precomputed before the first frame**, so sampling them
  inside `render` stays deterministic — this is the one place reading "audio
  state" is allowed. Never create an `AudioContext` or `AnalyserNode` inside
  `render`.
- **`file`** tracks and **generated** tracks are analyzed: file clips with
  their schedule applied, synth/drums cues via an offline stem render
  (volumes, fades, ducking, and wet sends baked in).
- Analysis reflects the file as scheduled: `start`, `offset`, `duration`,
  `loop`, `volume`, `fadeIn`/`fadeOut` and `master` are all applied first.
- Combine with the beat grid for scene cuts:
  `if (audio.ready && t >= nextBeat) { nextBeat = ... }` using `audio.beats`,
  or drive per-frame motion directly with `beatPulse`/`lowAt` (preferred — it
  needs no state).
- If you want to know the tempo, beat times, melody notes, or key **before**
  authoring (e.g. to place cuts at the right moments or follow the tune), use
  the **`analyzeAudio` tool** on the same `workspace://` file id; then
  hard-code those times/notes or rely on the live `audio` object at render
  time. Video files (MP4/MOV/WebM) are accepted too — only the soundtrack
  is decoded. Its `voicedRatio` tells you whether a usable melody exists (below
  ~0.3 there is none — say so, do not invent notes). Pitch follows the
  loudest voice only; never claim chord separations or instruments.

## Speech sync and captions

When the recording has **speech** and the user wants the visuals (or captions)
to follow the **words**, transcribe it first with the **`transcribeAudio`
tool** on the `workspace://` file id. By default it runs on device with the
Whisper model downloaded in Settings → Voice input and returns:

```json
{
  "language": "en",
  "duration": 12.4,
  "text": "full transcript ...",
  "segments": [
    { "start": 0.0, "end": 2.3, "text": "first phrase" },
    { "start": 2.3, "end": 5.1, "text": "second phrase" }
  ]
}
```

`segments` are sentence/phrase spans in **seconds** (ascending). Put them on the
contract as `speech` and the recorder hands them back to `render` as the fifth
argument `speech` (also mirrored at `window.MOBILE_AGENT_VIDEO_SPEECH`), already
normalized — so captions need no manual lookup and no render-time audio access:

```js
window.MOBILE_AGENT_VIDEO = {
  /* ...duration, fps, canvas, audio... */
  speech: { segments: [ /* paste the tool's segments here */ ] },
  render: function (t, canvas, ctx, audio, speech) {
    var line    = speech.ready ? speech.activeText(t) : "";  // text at time t
    var karaoke = speech.ready ? speech.progress(t)   : 0;   // 0..1 through the line
    // ...draw the caption; size it to the line, wipe it with karaoke...
  }
};
```

Surface (node-safe to ignore — it is always an object):

- `speech.ready` — `false` when there are no usable segments. `activeText(t)`
  then returns `""` and `activeIndex(t)` returns `-1`.
- `speech.segments` — normalized spans `{ start, end, text }`, ascending;
  whitespace collapsed, empty/zero-length spans dropped, times clamped to the
  video `duration`.
- `speech.activeText(t)` — text of the span containing `t` (start inclusive, end
  exclusive), or `""` in a gap.
- `speech.activeIndex(t)` / `speech.activeSegment(t)` / `speech.segmentAt(i)` —
  the span or its index, or `-1` / `null`.
- `speech.progress(t)` — `0..1` position within the active span (for karaoke
  wipes and word pops); `0` when none.
- `speech.nextStart(t)` — start of the next span after `t`, or `null` (handy to
  cut a scene on the next phrase).
- `speech.count`, `speech.duration`, `speech.language`, `speech.text` — the
  number of spans, the span extent, the detected language, and the full
  transcript.

Rules:

- Segment times are **video time**. If you schedule the audio track with a
  `start`/`offset`, set `speech.offset` to the same shift (or shift the times
  yourself) so words stay glued to the sound.
- Baking the times into your own constant array also works (the transcript is
  deterministic) — the `speech` object is a convenience, not a requirement.
- **Only for speech.** `transcribeAudio` ignores music; use `analyzeAudio` for
  rhythm and `transcribeAudio` for words. You can run both on the same file.
- **Engine choice.** `transcribeAudio` uses Whisper by default. Pass
  `engine: "system"` to try the device's own recognizer instead (Android 13+),
  which is a different model and sometimes more accurate on names or accents —
  but it only reports timed `segments` on Android 14+ with the on-device speech
  model. When it has no timings the result comes back with `segments: []` and a
  `warning`; captions are impossible from that result, so re-run on `whisper`.
  Do not ask for `"system"` unless the user wants it or Whisper struggled.
- Keep transcribed text **verbatim** in the caption; do not "fix" the wording
  silently. If a word is clearly wrong you may correct an obvious
  transcription slip, but never invent lines the speaker did not say.
- Inline the text as a JS string literal, escaping quotes so it cannot end the
  `<script>` tag (`text: "it's fine"`).
- Do not read audio at render time for speech — pass **times**, not samples.
- The tool needs a Whisper model downloaded in Settings → Voice input; if it
  fails with that message, tell the user and offer to proceed without captions.

## Hard rules

1. **One visible `<canvas>`** holding the animation. Use `canvasId` whenever
   the page contains more than one canvas.
2. **Deterministic frames.** Everything must be a pure function of `t`
   (seconds). Never use `Math.random()`, `Date.now()`, `performance.now()`,
   `clock.getElapsedTime()`, fetch, or input inside `render` — the video must
   be reproducible and every frame must match what the recorder captures.
3. **Synchronous render.** `render` returns after drawing; the recorder captures
   the canvas immediately. No async work inside `render`.
4. **No self-driven animation loop.** The recorder calls `render` on its own
   clock. Do not run `requestAnimationFrame`/`setInterval` loops that mutate
   the recorded canvas. If you want an idle demo loop, gate it on
   `window.MOBILE_AGENT_VIDEO_RECORDING` and pause when it is `true`.
5. **Self-contained file.** Inline all CSS/JS. Avoid CDNs (the device may be
   offline). Three.js is allowed if you inline it.
6. **Silent by default.** Omit `audio` for a silent video; add the schedule
   from the Audio section when the video should have sound.

## Patterns

### Plain canvas 2D

```html
<canvas id="scene"></canvas>
<script>
  var ctx = document.getElementById("scene").getContext("2d");
  window.MOBILE_AGENT_VIDEO = {
    duration: 10, fps: 30, width: 1280, height: 720, canvasId: "scene",
    render: function (t) {
      var w = 1280, h = 720;
      ctx.fillStyle = "#0b0b0c";
      ctx.fillRect(0, 0, w, h);
      var x = w / 2 + Math.cos(t * 2) * w * 0.3;
      var y = h / 2 + Math.sin(t * 3) * h * 0.3;
      ctx.beginPath();
      ctx.arc(x, y, 60, 0, Math.PI * 2);
      ctx.fillStyle = "hsl(" + ((t * 60) % 360) + " 90% 60%)";
      ctx.fill();
    },
  };
</script>
```

### Three.js / WebGL

```html
<canvas id="scene"></canvas>
<script src="three.min.js"></script>
<script>
  var renderer = new THREE.WebGLRenderer({ canvas: scene, antialias: true });
  renderer.setSize(1280, 720, false); // must match contract width/height
  var camera = new THREE.PerspectiveCamera(60, 1280 / 720, 0.1, 100);
  camera.position.z = 5;
  var mesh = <your geometry + material>;
  window.MOBILE_AGENT_VIDEO = {
    duration: 10, fps: 30, width: 1280, height: 720, canvasId: "scene",
    render: function (t) {
      mesh.rotation.y = t * 0.6;           // drive everything from t
      renderer.render(scene, camera);
    },
  };
</script>
```

Three.js/WebGL notes:

- The recorder captures **the renderer's own canvas**; set the export
  resolution with `renderer.setSize(width, height, false)` where `width`/
  `height` match the contract.
- Camera aspect must equal `width / height`.
- Prefer `preserveDrawingBuffer: true` on the WebGL context for maximum
  capture robustness across the GPU and JPEG fallback paths (Three.js:
  `new THREE.WebGLRenderer({ canvas, preserveDrawingBuffer: true })`).
- Stay inside 1280×720 unless the user asked for more; bigger scenes cost GPU
  time per frame.

## Performance

- Keep `render` under ~16 ms/frame (30 fps at 720p) so the export stays
  real-time.
- No per-frame allocations: create gradients, paths, and geometry once.
- Complex scenes: WebGL. Avoid heavy 2D effects like `shadowBlur` everywhere.
- The export is real time: a 10-second video takes ~10 seconds to record.

## When plain scrolling/DOM footage is requested

The recorder needs one canvas and a deterministic `render(t)`. If the user asks
for something that cannot be one canvas — "record me scrolling this long page"
— explain the limit and reframe: a single screen of animation, or a camera pan
inside one canvas scene.

## Checklist before you finish

- [ ] never ended a turn on a promise ("I'll make…", "I'll analyze…"): the
      tool call (`analyzeAudio`, `renderVideo`, …) is in the SAME response as
      the words — a plan with no tool call delivers nothing and the run ends
- [ ] `window.MOBILE_AGENT_VIDEO` defined with a `render` function
- [ ] no homemade preview/scrub/time-slider UI in the scene — the app's
      built-in player covers playback, and the file stays clean
- [ ] render is deterministic: only `t` and constants (no `Math.random`,
      `Date.now`, `requestAnimationFrame`)
- [ ] exactly one recorded canvas, sized to `width × height`
- [ ] config values inside the allowed ranges (duration 1–600, fps 5–60)
- [ ] self-contained (no external CDN without warning the user about offline)
- [ ] if the user asked for the file directly: called `renderVideo` with the
      full HTML and reported the returned MP4 (do **not** rely on a meta tag)
- [ ] if audio was requested: every `file:` id exists in the workspace
      (MP3/WAV/M4A/AAC/OGG/WebM, ≤ 15 MB), cues fit inside `duration`, volumes
      sum near 1, and `hasAudio` came back true (otherwise told the user why
      the video is silent)
- [ ] if the user asked for visuals "to the audio": ran `analyzeAudio` on the
      file (or used the live `audio` argument) and drove at least one visual
      property from `level`/`lowAt`/`beatPulse`/`beats` instead of ignoring the
      soundtrack (for generated synth/drums beds the live `audio` argument
      already reflects them — no tool call needed)
- [ ] if the scene keys a green/blue screen: sampled the screen color with
      `getVideoFrame`, tuned `similarity`/`smoothness`/`spill` from
      `previewScene` stills (no eaten subject, no glowing fringe), one keyed
      clip max unless a device measurement cleared more
- [ ] if the render failed: read the error cause (renderer crash means
      the document is too heavy — shrink first: shorter duration, lower
      resolution/fps, smaller clip) and retry the smaller version instead
      of retrying the same document blindly
- [ ] if the user asked to recreate/copy a song with synth: declined the full
      cover (plain oscillators can never reproduce a produced track — it will
      sound like a ringtone) and offered the honest alternatives instead: a
      rough melody-only sketch clearly labeled as such, an original bed in the
      measured key/tempo, or a visualization using their audio unchanged
- [ ] if the user asked for captions or word-synced visuals: ran
      `transcribeAudio` on the file and put the returned `segments` on the
      contract's `speech` (or baked the times in) and drove the captions from
      `speech.activeText(t)`/`progress(t)` (verbatim wording, no invented lines)
- [ ] if the user asked for voiceover/narration: generated it with
      `textToSpeech` (or the endpoint fallback), scheduled every part as a
      `file:` track at its `start`, and captioned it via `transcribeAudio`
- [ ] if the scene uses user images/clips: every `workspace://` id exists,
      files are within type/size limits, `<video>` is muted, draws are
      guarded (`img.complete`, `readyState`), and the result reports them
      in `imageFiles`/`videoFiles`
- [ ] if the scene has sound: ran `previewMix` and cleared its warning
      (volumes near 1, no clipping, ducking lands on the voice)
- [ ] if the scene is new or complex: reviewed a `previewScene` storyboard
      before spending render time (composition, framing, captions placed)
- [ ] if revising a previous render: read its `sourceFileId` (`.source.html`)
      and edited that file instead of writing a new scene from scratch
- [ ] if the user pointed at a timestamp: inspected it with `getVideoFrame`
      (or `ocr` on models without image input) before claiming what's there
- [ ] complete scene: start state at t=0, motion clearly readable in 10 s
