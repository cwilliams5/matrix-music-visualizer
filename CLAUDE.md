# CLAUDE.md — Matrix Music Visualizer

Guidance for AI-assisted work on this repo. This is the **amnesia note**: the non-obvious,
load-bearing things that aren't already in the code comments. For the friendly overview read
[`README.md`](README.md); for the full architecture read [`docs/architecture.md`](docs/architecture.md).

## What this is

A standalone **and** embeddable Matrix digital-rain **music visualizer**. Pure ES modules +
WebGL, **no build step** — `index.html` loads `app/boot.js` as a module and everything is
imported from there. Two halves that meet at one shared object:

- **`app/`** — the brain: audio analysis, the reactivity/preset system, transitions/director,
  the UI, and the embedded adapter.
- **`vendor/matrix/`** — the eyes: [Rezmason/matrix](https://github.com/Rezmason/matrix) (MIT),
  vendored and modified. The bridge between the two is **`A`** in `vendor/matrix/js/reactive.js`.

## Run + verify — read this before touching anything

- **Serve:** `python serve.py` → http://localhost:8099 . Use `serve.py` (it adds HTTP Range for
  `<audio>` seeking), **not** `python -m http.server`.
- **Embedded mode:** append `?embed-mock` → loads `examples/embed-mock.js`, a reference host that
  feeds demo audio through the embedding contract so you can exercise embedded mode without a host.
- **This is a VISUAL project with no unit tests. Verification means looking at it.** After any
  change:
  1. Serve, load in a real browser (or Playwright).
  2. Console must be **0 errors / 0 warnings**.
  3. Confirm it still *reacts*: play a track, watch a BPM lock (~15–20 s) and the bass drive the
     rain. Programmatically: `window.MV.A.features` (bass / beatPulse / bpm), `window.MV.engine.mode`
     (`analyser` standalone / `host` embedded).
  4. If you verify headlessly, **screenshot and actually read the image** — a green exit code
     proves nothing for a visualizer.
- **Stale-module gotcha:** `serve.py` sends `Last-Modified`, so a browser may serve a **cached old
  ES module** after you edit. Hard-reload (Ctrl+Shift+R) or disable cache while iterating, or
  you'll debug code that isn't running.
- **Throttled-tab caveat:** the glyph song-title effects inject into the rain's compute buffers and
  may not render in a backgrounded / throttled Playwright tab. Verify the *mechanism*
  programmatically (`window.MV.A.title` state, a claimed slot) and confirm the *visual* in a real
  browser.

## Tattoos — invariants that cost real time to learn

- **One `A` bridge, neutral defaults.** `A` (reactive.js) is the only channel between app and
  renderer. Its defaults make the renderer look like vanilla upstream when nothing drives it
  (`A.reactive = false`). Don't add a second bridge.
- **Single WebGL context.** A mode switch rebuilds only the *pipeline* (cached per `version|effect`),
  never the context. Recreating the context per switch churns the GPU and was removed.
- **Phase-continuous motion.** Fall / anim speed is INTEGRATED (`A.fallPhase += speed*dt`), never
  `time * reactiveSpeed`. Multiplying a reactive speed into absolute time makes the field jump, run
  backward, or fill the screen on any speed change.
- **NaN-guard every knob.** A non-finite knob (especially `raindropLength`, which the raindrop
  shader divides by) poisons the ping-pong compute buffers → a permanent black screen that only a
  rebuild clears. `mapping.apply` hardens this; keep it.
- **Volumetric: overscan + backward-only dolly.** The 3D camera is clamped inside the overscan
  margin (never reveal the field edge) and the dolly is clamped backward-only (forward pushes
  through the near plane → black screen).
- **Reactivity is DATA, not the `map()` functions.** Each preset's `map()` is the
  equivalence-tested *source*; at runtime `mapping.apply` interprets baked **linear driver
  coefficients** (which is what lets preset changes crossfade). If you touch the driver model or a
  character `map()`, run `window.MV._verifyDrivers()` and `window.MV._verifyChannels()` and keep
  `pass: true` — those gates prove the interpreter equals the map pipeline.
- **Standalone reactivity must EQUAL embedded.** `audio-engine.js` splits *acquire* (source-specific:
  Web Audio `attach()` vs host bridge `attachHost()`) from *analyze* (shared). Keep the two sources
  producing identical features — don't let the embedded path drift.
- **Vendored edits are marked.** Every change under `vendor/matrix/` carries a `// MATRIX-VIZ`
  comment and a line in `MODIFICATIONS.md`. `grep -rn "MATRIX-VIZ" vendor/` finds them all; update
  `MODIFICATIONS.md` whenever you touch the vendored renderer.

## The embedding contract (public API — treat as stable)

- A host installs `window.matrixVizHost` **before boot**. The full spec is at the top of
  [`app/embed.js`](app/embed.js): pull-based `readAudio()` + `getNowPlaying()` / `onTrackChange()` +
  optional `getPlaybackState()`. The viz declares `window.matrixViz.capabilities = { version, ownsPlayback }`.
- Consumers use the **`hostBridge`** facade (embed.js), never the raw host — it degrades a throwing
  or missing host to calm and warns **once**. Keep that guarantee; a public component must survive a
  misbehaving host.
- **This contract is the reason the repo exists as a component** — other apps (music players)
  implement it. If you change its shape, **bump `CONTRACT_VERSION`** in `embed.js` and update
  `examples/embed-mock.js` (the reference host). Don't silently break downstream hosts.

## Per-frame discipline

`A.update` runs every rendered frame; `audio-engine.sample`, `mapping.apply`, the beat detector,
the director, and `transitions.tick` all run per-frame. Keep the hot path allocation-light — reuse
buffers/objects (the code already does). Avoid per-frame `new` / `.toFixed` / template literals in
the tick; the GC pauses they cause show up as framerate hitches.

## State + persistence

- Settings persist to `localStorage` under **`matrixviz.*`** keys (presets / palettes / director /
  session / player). **Don't rename these keys** — it orphans users' saved work.
- Presets carry a `PRESET_SCHEMA` (in `presets-store.js`). Bumping it re-seeds the built-in library
  on next load (user customs preserved). Add a built-in preset → bump the schema, or existing users
  must hit "Restore default presets" to see it.

## Adding things (full recipes in `docs/architecture.md` §9)

- **Preset:** add an entry to `PRESETS` in `app/presets.js` (a character `map/shock/hue` + `w`
  weights + optional `jumpMode` / `jumpPalette`); `buildDefaultRecords()` derives the record and it
  auto-appears. Bump `PRESET_SCHEMA`.
- **Physics effect:** `A.shader.<chan>` (reactive.js) → a global uniform in
  `vendor/matrix/js/regl/main.js` → use it in a shader (gate by `uReactive`; 0 ⇒ vanilla) → drive
  it in `mapping.apply` → add an `EFFECTS` entry. It auto-appears in the mixer.
- **Mode:** if it's a Rezmason `version`, add it to `MODES` in `app/boot.js`.

## Docs + licensing discipline

- **Keep `docs/architecture.md` honest.** If you change the architecture, update it in the same
  change — a stale architecture doc is worse than none.
- Our code (`app/`, `examples/`, `index.html`, `serve.py`) is MIT; the renderer is Rezmason/matrix
  (MIT, `vendor/matrix/LICENSE`); the demo music is **CC0**. Keep it that way: only add **CC0 or
  clearly-permissive** assets to `music/`, and update `music/CREDITS.md` + `THIRD-PARTY.md`. Never
  add copyrighted tracks — a clean, redistributable bundle is the whole point.
