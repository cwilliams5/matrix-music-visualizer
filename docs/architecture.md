# Matrix Music Visualizer — architecture

A reference for contributors (and future us). For a user-facing tour read the top-level
`README.md`; for the vendored-renderer edit log read `MODIFICATIONS.md`.

## 1. Overview

A no-build, pure-ES-module web app that turns Rezmason's WebGL Matrix digital-rain
renderer into a music visualizer. Two halves:

- **`app/`** — original code: the audio analysis, the reactivity mapping + preset system,
  the transitions/director, the UI, and the embedded adapter. The "brain".
- **`vendor/matrix/`** — the vendored Rezmason/matrix renderer (MIT), modified to be driven
  from outside. The "eyes". Every change is marked `// MATRIX-VIZ` and listed in
  `MODIFICATIONS.md`.

The two halves communicate through ONE shared object, **`A`** (the bridge), defined in
`vendor/matrix/js/reactive.js` and imported by both sides. Neutral defaults mean the renderer
behaves exactly like upstream when nothing is driving it.

It runs **two ways** (see §8):

- **Standalone** — its own `<audio>` player + Web Audio analysis (the default).
- **Embedded** — a host app installs `window.matrixVizHost`; the viz becomes a pure
  visualizer reading the host's audio + now-playing. The host owns playback.

No build step: `index.html` loads `app/boot.js` as a module; everything else is imported from
there. Serve with any static server (`python serve.py`).

## 2. File map

```
matrix-music-visualizer/
  index.html            app shell: #stage (canvas mount), control panel, player bar, modal
  serve.py              tiny zero-dep static server (Range-capable, for <audio> seeking)
  app/
    boot.js             orchestrator: renderer lifecycle (build/rebuild on mode change), the
                        single per-frame master tick (A.update -> frame hooks), shell UI, the
                        WebGL-support / fatal-message guard
    embed.js            the EMBEDDED ADAPTER: detects window.matrixVizHost, the guarded
                        hostBridge facade, the capabilities declaration (§8)
    app-init.js         subsystem wiring hub: inits player/engine/beat/mapping/store/director/
                        overlay; builds the mixer UI + preset controls; standalone-vs-embedded
                        branches (track-change wiring, help/menu filtering)
    player.js           <audio> element, playlist (music/playlist.json), transport, drag-drop
                        (a no-op shell in embedded mode)
    audio-engine.js     per-frame feature extraction (bands/RMS/centroid/flux/stereo/spectrum)
                        with adaptive gain control. TWO sources: Web Audio (attach) or the host
                        bridge (attachHost); acquire is split from the shared analysis
    beat-detector.js    spectral-flux + bass onset detection -> beat/onset envelopes
    bpm.js              multi-hypothesis inter-onset-interval tempo estimator
    presets.js          EFFECTS registry, the 18 characters (map/shock/hue), the driver-DATA
                        model (extractDrivers/applyDrivers + channel drivers), buildDefaultRecords,
                        the transition blend fns, and mapping.apply (features+mixer -> knobs/shader)
    presets-store.js    live preset list, localStorage persistence + schema migration, CRUD,
                        export/import
    palette-store.js    the palette library (ramp / moded / plain / stripe / debug kinds)
    transitions.js      blend controller: preset param-blend / palette gradient-morph / mode
                        crossfade + the N-slot song-title splash (Overlay + Glyph burn-in modes)
    director.js         auto-switch of mode/palette/preset (timer + drops + track-change)
    overlay.js          debug overlay (meters/BPM/centroid) + beat-flash
    fullscreen.js       unified immersive fullscreen (F / stage double-click, auto-hide chrome)
    icons.js  session-store.js   SVG icons; ephemeral session persistence
    style.css           UI theme (phosphor green), mixer rows, modal, embedded chrome-hide
  examples/
    embed-mock.js       reference host: backs window.matrixVizHost with demo-track Web Audio
    README.md
  music/                playlist.json + CREDITS.md + the CC0 demo .mp3s
  vendor/matrix/        vendored + MATRIX-VIZ-modified renderer (assets/js/lib/shaders + LICENSE)
  docs/architecture.md  this file
  README.md  LICENSE  THIRD-PARTY.md  MODIFICATIONS.md  .gitignore
```

## 3. The bridge: `A` (vendor/matrix/js/reactive.js)

The single object shared by app + renderer:

- `A.reactive` (bool), `A.intensity` (master multiplier).
- `A.features` — raw per-frame audio analysis (level, rms, peak, bass/lowMid/mid/highMid/
  treble, balance, stereoWidth, centroid, flux, beat, beatPulse, beatBass, bpm, beatPhase,
  beatClock, beatCount, onset, energy, energySlow, playing, time, dt).
- `A.spectrum` — Float32Array(64), log-spaced FFT magnitudes (Spectrum Rain).
- `A.fallPhase`, `A.animPhase` — integrated motion phases (∫speed·dt) so reactive speed
  changes stay smooth and never run backward.
- `A.knobs` — the rain's own params the mapping writes each frame (fallSpeed, cycleSpeed,
  animationSpeed, raindropLength, baseBrightness, baseContrast, brightnessDecay, bloomStrength,
  cursorIntensity, glintIntensity). Renderer uniform fns read `A.knobs.x ?? config.x`.
- `A.base` — each mode's base knob values, captured when a pipeline builds (mapping anchor).
- `A.shader` — new-physics channels read by global shader uniforms (pulse, shockX/Y/Phase/
  Strength, glyphJitter, bassWarp, hueShift, colorBleed, spectrum, windSway, spawn, pulseWarp,
  cameraStrafe/Boom/Dolly/Yaw/Pitch/Roll/ShakeX/Y).
- `A.mixer` — the working mixer state `{ effectId: {on, strength} }`.
- `A.characterId`, `A.drivers`, `A.channelDrivers`, `A.shockCfg`, `A.hueCfg`, `A.jumpMode`,
  `A.jumpPalette` — the active preset's look (see §7).
- `A.title` — the N-slot song-title splash state (per-slot amount/drop/release arrays).
- `A.paletteMorph` — the per-frame blended gradient during a palette morph.
- `A.update(t)` — replaceable per-frame hook; boot.js sets it to the master tick.

## 4. Per-frame data flow

The renderer's `regl.frame` calls `A.update(now)` once per rendered frame (single rAF).
boot.js's `A.update` runs the registered frame hooks in order, then integrates the phases:

```
audio-engine.sample   -> A.features (+ A.spectrum)     (bands/RMS/centroid/flux/stereo)
beat-detector.process -> A.features.{beat,bpm,...}      (reads A.features.flux + .bass)
mapping.apply         -> A.knobs + A.shader             (interprets the active look's driver data)
director.tick         -> may setMode / store.setActive  (reads A.features energy)
overlay               -> DOM meters + #beat-flash
transitions.tick      -> advances title slots / blends
boot: A.fallPhase += knobs.fallSpeed*knobs.animationSpeed*dt;  A.animPhase += knobs.animationSpeed*dt
```

The renderer then renders, reading `A.knobs` via per-uniform functions and `A.shader`/phases
via the global uniforms (§5).

## 5. Renderer integration (the vendored edits)

- **Single context + pipeline cache** (`js/regl/main.js`): one regl context for the app life;
  a mode switch rebuilds only the pipeline, cached per `version|effect`. `handle.rebuild(config)`
  swaps the active pipeline. A **crossfade** path keeps the old pipeline live and blends two
  rendered pipelines for mode transitions; a **rekeyActive** path re-keys the live pipeline
  after an in-place palette morph.
- **Global audio uniforms**: `makeFullScreenQuad(regl, {...})` is the scope wrapper around every
  pass; REGL propagates its uniforms to all nested pass shaders (the same mechanism that feeds
  `time`). So `uBass`, `uBeat`, `uShockPhase`, `uHueShift`, `uFallPhase`, `uSpectrum`, `uWindSway`,
  `uPulseWarp`, … are available to any shader that declares them.
- **Reactive knob uniforms**: in rainPass/bloomPass/palettePass the continuous knobs are REGL
  uniform *functions* `() => A.knobs.x ?? config.x`, so they animate per frame and fall back to
  the mode's config when not set.
- **Shader physics** (gated by `uReactive` + each channel's amount; zero ⇒ vanilla): Spectrum
  Rain + beat-spawned drops (`rainPass.raindrop.frag`), beat shockwave + bass glow
  (`rainPass.effect.frag`), glyph jitter (`rainPass.symbol.frag`), hue rotation / chroma bleed /
  bass warp / wind sway (`palettePass.frag`), and the JS-side 3D camera rig (`rainPass.js`).
- **Song-title mask**: a persistent atlas texture (`setTitleMask`) sampled by the rain passes to
  burn glyph titles into the rain (see transitions.js §7).

## 6. Modes vs Effects vs Presets vs Palettes (independent axes)

- **Mode** (`config.version`): the rain *style* (classic, 3d, trinity, megacity, operator,
  nightmare, paradise, morpheus, bugs, palimpsest, twilight, neomatrixology, resurrections).
  Structural — switching rebuilds the pipeline.
- **Palette** (`config.effect`): the post-effect coloring (mode-default / plain / spectrum
  stripes / editable brightness→color ramps / generative random), from `palette-store.js`.
- **Effect** (the mixer entries): an individual reactive behavior, each on/off + strength.
- **Preset**: a saved look (mixer + character + driver data + shock/hue + intensity + scene
  bindings). Loading one sets the whole look and may jump the mode/palette (§7).

## 7. The look model (presets.js + the two stores)

A preset **record** is fully numeric/serializable:
`{ id, characterId, mixer, drivers, channelDrivers, shock, hue, intensity, jumpMode, jumpPalette }`.

- **`EFFECTS` registry**: `{ id, group: physics|camera|motion, label, def }`. `def` is the
  strength used when you enable an effect the active preset left at 0.
- **Reactivity is DATA.** Each built-in character is a `map(ctx)` that expresses its signature as
  a LINEAR feature-mix over the knobs. `extractDrivers()` probes that map and bakes the
  coefficients into a `drivers` object; `channelDrivers` do the same for the three physics
  channels (pulse / bassWarp / windSway). At runtime `mapping.apply` interprets the driver DATA
  (`applyDrivers` / `applyChannelDrivers`) — the `map()` functions are the equivalence-tested
  *source* for the defaults, not the runtime path. (`verifyDriverEquivalence` /
  `verifyChannelEquivalence` prove interpreter == pipeline.) This is what lets a preset change
  **crossfade** — lerping two linear maps' coefficients lerps their output.
- **`mapping.apply`** reads `A.mixer` via `mx(id) = on ? strength : 0`, applies the driver data
  gated by the mixer, then drives `A.shader` (physics + camera) and the hue/shock state.
- **Scene bindings**: `jumpMode` / `jumpPalette` switch the mode / palette when the preset is
  applied (guarded so re-applying the current one is a no-op). e.g. *Compile* → operator + amber.
- **18 built-in characters** in the `PRESETS` array, plus a generative **🎲 Random**.
- **`presets-store.js`**: `records` (live list) persisted to `localStorage['matrixviz.presets.v1']`
  under `PRESET_SCHEMA`; a version bump re-seeds the built-ins (customs preserved). `setActive(id)`
  loads a record into A and applies its scene bindings; `save`/`saveAsNew`/`deletePreset`/
  `restoreDefaults`/`exportJSON`/`importJSON`.
- **`transitions.js`** blends look→look: preset param-blend (lerp the driver coefficients), palette
  gradient-morph (recolor the 1D palette texture in place), or a dual-pipeline mode crossfade —
  chosen by the `when` policy (Always / Director / Off). It also owns the N-slot title splash.

## 8. The embedded adapter (app/embed.js)

Standalone and embedded share the SAME analysis + look system; only the **audio source** and
**playback ownership** differ.

- **Detection**: a host installs `window.matrixVizHost` before boot. `embed.js` reads it once;
  `isEmbedded()` is true iff present. It sets `html.matrixviz-embedded` (CSS hides the transport
  bar + playlist) and declares `window.matrixViz.capabilities = { version, ownsPlayback:false }`.
- **The contract** (pull-based, app-agnostic — full spec at the top of `embed.js`):
  `readAudio()` → `{ pcm, fftMag[], frames, channels, sampleRate, generation } | null`,
  `getNowPlaying()`, `onTrackChange(cb)`, optional `getPlaybackState()`.
- **hostBridge facade**: consumers never touch the raw host — they use `hostBridge`, which wraps
  every call so a throwing/missing host method degrades the viz to calm and warns ONCE (not every
  frame).
- **Audio seam** (`audio-engine.js`): `attachHost()` instead of `attach()`. `_acquireHost()` pulls
  a block and fills the same `mag` / `timeData` / L-R buffers `_acquireAnalyser()` would; the
  shared analysis is identical, so reactivity matches standalone. (Stereo width/balance + the
  64-bin spectrum are recovered from the raw PCM/FFT.)
- **Playback seam** (`player.js` / `app-init.js`): `initPlayer()` returns a bare shell (no
  transport UI/keys/media-session/demo-playlist); title + track-change come from the host and
  drive the title splash + director; the `?` help overlay and right-click menu omit playback rows.

`examples/embed-mock.js` is a reference host (demo-track Web Audio → the contract); open
`?embed-mock` to run embedded mode without a real host.

## 9. How to add things

- **A shader physics effect:** add `A.shader.<chan>` (reactive.js) → a global uniform in
  `makeFullScreenQuad` (main.js) → declare + use it in the shader (gate by `uReactive` + the
  channel; 0 = no-op) → drive `s.<chan>` in `mapping.apply` from `mx('id')` → add an `EFFECTS`
  entry (presets.js). It auto-appears in the mixer UI.
- **A reactive knob:** add it to `KNOB_KEYS` + `KNOB_META` + `DEFAULT_KNOB_MAP`; the knob must
  already be a reactive uniform fn in the relevant pass.
- **A preset:** add an entry to `PRESETS` (a character: `map/shock/hue` + a `w` for default mixer
  strengths, plus optional `jumpMode`/`jumpPalette`/`intensity`/`channelDrivers`).
  `buildDefaultRecords()` turns it into a record; bump `PRESET_SCHEMA` (or `restoreDefaults`) to
  seed it into existing libraries.
- **A mode:** it already exists if it's a Rezmason `version`; add it to `MODES` in boot.js.

## 10. Invariants

Single WebGL context (never recreate per switch) · phase-continuous motion (integrate speed,
never time×reactiveSpeed) · volumetric overscan + clamped backward-only dolly · NaN-guard the
knobs · `setMode` defers off the frame stack · the driver interpreter must stay equivalent to the
`map()` source (the verify gates) · standalone reactivity must equal embedded · vendored edits
marked `// MATRIX-VIZ`.
