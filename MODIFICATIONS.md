# Modifications to the vendored Rezmason/matrix

`vendor/matrix/` is [Rezmason/matrix](https://github.com/Rezmason/matrix)
(MIT — `vendor/matrix/LICENSE`), vendored and then modified to make it
music-reactive and embeddable. Every change below is marked in-source with a
`// MATRIX-VIZ` comment. The goal throughout: **when no audio is connected
(`A.reactive = false`), the renderer behaves exactly like upstream.**

On vendoring, `.git`, `.gitmodules`, and the 3.5 MB `screenshot.png` were removed. The
upstream `README.md` and `TODO` were later removed too (this is a fork; attribution lives in
the repo-level `README.md`, this file, and `vendor/matrix/LICENSE`).

## New file

- **`js/reactive.js`** — the shared bridge singleton `A` that both the renderer
  and the app import. Holds `A.features` (audio analysis), `A.knobs` (live render
  parameters), `A.base` (per-mode anchors), `A.shader` (new-physics channels),
  `A.reactive` / `A.intensity`, and a replaceable `A.update(time)` hook the
  renderer calls once per frame.

## Modified files

- **`js/regl/utils.js`** — added `assetBase` + `setAssetBase()` and a
  `resolveURL()` that prefixes relative asset/shader/lib URLs (so the renderer
  can be served from `vendor/matrix/` under a different web root). `loadText` and
  `loadImage` now resolve through it. No-op when the base is empty.

- **`js/regl/main.js`**
  - import `A` + `setAssetBase`; honor `config.assetBase` for the `lib/*` loads.
  - inject the audio-reactive **global uniforms** into `makeFullScreenQuad`
    (`uBass`, `uBeat`, `uBeatPulse`, `uShockPhase`, `uHueShift`, …). REGL scope
    propagation makes them available to every nested pass shader — the same
    mechanism that already feeds `time`.
  - call `A.update(now)` once at the top of each frame.
  - **per-renderer `dimensions`** (was a module global — stale across our
    mode-switch rebuilds, which left FBOs at 1×1 = black screen).
  - **force `setSize()` on every pass** right after the pipeline is ready, so a
    freshly-built renderer always sizes its FBOs regardless of viewport-change
    detection.
  - return a `{ regl, tick, destroy, config }` handle so the app can tear down +
    rebuild on a mode switch.
  - **crossfade composite**: a `state.crossfade` path that keeps the OLD
    pipeline live while building the new one, renders BOTH to their final FBOs each frame, and
    blends them to the screen via a `mix(texA, texB, uMix)` full-screen pass. Exposed on the
    handle as `beginCrossfade(config)` / `setCrossfadeMix(0..1)` / `endCrossfade()` /
    `isCrossfading()`; the app (boot + transitions) drives the eased mix from the frame clock.
    ~2× GPU for the transition window only — outside a transition the single-pipeline
    `drawToScreen` path is unchanged.
  - **palette gradient morph**: `rekeyActive(newConfig)` re-keys the LIVE
    pipeline's cache entry to a new effect (palette) WITHOUT rebuilding — used at the end of a
    same-mode ramp↔ramp morph, where the live pipeline's palette texture was already re-coloured
    in place. Keeps the rain's compute buffers continuous (no pop); re-selecting the old palette
    later rebuilds a fresh, correctly-coloured pipeline (no cache poisoning).
  - **glyph song-title mask**: a persistent `titleMaskTex` (a rasterised
    title canvas) + `setTitleMask(canvas)` on the handle, threaded into the rain-pass build
    context; the rain render boosts glyph brightness inside the mask (see rainPass).
  - **removed the `window.ondblclick` double-click-to-fullscreen-the-canvas.** Upstream made any
    double-click anywhere fullscreen *only the `<canvas>`* (hiding the whole UI) — which fired while
    clicking around the controls and conflicted with the app's own `F`-key fullscreen. Fullscreen is
    now owned by the app (`app/fullscreen.js`): a single document-fullscreen mode entered via `F` or a
    double-click bound to the **stage** only. Mirrored in the unused `js/webgpu/main.js` twin.

- **`js/regl/rainPass.js`** — import `A`; convert the continuous knob uniforms
  (`fallSpeed`, `cycleSpeed`, `animationSpeed`, `raindropLength`,
  `brightnessDecay`, `baseBrightness`, `baseContrast`) from static values to
  functions reading `A.knobs.x ?? config.x`. Added the **volumetric camera ride**
  in the execute step: clone the setup transform into `baseTransform`, then each
  frame copy it and apply only small x/y shake + z-roll from `A.shader` (no
  z-dolly — that pushed the field across the near plane and blacked out 3D).
  Also **seeds the symbol double-buffer** with random glyphs at build: the shader's
  random-glyph seed only fires on `tick <= 1` (a global counter), so a pipeline rebuilt
  on our persistent context would otherwise start at glyph 0 (`*`) and slowly cycle in.
  Reuses hoisted draw-call prop objects (`passProps`/`clearProps`/`renderProps`) in the
  per-frame execute loop instead of fresh literals — regl reads draw props synchronously, and
  transform/screenSize/camera were already reused references, so it's behavior-identical.
  Also: the render command takes `uTitleMask` (the title atlas) + `uTitleAmount` +
  `uResolution`, and the **raindrop** command takes the atlas + `uTitleDrop` / `uTitleReleaseT` /
  `uTitleReleasePhase` / `uTitleHoldLevel` / `uTitleGHTW` for the glyph song titles. The per-slot fields
  are `Float32Array(TITLE_N)` uniform arrays (`A.title.*`) — one entry per stacking title slot.

- **`shaders/glsl/rainPass.frag.glsl`** — the "Mask" (burn-in) glyph titles: where a
  title mask is lit (sampled in SCREEN space via `gl_FragCoord / uResolution`, so it reads in both 2D and
  volumetric 3D), boost the glyph's base brightness. Loops over `TITLE_N` slots (`uTitleAmount[N]`), each
  sampling its own band of the shared **atlas** mask — so Mask titles STACK too.

- **`shaders/glsl/rainPass.raindrop.frag.glsl`** — the Glyph "Hold and Rain" / "Fall"
  titles, injected into the rain SIM. Loops over `TITLE_N` concurrent **slots** (uniform arrays
  `uTitleDrop[N]` / `uTitleReleaseT[N]` / `uTitleReleasePhase[N]` / `uTitleHoldLevel[N]`), each sampling
  its own horizontal band of the shared **atlas** mask — so titles STACK (a new one claims a slot, never
  clobbers). Per slot: `drop`=1 holds the cells LIT (`releaseT<0`; glyphs keep cycling, only the lit
  STATE is held) then on release they FALL exactly like the rain (mask scrolls up by the `uFallPhase`
  delta × the column's own speed) and fade; `drop`=2 is the rigid **fall-through** (uniform speed, exact
  shape, `releaseT` = the scroll offset). `uTitleGHTW` maps grid-row → on-screen-Y. Grid-space ⇒ reads in
  2D (the app routes non-grid scenes — volumetric/polar/slanted — to the burn-in).

- **`js/regl/bloomPass.js`** — import `A`; `bloomStrength` becomes
  `() => A.knobs.bloomStrength ?? config.bloomStrength`.

- **`js/regl/palettePass.js`** — import `A`; `cursorIntensity` / `glintIntensity`
  become reactive functions; pass new `hueShift` + `colorBleed` uniforms to the
  palette shader. Also: factored the gradient baker into
  `bakePaletteColors` + an exported `bakePaletteRGBA(entries, size)` (a flat Uint8 buffer),
  and the execute step re-uploads the pass's 1D palette texture in place from
  `A.paletteMorph` (the per-frame blended gradient) during a same-mode ramp↔ramp morph.

- **`shaders/glsl/rainPass.effect.frag.glsl`** — new `getBeatShock()` (an
  expanding ring of brightness from `uShockOrigin` at radius `uShockPhase`) and
  `getBassGlow()` (center bloom from `uPulse`), layered into the existing
  multiply/add effect channels, gated by `uReactive`.

- **`shaders/glsl/palettePass.frag.glsl`** — `hueRotate()` of the final color by
  `uHueShift`, a `uColorBleed` chroma boost, and a `uBassWarp` radial zoom of the
  sample UV. All gated by `uReactive`.

- **`shaders/glsl/rainPass.symbol.frag.glsl`** — `uGlyphJitter * (uTreble/uOnset)`
  speeds glyph cycling and triggers a scramble burst on strong onsets.

## Not modified

`config.js`, `camera.js`, and `colorToRGB.js` are untouched. Several render shaders and
passes were modified in later sessions beyond what's itemized above — the authoritative list of
vendored edits is every `// MATRIX-VIZ` marker in `vendor/matrix/` (grep for it); this file
captures the rationale for the load-bearing ones.
