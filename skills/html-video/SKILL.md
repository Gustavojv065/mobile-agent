# HTML Video Export

Use this skill when the user asks you to **make a video**, an animation, a
"recordable" scene, or an MP4 — for example "make a video about how a black
hole works" or "animate the solar system and export it".

The app embeds a recorder in the HTML preview. When the user taps **Export
MP4**, the recorder:

1. Finds the page's canvas and resizes it to the export resolution.
2. Calls `render(t, canvas, ctx)` once per frame at the requested FPS.
3. Captures the canvas with the GPU (`VideoFrame` + the hardware WebCodecs
   `VideoEncoder`) and streams the H.264 chunks to a native MP4 muxer. On
   WebViews without WebCodecs it falls back to JPEG frames re-encoded on the
   native hardware encoder.

Your job: produce a **single, self-contained HTML document** that implements
the contract below. The user previews and records whatever the page shows — no
interaction, no audio, one canvas.

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
    render: function (t, canvas, ctx) {
      // Draw the frame at time t (seconds). Must be deterministic and
      // synchronous — the recorder captures immediately after it returns.
    },
  };
</script>
```

The recorder picks `document.getElementById(canvasId)`, or the first visible
`<canvas>` on the page when no id is given.

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
6. **Silent.** v1 output has no audio track.

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
- The export is real time: a 10-second video takes ~10 seconds to record. What
  the user sees in the preview is exactly what gets recorded.

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
- [ ] complete scene: start state at t=0, motion clearly readable in 10 s