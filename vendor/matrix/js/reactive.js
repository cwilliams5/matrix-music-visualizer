// MATRIX-VIZ bridge — authored for the matrix-viz prototype.
// NOT part of upstream Rezmason/matrix. This is the single shared object that
// both the vendored renderer and the app layer import. Neutral defaults mean
// the renderer behaves EXACTLY like vanilla matrix when no audio is connected
// (A.reactive=false, A.knobs empty -> uniform fns fall back to config values).
//
// The app fills A.features (audio engine), A.knobs + A.shader (presets/mappings)
// every frame via the A.update(time) hook, which the renderer calls once per frame.

export const A = {
	reactive: false, // master toggle (UI sets)
	intensity: 1.0, // global reactive intensity multiplier (0..~2)

	// MATRIX-VIZ: the mixer — the working per-effect state {effectId:{on,strength}} that the
	// mapping reads (on?strength:0). Loading a preset copies its mixer in here; the UI edits
	// it live; Save writes it back. characterId selects the knob-formula "character".
	mixer: {},
	characterId: null,

	// MATRIX-VIZ: integrated motion phases (accumulated in boot.js A.update). Fall/anim
	// speed must be INTEGRATED over time, not multiplied into absolute time — otherwise a
	// reactive speed change retroactively shifts the whole field (jumps, runs backward,
	// fills the screen). uFallPhase/uAnimPhase uniforms read these.
	fallPhase: 0,
	animPhase: 0,

	// MATRIX-VIZ: log-spaced FFT spectrum (0..1 per bin), filled by the audio engine and
	// uploaded to a 1D texture each frame. Drives "Spectrum Rain" — columns = frequencies.
	spectrum: new Float32Array(64),

	// MATRIX-VIZ (plan-transitions): a same-mode ramp->ramp palette morph. When active, holds the
	// per-frame blended gradient { active, data: Uint8Array(size*4), size, gen } that palettePass
	// uploads to its 1D palette texture in place (a true colour morph, no pipeline rebuild). null = off.
	paletteMorph: null,

	// MATRIX-VIZ (plan-transitions): the song-title splash. N concurrent SLOTS (so a new title stacks
	// instead of clobbering the in-flight one); each slot has its own mask region in the shared atlas
	// texture (uploaded via handle.setTitleMask) + its own per-slot state below. The rain passes loop over
	// the slots. `n` = slot count (must match TITLE_N in the shaders). Per slot:
	//  - Mask (burn-in): `amount[i]` (0..1 envelope) boosts glyph brightness in the RENDER pass — a
	//    screen-space overlay that fades out.
	//  - Hold-and-Rain: RAINDROP pass — `drop[i]` = 1 forces the masked cells LIT while `releaseT[i]` < 0
	//    (hold), then on release they FALL exactly like the rain (mask scrolls by the `uFallPhase` delta
	//    since `releasePhase[i]`, per-column speed) and fade in. `holdLevel[i]` 0..1 is a quick form-in.
	//  - Fall-through: `drop[i]` = 2 — spawns above the stage and falls straight through RIGID (uniform
	//    speed ⇒ exact shape preserved), never holding; `releaseT[i]` carries the scroll offset.
	title: {
		n: 8,
		amount: new Float32Array(8),
		drop: new Float32Array(8),
		releaseT: new Float32Array(8).fill(-1),
		releasePhase: new Float32Array(8),
		holdLevel: new Float32Array(8).fill(1),
	},

	// Raw audio features, refreshed each frame by the app's audio engine.
	// Band/level values normalized ~0..1 (post-AGC); beat is a 0/1 transient,
	// beatPulse a decaying 0..1 envelope. time/dt in seconds.
	features: {
		time: 0,
		dt: 0,
		level: 0,
		rms: 0,
		peak: 0,
		bass: 0,
		lowMid: 0,
		mid: 0,
		highMid: 0,
		treble: 0,
		balance: 0, // stereo balance -1 (left) .. 0 (center) .. +1 (right)
		stereoWidth: 0, // stereo width / side energy 0..1
		centroid: 0, // spectral centroid 0..1 (brightness)
		flux: 0, // spectral flux 0..1 (onset-y-ness)
		beat: 0, // 1 on the frame a beat fires, else 0
		beatPulse: 0, // decaying envelope after each beat, 0..1
		beatBass: 0, // decaying envelope after each *bass* beat (kick), 0..1
		bpm: 0,
		beatPhase: 0, // 0..1 position within the current beat (predicted)
		beatClock: 0, // seconds since the last beat (drives falling spawned drops)
		beatCount: 0, // integer beat counter (per-beat randomization seed)
		onset: 0, // decaying envelope after any onset
		energy: 0, // short-term energy 0..1
		energySlow: 0, // long-term energy 0..1 (for the director)
		playing: 0,
	},

	// Continuous render knobs. Empty by default; mapping layer writes these from
	// features each frame. Renderer uniform fns read `A.knobs.x ?? config.x`.
	knobs: {},

	// Base config knobs captured when a pipeline builds (mapping anchor / reset).
	base: {},

	// Shader-facing extras for new physics, read by global uniforms (see main.js).
	shader: {
		pulse: 0, // omni brightness pulse 0..1
		shockPhase: 0, // expanding shockwave radius driver (seconds since spawn * speed)
		shockStrength: 0, // shockwave intensity 0..1
		shockX: 0.5,
		shockY: 0.5, // shockwave origin in grid UV
		ripple: 0, // continuous ripple intensity 0..1
		cameraStrafe: 0, // 3D camera left/right translate
		cameraBoom: 0, // 3D camera up/down translate
		cameraDolly: 0, // 3D camera in/out translate (clamped to backward — forward clips near plane)
		cameraYaw: 0, // 3D camera pan left/right (radians)
		cameraPitch: 0, // 3D camera tilt up/down (radians)
		cameraShakeX: 0,
		cameraShakeY: 0,
		cameraRoll: 0, // 3D roll angle (radians)
		glyphJitter: 0, // treble-driven cycle jitter 0..1
		bassWarp: 0, // bass-driven spatial warp 0..1
		hueShift: 0, // palette hue rotation in turns (0..1)
		colorBleed: 0, // band-driven chroma bleed 0..1
		spectrum: 0, // Spectrum Rain amount 0..1 (columns lit by their frequency bin)
		windSway: 0, // 2D horizontal column sway amount 0..1
		spawn: 0, // beat-spawned-drops amount 0..1
		pulseWarp: 0, // shockwave physical displacement amount 0..1
	},

	// Replaceable per-frame hook. App sets A.update = (t) => { sample; map; direct }.
	update(time) {},
};

export default A;
