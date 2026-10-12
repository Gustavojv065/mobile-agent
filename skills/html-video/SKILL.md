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
2. Calls `render(t, canvas, ctx, audio)` once per frame at the requested FPS.
3. Captures the canvas with the GPU (`VideoFrame` + the hardware WebCodecs
   `VideoEncoder`) and streams the H.264 chunks to a native MP4 muxer. On
   WebViews without WebCodecs it falls back to JPEG frames re-encoded on the
   native hardware encoder.

## Contract

Define this before the body finishes loading:

```html
<script>
  window.MOBILE_AGENT_VIDEO = {
    duration: 10,      // seconds, 1–45, default 10
    fps: 30,           // 5–60, default 30
    width: 1280,       // export width, even number, ≤ 1920, default 1280
    height: 720,       // export height, even number, ≤ 1920, default 720
    canvasId: "scene", // optional: id of the canvas to record
    render: function (t, canvas, ctx, audio) {
      // Draw the frame at time t (seconds). Must be deterministic and
      // synchronous — the recorder captures immediately after it returns.
      // audio carries precomputed soundtrack features (see Audio-reactive
      // visuals). It is always an object; check audio.ready first.
    },
    audio: {           // optional: omit for a silent video (see Audio below)
      master: 0.9,
      tracks: []
    }
  };
</script>
```

The recorder picks `document.getElementById(canvasId)`, or the first visible
`<canvas>` on the page when no id is given.

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
- The tool inlines the file automatically. A missing, unreadable, or
  oversized file fails the render with a clear error before recording starts.

Synth cues (`synth.kind`):

- `tone`: `freq` (Hz) or `notes` played in sequence — MIDI numbers like 60 or
  note names like `"C4"`, `"F#3"`, `"Bb2"`; `noteDur` seconds per note;
  `wave` sine (default) / triangle / square / sawtooth; `attack`, `release`.
- `pad`: `notes` as a chord (up to 8 notes); slow `attack`/`release` by
  default (1.5 s each).
- `noise`: filtered-noise bed or sweep; `filter` lowpass (default) / highpass
  / bandpass, `filterFreq` → `filterEnd` sweep in Hz, `q`.

Mixing rules:

- Encoding is handled by the app: when WebView's audio encoder is unavailable,
  raw audio is encoded to AAC natively on Android. Use the same schedule for
  both paths; do not declare audio unsupported without a tool warning.
- Simple additive mix with per-track volumes — no auto-ducking. Keep the sum
  of audible track volumes near 1 (e.g. music 0.5 + pad 0.3) to avoid clipping.
- Sync is realtime within ~50 ms, not frame-accurate: score beds, swells, and
  approximate hits — never promise lip-sync or sample-exact SFX.
- The tool result reports `hasAudio` and `audioWarnings` (e.g. a cue that had
  to be skipped). If `hasAudio` is false after you asked for sound, tell the
  user the video came out silent and why.

## Audio-reactive visuals ("visuals as per the audio")

When the user gives you an audio track and asks for visuals that follow it,
**react to it instead of guessing**. The recorder precomputes a deterministic
feature track from the file audio and hands it to `render` as the fourth
argument `audio` (also mirrored at `window.MOBILE_AGENT_VIDEO_AUDIO`):

```js
render: function (t, canvas, ctx, audio) {
  var pulse = audio.ready ? audio.beatPulse(t) : 0;   // 0..1, decays after each beat
  var bass  = audio.ready ? audio.lowAt(t)   : 0;     // 0..1 kick/bass energy
  var level = audio.ready ? audio.level(t)   : 0;     // 0..1 overall loudness
  // ...drive scale, glow, camera shake, colour with these...
}
```

Surface (node-safe to ignore — it is always an object):

- `audio.ready` — `false` when there was no analyzable **file** audio. Every
  lookup then returns `0`, so you can call them unconditionally.
- `audio.duration` — seconds analyzed (capped at the video `duration`).
- `audio.bpm` — estimated tempo (50–220) or `null`.
- `audio.beats` — array of onset times in seconds, ascending.
- `audio.level(t)`, `audio.lowAt(t)`, `audio.midAt(t)`, `audio.highAt(t)`,
  `audio.onsetAt(t)` — normalized (0..1) envelopes at time `t`, linearly
  interpolated and clamped. `low` = bass/kick, `high` = hats/air.
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
- Only **`file`** tracks are analyzed (the audio the user attached). Synth cues
  are not — trigger those from `t` as usual.
- Analysis reflects the file as scheduled: `start`, `offset`, `duration`,
  `loop`, `volume`, `fadeIn`/`fadeOut` and `master` are all applied first.
- Combine with the beat grid for scene cuts:
  `if (audio.ready && t >= nextBeat) { nextBeat = ... }` using `audio.beats`,
  or drive per-frame motion directly with `beatPulse`/`lowAt` (preferred — it
  needs no state).
- If you want to know the tempo or beat times **before** authoring (e.g. to
  place cuts at the right moments), use the **`analyzeAudio` tool** on the same
  `workspace://` file id; then hard-code those times or rely on the live
  `audio` object at render time.

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

- [ ] `window.MOBILE_AGENT_VIDEO` defined with a `render` function
- [ ] render is deterministic: only `t` and constants (no `Math.random`,
      `Date.now`, `requestAnimationFrame`)
- [ ] exactly one recorded canvas, sized to `width × height`
- [ ] config values inside the allowed ranges (duration 1–45, fps 5–60)
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
      soundtrack
- [ ] complete scene: start state at t=0, motion clearly readable in 10 s
