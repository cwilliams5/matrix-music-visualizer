// matrix-music-viz — reactive mapping engine + preset library.
//
// Each frame (registered AFTER the beat detector) the engine:
//   1. resets A.knobs to A.base and zeroes the shader physics channels,
//   2. if A.reactive: runs the active preset's map() (writes knobs from features),
//      then applies the UNIVERSAL physics drivers (beat-shock clock, bass pulse,
//      glyph jitter, bass warp, spectral hue, 3D camera) scaled by the preset's
//      weights, the per-physics UI toggles, and A.intensity.
//
// A preset = { id, name, desc, w{weights}, shock{}, hue{}, map(ctx) }. Presets only
// need to express what's distinctive; the engine handles the common machinery.

import { A } from "../vendor/matrix/js/reactive.js";

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothK = (dt, tau) => 1 - Math.exp(-dt / tau);

// ---- the effect registry: every reactive effect the mixer controls ----------
// group: 'physics' (shader effects) | 'camera' (3D parts) | 'motion' (rain knobs).
// def: the strength used when you switch an effect ON that the active preset left at 0.
export const EFFECTS = [
	{ id: "shock", group: "physics", label: "Beat shockwaves", def: 1.0, tip: "An expanding ring of light radiates through the glyph grid on every beat (origin set per-preset in Advanced)." },
	{ id: "pulse", group: "physics", label: "Bass pulse glow", def: 1.0, tip: "A soft radial bloom that swells with the kick drum." },
	{ id: "jitter", group: "physics", label: "Treble glyph jitter", def: 0.8, tip: "Glyphs scramble and cycle faster on treble transients." },
	{ id: "warp", group: "physics", label: "Bass spatial warp", def: 0.6, tip: "A subtle zoom-breathe of the whole field on the low end." },
	{ id: "hue", group: "physics", label: "Spectral hue shift", def: 1.0, tip: "Rotates the palette's hue with the spectrum's brightness, plus chroma bleed between glyphs (hue mode set per-preset in Advanced)." },
	{ id: "spectrum", group: "physics", label: "Spectrum rain", def: 1.0, tip: "Maps columns to frequency bands — bass at the left, treble at the right — turning the rain into a live spectrum analyzer." },
	{ id: "windSway", group: "physics", label: "Wind sway", def: 0.9, tip: "Columns sway horizontally with the mids and stereo width, like wind through the rain." },
	{ id: "spawn", group: "physics", label: "Beat-spawned drops", def: 0.8, tip: "Fresh drops burst from the top in random columns on each beat." },
	{ id: "pulseWarp", group: "physics", label: "Shockwave warp", def: 1.0, tip: "The beat shockwave physically ripples and bends the rain, not just brightens it." },
	{ id: "cameraDrift", group: "camera", label: "Cinematic drift", def: 1.2, tip: "Slow cinematic camera LFOs drift through the 3D field. Volumetric modes only." },
	{ id: "cameraPan", group: "camera", label: "Stereo pan", def: 1.2, tip: "Stereo balance steers the 3D camera side to side. Volumetric modes only." },
	{ id: "cameraBass", group: "camera", label: "Bass boom / dolly", def: 1.2, tip: "Bass booms and dollies the 3D camera in and out. Volumetric modes only." },
	{ id: "cameraShake", group: "camera", label: "Beat shake", def: 1.2, tip: "Beats kick and shake the 3D camera. Volumetric modes only." },
	{ id: "fall", group: "motion", label: "Fall speed", def: 1.0, tip: "Audio energy drives how fast the rain falls." },
	{ id: "cycle", group: "motion", label: "Glyph cycle speed", def: 1.0, tip: "Treble and onsets drive how fast glyphs change character." },
	{ id: "anim", group: "motion", label: "Animation speed", def: 1.0, tip: "Audio energy drives the overall animation / forward speed." },
	{ id: "bright", group: "motion", label: "Brightness flash", def: 1.0, tip: "Beats flash the base brightness and contrast." },
	{ id: "bloom", group: "motion", label: "Bloom glow", def: 1.0, tip: "Bass swells the bloom glow around bright glyphs." },
	{ id: "cursor", group: "motion", label: "Cursor intensity", def: 1.0, tip: "The leading 'head' glyphs sit dimmer at rest and flare on onsets (also drives the glint)." },
];
export const EFFECT_IDS = EFFECTS.map((e) => e.id);
export const EFFECT_DEF = Object.fromEntries(EFFECTS.map((e) => [e.id, e.def]));

// knob effect id -> the A.knobs keys it scales
const KNOB_KEYS = {
	fall: ["fallSpeed"],
	cycle: ["cycleSpeed"],
	anim: ["animationSpeed"],
	bright: ["baseBrightness", "baseContrast", "brightnessDecay"],
	bloom: ["bloomStrength"],
	cursor: ["cursorIntensity", "glintIntensity"],
};

// Generic per-knob reactivity applied to ALL knobs before the preset's character map.
// This is what a knob does when you enable it on a preset that didn't drive it, so every
// toggle is live everywhere; the character map then overrides a preset's signature knobs.
function DEFAULT_KNOB_MAP({ f, k, base, I }) {
	k.fallSpeed = base.fallSpeed * (1 + f.energy * 0.4 * I);
	k.cycleSpeed = base.cycleSpeed * (1 + (f.treble * 1.6 + f.onset * 1.4) * I);
	k.animationSpeed = base.animationSpeed * (1 + f.energy * 0.4 * I);
	// raindropLength is intentionally NOT reactive — it stays at the mode base. A reactive raindrop
	// length was built and then CUT: this renderer applies ONE global length to the whole field, so
	// modulating it reshapes every column in unison -> a full-field strobe. A real fix needs
	// per-column length held from spawn (a particle-ish refactor); not worth it. See progress.md.
	k.baseBrightness = base.baseBrightness + f.beatPulse * 0.4 * I;
	k.baseContrast = base.baseContrast * (1 + f.beatBass * 0.2 * I);
	k.bloomStrength = clamp(base.bloomStrength * (1 + f.bass * 0.6 * I), 0, 1);
	// A1 — Cursor Intensity: dim-baseline-then-flare. With the effect ON the head sits DIMMER at
	// rest (~0.5× base) so onsets visibly POP it (~1.7× at onset 1), instead of just brightening the
	// already-brightest glyph (invisible). The mixer scales base→mapped, so OFF (mx 0) stays vanilla.
	// glint gets the same shape — it was never driven before, leaving half the effect inert.
	k.cursorIntensity = base.cursorIntensity * (0.5 + f.onset * 1.2 * I);
	k.glintIntensity = base.glintIntensity * (0.5 + f.onset * 1.2 * I);
}

// ---- driver model (preset-authoring P2): reactivity as DATA ------------------
// Every character map() is a LINEAR feature-mix: mul knobs = base*(scale + I*Σ feat*a),
// add knobs = base + I*(const + Σ feat*a). We EXTRACT those coefficients by probing the
// (DEFAULT_KNOB_MAP -> character.map) pipeline in its linear region, bake them onto each preset
// record as `drivers` data, and the runtime interprets the DATA instead of calling map().
// verifyDriverEquivalence() proves interpreter == old pipeline before anything relies on it.
// (PRESETS/map() stay as the equivalence-tested SOURCE for the default drivers, not a runtime path.)

// per-knob: mode (mul/add) + output clamp. Only bloom + brightnessDecay actually clamp at realistic
// bases (matches the inline map clamps + the runtime brightnessDecay hardening).
const KNOB_META = {
	fallSpeed: { mode: "mul", clamp: null },
	cycleSpeed: { mode: "mul", clamp: null },
	animationSpeed: { mode: "mul", clamp: null },
	baseBrightness: { mode: "add", clamp: null },
	baseContrast: { mode: "mul", clamp: null },
	brightnessDecay: { mode: "mul", clamp: [0, 1] },
	bloomStrength: { mode: "mul", clamp: [0, 1] },
	cursorIntensity: { mode: "mul", clamp: null },
	glintIntensity: { mode: "mul", clamp: null }, // P3: now a driver knob (was never driven — stays base by default)
};
const DRIVER_KNOBS = Object.keys(KNOB_META);
export const DRIVER_FEATURES = ["energy", "level", "bass", "lowMid", "mid", "highMid", "treble", "beatPulse", "beatBass", "onset", "centroid", "flux", "stereoWidth", "balance", "tempo"];
const tempoFeat = (f) => (f.bpm > 0 ? f.bpm / 120 - 1 : 0); // 0 at 120bpm / undetected

const PROBE_BASE = { fallSpeed: 0.4, cycleSpeed: 0.4, animationSpeed: 0.4, baseBrightness: 0.4, baseContrast: 0.4, brightnessDecay: 0.3, bloomStrength: 0.3, cursorIntensity: 0.4, glintIntensity: 0.4 };
const PROBE_D = 0.05;
function zeroFeatures() {
	const f = {};
	for (const name of DRIVER_FEATURES) f[name] = 0;
	f.bpm = 0;
	return f;
}
function probePipeline(character, feats, I) {
	const base = { ...PROBE_BASE };
	const k = { ...base };
	const ctx = { f: feats, k, base, dt: 0.016, I };
	DEFAULT_KNOB_MAP(ctx);
	try {
		character.map(ctx);
	} catch (e) {}
	return k;
}

// Extract the linear driver coefficients for one character (exact for linear maps).
export function extractDrivers(character) {
	const drivers = {};
	const k0 = probePipeline(character, zeroFeatures(), 1); // I=1, all features 0 -> scale/const
	for (const knob of DRIVER_KNOBS) {
		const meta = KNOB_META[knob];
		const base = PROBE_BASE[knob];
		const d = { mode: meta.mode, mix: [] };
		if (meta.mode === "mul") d.scale = +(k0[knob] / base).toFixed(6);
		else d.const = +(k0[knob] - base).toFixed(6);
		for (const name of DRIVER_FEATURES) {
			const f1 = zeroFeatures();
			if (name === "tempo") f1.bpm = 120 * (1 + PROBE_D);
			else f1[name] = PROBE_D;
			const k1 = probePipeline(character, f1, 1);
			const a = meta.mode === "mul" ? (k1[knob] / base - d.scale) / PROBE_D : (k1[knob] - k0[knob]) / PROBE_D;
			if (Math.abs(a) > 1e-9) d.mix.push({ f: name, a: +a.toFixed(6) });
		}
		drivers[knob] = d;
	}
	return drivers;
}

// Fill in any knob a (possibly older) drivers object is missing, with a no-op driver (stays at base)
// — so a newly-added knob (e.g. glintIntensity) shows up editable everywhere without changing behavior.
export function completeDrivers(drivers) {
	const d = drivers ? { ...drivers } : {};
	for (const knob of DRIVER_KNOBS) {
		if (!d[knob]) d[knob] = KNOB_META[knob].mode === "add" ? { mode: "add", const: 0, mix: [] } : { mode: "mul", scale: 1, mix: [] };
	}
	return d;
}

// Interpret driver data into knob values — the runtime replacement for map().
export function applyDrivers(drivers, base, f, I, k) {
	if (!drivers) return;
	const tempo = tempoFeat(f);
	for (const knob in drivers) {
		const d = drivers[knob];
		const mix = d.mix || [];
		let sum = 0;
		for (let i = 0; i < mix.length; i++) {
			const name = mix[i].f;
			const v = name === "tempo" ? tempo : name === "one" ? 1 : f[name] || 0;
			sum += v * mix[i].a;
		}
		let val = d.mode === "add" ? base[knob] + I * ((d.const || 0) + sum) : base[knob] * ((d.scale ?? 1) + I * sum);
		const c = KNOB_META[knob] && KNOB_META[knob].clamp;
		if (c) val = val < c[0] ? c[0] : val > c[1] ? c[1] : val;
		k[knob] = val;
	}
}

// Equivalence gate — interpreter(extracted drivers) must match the old DEFAULT+map pipeline.
export function verifyDriverEquivalence(samples = 300) {
	let maxErr = 0;
	let worst = null;
	const baseSets = [
		{ fallSpeed: 0.3, cycleSpeed: 0.2, animationSpeed: 1, baseBrightness: 0.5, baseContrast: 1, brightnessDecay: 0.3, bloomStrength: 0.6, cursorIntensity: 1, glintIntensity: 1 },
		{ fallSpeed: 0.5, cycleSpeed: 0.5, animationSpeed: 0.8, baseBrightness: 0.7, baseContrast: 1.2, brightnessDecay: 0.5, bloomStrength: 0.8, cursorIntensity: 1.2, glintIntensity: 1.2 },
	];
	for (const p of PRESETS) {
		const drivers = extractDrivers(p);
		for (let s = 0; s < samples; s++) {
			const f = {};
			for (const name of DRIVER_FEATURES) f[name] = pseudoRand(s * 7.3 + name.length * 1.7 + p.id.length);
			f.bpm = pseudoRand(s * 2.1 + 0.5) > 0.3 ? 60 + 180 * pseudoRand(s * 5.5) : 0;
			const I = 0.1 + 1.9 * pseudoRand(s * 3.9 + 1);
			const base = baseSets[s % baseSets.length];
			const kOld = { ...base };
			DEFAULT_KNOB_MAP({ f, k: kOld, base, dt: 0.016, I });
			try {
				p.map({ f, k: kOld, base, dt: 0.016, I });
			} catch (e) {}
			if (kOld.brightnessDecay < 0) kOld.brightnessDecay = 0; // runtime hardening the old path relies on
			else if (kOld.brightnessDecay > 1) kOld.brightnessDecay = 1;
			const kNew = { ...base };
			applyDrivers(drivers, base, f, I, kNew);
			for (const knob of DRIVER_KNOBS) {
				const e = Math.abs(kOld[knob] - kNew[knob]);
				if (e > maxErr) {
					maxErr = e;
					worst = { preset: p.id, knob, kOld: kOld[knob], kNew: kNew[knob] };
				}
			}
		}
	}
	return { pass: maxErr < 1e-6, maxErr, worst };
}

// A fresh, fully-random driver set (respects each knob's baked mode/clamp) — 1–2 random feature terms
// per knob. Used by the generative Random preset to span the whole driver space (not one character).
export function randomDrivers() {
	const drivers = {};
	for (const knob of DRIVER_KNOBS) {
		const meta = KNOB_META[knob];
		const d = { mode: meta.mode, mix: [] };
		if (meta.mode === "mul") d.scale = 1;
		else d.const = 0;
		const used = new Set();
		const nTerms = 1 + (Math.random() < 0.4 ? 1 : 0);
		for (let i = 0; i < nTerms; i++) {
			const f = DRIVER_FEATURES[Math.floor(Math.random() * DRIVER_FEATURES.length)];
			if (used.has(f)) continue;
			used.add(f);
			const a = meta.mode === "add" ? +(0.15 + Math.random() * 0.5).toFixed(2) : +(0.2 + Math.random() * 1.3).toFixed(2);
			d.mix.push({ f, a });
		}
		drivers[knob] = d;
	}
	return drivers;
}

// ---- channel drivers (preset-authoring P3): the THREE physics channels that are linear --------
// feature-mixes — pulse / bassWarp / windSway. Unlike the knobs these are NOT a uniform model: each
// has its own FIXED output FORM (its render character — the clamps, the I-gate or not, the const
// offset, the hard cap), and only the feature MIX (the Σ) is editable per-preset. The form is baked
// metadata (like KNOB_META's mode/clamp), the mix is data. `effect` = the mixer id that gates/scales
// it (note bassWarp ← the "warp" mixer row). Forms are the original mapping.apply arithmetic factored
// to take a precomputed `sum`, so default mixes reproduce the old behavior EXACTLY (verifier proves it).
const CHANNEL_META = {
	pulse: {
		effect: "pulse",
		defaultMix: [{ f: "beatBass", a: 0.6 }, { f: "bass", a: 0.4 }],
		form: (mx, I, sum) => clamp(mx * I * sum, 0, 2),
	},
	bassWarp: {
		effect: "warp",
		defaultMix: [{ f: "bass", a: 1.2 }],
		form: (mx, I, sum) => clamp(mx * I * clamp(sum, 0, 1), 0, 1.2),
	},
	windSway: {
		effect: "windSway",
		defaultMix: [{ f: "mid", a: 0.8 }, { f: "stereoWidth", a: 0.3 }],
		form: (mx, I, sum) => mx * Math.min(1.5, 0.4 + sum), // no I, const offset, hard cap, mx OUTSIDE the cap
	},
};
export const CHANNEL_IDS = Object.keys(CHANNEL_META);
export const CHANNEL_LABELS = { pulse: "Bass pulse glow", bassWarp: "Bass spatial warp", windSway: "Wind sway" };

const channelMix = (ch) => CHANNEL_META[ch].defaultMix.map((t) => ({ ...t }));

// fresh default channel drivers (the shipped behavior, as editable data — same for every built-in,
// since the channel forms were GLOBAL before authoring; a custom preset can now diverge per-channel).
export function defaultChannelDrivers() {
	const d = {};
	for (const ch of CHANNEL_IDS) d[ch] = { mix: channelMix(ch) };
	return d;
}

// backfill any channel a (possibly older) record is missing with its default mix — so an existing
// localStorage preset gains the editable channels without changing behavior.
export function completeChannelDrivers(cd) {
	const d = cd ? { ...cd } : {};
	for (const ch of CHANNEL_IDS) {
		if (!d[ch] || !Array.isArray(d[ch].mix)) d[ch] = { mix: channelMix(ch) };
	}
	return d;
}

// a fully-random channel mix per channel (1–2 features) — used by the generative Random preset so the
// physics channels join the rolled driver space. The per-channel form caps keep it bounded + safe.
export function randomChannelDrivers() {
	const d = {};
	for (const ch of CHANNEL_IDS) {
		const used = new Set();
		const mix = [];
		const nTerms = 1 + (Math.random() < 0.5 ? 1 : 0);
		for (let i = 0; i < nTerms; i++) {
			const fn = DRIVER_FEATURES[Math.floor(Math.random() * DRIVER_FEATURES.length)];
			if (used.has(fn)) continue;
			used.add(fn);
			mix.push({ f: fn, a: +(0.3 + Math.random()).toFixed(2) });
		}
		d[ch] = { mix: mix.length ? mix : channelMix(ch) };
	}
	return d;
}

// Interpret channel-driver data into the three shader channels — runtime replacement for the inline
// pulse/bassWarp/windSway formulas. `mxOf(id)` = the mixer strength getter; `s` = A.shader.
export function applyChannelDrivers(channelDrivers, f, I, mxOf, s) {
	const cd = channelDrivers || {};
	const tempo = tempoFeat(f);
	for (let c = 0; c < CHANNEL_IDS.length; c++) {
		const ch = CHANNEL_IDS[c];
		const meta = CHANNEL_META[ch];
		const d = cd[ch];
		const mix = d && Array.isArray(d.mix) ? d.mix : meta.defaultMix;
		let sum = 0;
		for (let i = 0; i < mix.length; i++) {
			const name = mix[i].f;
			const v = name === "tempo" ? tempo : name === "one" ? 1 : f[name] || 0;
			sum += v * mix[i].a;
		}
		s[ch] = meta.form(mxOf(meta.effect), I, sum);
	}
}

// Equivalence gate — applyChannelDrivers(default mixes) must match the OLD inline formulas exactly.
// Proves the form functions are faithful transcriptions before the runtime relies on them.
export function verifyChannelEquivalence(samples = 400) {
	let maxErr = 0;
	let worst = null;
	const cd = defaultChannelDrivers();
	for (let s = 0; s < samples; s++) {
		const f = {};
		for (const name of DRIVER_FEATURES) f[name] = pseudoRand(s * 7.3 + name.length * 1.7);
		f.bpm = pseudoRand(s * 2.1 + 0.5) > 0.3 ? 60 + 180 * pseudoRand(s * 5.5) : 0;
		const I = 0.1 + 1.9 * pseudoRand(s * 3.9 + 1);
		const mxVals = { pulse: 2 * pseudoRand(s * 1.1), warp: 2 * pseudoRand(s * 1.3 + 2), windSway: 2 * pseudoRand(s * 1.7 + 4) };
		const mxOf = (id) => mxVals[id] || 0;
		const old = {
			pulse: clamp(mxOf("pulse") * I * (f.beatBass * 0.6 + f.bass * 0.4), 0, 2),
			bassWarp: clamp(mxOf("warp") * I * clamp(f.bass * 1.2, 0, 1), 0, 1.2),
			windSway: mxOf("windSway") * Math.min(1.5, 0.4 + f.mid * 0.8 + f.stereoWidth * 0.3),
		};
		const sNew = {};
		applyChannelDrivers(cd, f, I, mxOf, sNew);
		for (const ch of CHANNEL_IDS) {
			const e = Math.abs(old[ch] - sNew[ch]);
			if (e > maxErr) {
				maxErr = e;
				worst = { channel: ch, old: old[ch], neu: sNew[ch] };
			}
		}
	}
	return { pass: maxErr < 1e-9, maxErr, worst };
}

// ---- transition blending (plan-transitions P1): lerp two preset "looks" ------
// A "look" bundles everything a preset contributes to the mapping: the mixer, the per-knob +
// per-channel driver data, the character id, shock/hue config, and intensity. The mapping reads
// its look through mapping._lookProvider (installed by the transition controller), so a same-mode
// preset change can crossfade the PARAMETERS on the one live pipeline — no second pipeline, no GPU.
//
// Why blending the DATA (coefficients) equals blending the OUTPUT: every driver knob/channel is a
// LINEAR feature-mix (knob = base*(scale + I*Σ feat*a)); lerping the coefficients of two linear maps
// lerps their outputs (the same per-frame features feed both). Mixer gates lerp as on?strength:0 so
// A's effects fade OUT as B's fade IN — both presets' rules are partially live mid-blend (the magic).

const blendNum = (a, b, t) => a + (b - a) * t;

// Deep, stable snapshot of a look (the FROM side — captured before setActive overwrites A.*).
export function snapshotLook(src = A) {
	return {
		mixer: src.mixer ? JSON.parse(JSON.stringify(src.mixer)) : {},
		drivers: completeDrivers(src.drivers ? JSON.parse(JSON.stringify(src.drivers)) : null),
		channelDrivers: completeChannelDrivers(src.channelDrivers ? JSON.parse(JSON.stringify(src.channelDrivers)) : null),
		characterId: src.characterId || null,
		shockCfg: src.shockCfg ? { ...src.shockCfg } : null,
		hueCfg: src.hueCfg ? { ...src.hueCfg } : null,
		intensity: src.intensity ?? 1,
	};
}

// The live look (the TO side) — reused object, references into A (read fresh each frame, no copy).
const _liveLook = { mixer: null, drivers: null, channelDrivers: null, characterId: null, shockCfg: null, hueCfg: null, intensity: 1 };
export function liveLook() {
	_liveLook.mixer = A.mixer;
	_liveLook.drivers = A.drivers;
	_liveLook.channelDrivers = A.channelDrivers;
	_liveLook.characterId = A.characterId;
	_liveLook.shockCfg = A.shockCfg;
	_liveLook.hueCfg = A.hueCfg;
	_liveLook.intensity = A.intensity ?? 1;
	return _liveLook;
}

function blendMixer(mA, mB, t) {
	const out = {};
	for (const id of EFFECT_IDS) {
		const ea = mA && mA[id];
		const eb = mB && mB[id];
		const ga = ea && ea.on ? ea.strength : 0;
		const gb = eb && eb.on ? eb.strength : 0;
		const g = ga + (gb - ga) * t;
		out[id] = { on: g > 1e-4, strength: g };
	}
	return out;
}

// union the feature terms of two driver mixes, lerp each coefficient (a feature missing on one side
// is 0 there — so its term grows in / fades out across the blend).
function blendMix(mixA, mixB, t) {
	const map = new Map();
	for (const term of mixA || []) map.set(term.f, [term.a, 0]);
	for (const term of mixB || []) {
		const e = map.get(term.f);
		if (e) e[1] = term.a;
		else map.set(term.f, [0, term.a]);
	}
	const mix = [];
	for (const [f, ab] of map) {
		const a = ab[0] + (ab[1] - ab[0]) * t;
		if (Math.abs(a) > 1e-9) mix.push({ f, a });
	}
	return mix;
}

function blendDrivers(dA, dB, t) {
	const a = completeDrivers(dA);
	const b = completeDrivers(dB);
	const out = {};
	for (const knob of DRIVER_KNOBS) {
		const da = a[knob];
		const db = b[knob];
		const d = { mode: db.mode, mix: blendMix(da.mix, db.mix, t) };
		if (db.mode === "add") d.const = blendNum(da.const ?? 0, db.const ?? 0, t);
		else d.scale = blendNum(da.scale ?? 1, db.scale ?? 1, t);
		out[knob] = d;
	}
	return out;
}

function blendChannelDrivers(cA, cB, t) {
	const a = completeChannelDrivers(cA);
	const b = completeChannelDrivers(cB);
	const out = {};
	for (const ch of CHANNEL_IDS) out[ch] = { mix: blendMix(a[ch].mix, b[ch].mix, t) };
	return out;
}

// enum fields (shock origin, hue mode) DON'T snap to B — they hand over at the midpoint so the deepest
// mix shows A's behavior fading and B's arriving; numeric fields lerp.
function blendShock(a, b, t) {
	const aa = a || {};
	const bb = b || {};
	return {
		origin: t < 0.5 ? aa.origin || bb.origin || "center" : bb.origin || aa.origin || "center",
		speed: blendNum(aa.speed ?? 0.9, bb.speed ?? 0.9, t),
		decay: blendNum(aa.decay ?? 0.45, bb.decay ?? 0.45, t),
		gain: blendNum(aa.gain ?? 0.8, bb.gain ?? 0.8, t),
	};
}
function blendHue(a, b, t) {
	const aa = a || {};
	const bb = b || {};
	return {
		mode: t < 0.5 ? aa.mode || bb.mode || "none" : bb.mode || aa.mode || "none",
		rate: blendNum(aa.rate ?? 0.02, bb.rate ?? 0.02, t),
		spread: blendNum(aa.spread ?? 0.5, bb.spread ?? 0.5, t),
		bleed: blendNum(aa.bleed ?? 0.5, bb.bleed ?? 0.5, t),
	};
}

// Blend two looks at eased t (0 = A, 1 = B). Reused result object (per-frame call during a transition).
// opt = { colorT, motionT } staggers the groups (Complex/Random types): the COLOUR group (shock origin
// + hue) and the MOTION/reactivity group (mixer + drivers + intensity) get their own eased progress, so
// e.g. the colours lead and the reactivity lags. Omitted -> every group uses the single t.
const _blendLook = { mixer: null, drivers: null, channelDrivers: null, characterId: null, shockCfg: null, hueCfg: null, intensity: 1 };
export function blendLook(LA, LB, t, opt) {
	const mt = opt ? opt.motionT : t; // motion / reactivity group
	const ct = opt ? opt.colorT : t; // colour group (shock origin + hue)
	_blendLook.mixer = blendMixer(LA.mixer, LB.mixer, mt);
	_blendLook.drivers = blendDrivers(LA.drivers, LB.drivers, mt);
	_blendLook.channelDrivers = blendChannelDrivers(LA.channelDrivers, LB.channelDrivers, mt);
	_blendLook.characterId = t < 0.5 ? LA.characterId : LB.characterId;
	_blendLook.shockCfg = blendShock(LA.shockCfg, LB.shockCfg, ct);
	_blendLook.hueCfg = blendHue(LA.hueCfg, LB.hueCfg, ct);
	_blendLook.intensity = blendNum(LA.intensity ?? 1, LB.intensity ?? 1, mt);
	return _blendLook;
}

// ---- preset library --------------------------------------------------------
// w: weights 0..~2 for the universal drivers.
// shock: { origin: 'center'|'random'|'bass'|'top', speed, decay, gain }
// hue: { mode: 'none'|'centroid'|'drift'|'beat'|'bass', rate, spread, bleed }
// map(ctx): ctx = { f, k, base, dt, I }. Writes k.* (knobs). f = A.features.

export const PRESETS = [
	{
		id: "pulse-rain",
		name: "Pulse Rain",
		jumpMode: "classic",
		jumpPalette: "plain",
		desc: "Beats flash brightness, bass swells the bloom — restrained and iconic.",
		w: { shock: 0.6, pulse: 1.0, jitter: 0.3, warp: 0.25, hue: 0, camera: 0.6 },
		shock: { origin: "center", speed: 0.85, decay: 0.45, gain: 0.8 },
		hue: { mode: "none" },
		map({ f, k, base, I }) {
			k.baseBrightness = base.baseBrightness + (f.beatPulse * 0.55 + f.level * 0.15) * I;
			k.baseContrast = base.baseContrast * (1 + f.beatBass * 0.2 * I);
			k.bloomStrength = clamp(base.bloomStrength * (1 + f.bass * 0.6 * I), 0, 1);
			k.cursorIntensity = base.cursorIntensity * (1 + f.onset * 0.6 * I);
			k.fallSpeed = base.fallSpeed * (1 + f.energy * 0.3 * I);
		},
	},
	{
		id: "tempo-drive",
		name: "Tempo Drive",
		desc: "The rain races with the music: tempo + energy push fall speed, treble drives glyph cycling.",
		w: { shock: 0.4, pulse: 0.7, jitter: 0.8, warp: 0.3, hue: 0, camera: 1.0 },
		shock: { origin: "center", speed: 1.0, decay: 0.4, gain: 0.6 },
		hue: { mode: "none" },
		map({ f, k, base, I }) {
			const bpmFactor = f.bpm > 0 ? f.bpm / 120 : 1;
			// Additive from base: quiet ~= normal speed, faster with tempo + energy. Now that
			// fall is phase-continuous this just reads as "the rain speeds up", no jumps.
			k.fallSpeed = clamp(base.fallSpeed * (1 + (bpmFactor - 1) * 0.5 * I + f.energy * 0.6 * I), 0.05, 2.0);
			k.animationSpeed = base.animationSpeed * (1 + f.energy * 0.4 * I);
			k.cycleSpeed = base.cycleSpeed * (1 + (f.treble * 2 + f.onset * 2) * I);
			k.baseBrightness = base.baseBrightness + f.beatPulse * 0.3 * I;
		},
	},
	{
		id: "spectrum-bleed",
		name: "Spectrum Bleed",
		desc: "Color follows the spectrum — brightness shifts the hue, transients scramble glyphs.",
		w: { shock: 0.4, pulse: 0.6, jitter: 1.0, warp: 0.3, hue: 1.0, camera: 0.5 },
		shock: { origin: "random", speed: 0.9, decay: 0.4, gain: 0.6 },
		hue: { mode: "centroid", spread: 0.6, bleed: 0.7 },
		map({ f, k, base, I }) {
			k.baseBrightness = base.baseBrightness + f.beatPulse * 0.35 * I;
			k.cycleSpeed = base.cycleSpeed * (1 + f.treble * 1.5 * I);
			k.bloomStrength = clamp(base.bloomStrength * (1 + f.mid * 0.4 * I), 0, 1);
		},
	},
	{
		id: "spectrum-rain",
		name: "Spectrum Rain",
		jumpPalette: "spectrum",
		desc: "The rain becomes a live frequency display — each column lit by its own band (bass at the left, treble at the right). A spectrum analyzer, falling.",
		w: { shock: 0.2, pulse: 0.3, jitter: 0.5, warp: 0.2, hue: 0.7, camera: 0.5, spectrum: 1.0 },
		shock: { origin: "center", speed: 0.8, decay: 0.5, gain: 0.4 },
		hue: { mode: "centroid", spread: 0.7, bleed: 0.6 },
		map({ f, k, base, I }) {
			k.fallSpeed = base.fallSpeed * (0.7 + f.energy * 0.3 * I);
			k.cycleSpeed = base.cycleSpeed * (1 + f.treble * 1.2 * I);
			k.baseBrightness = base.baseBrightness + 0.1 * I;
			k.brightnessDecay = clamp(base.brightnessDecay * 1.3, 0, 1); // snappier: columns track their band
		},
	},
	{
		id: "bass-quake",
		name: "Bass Quake",
		jumpPalette: "fire",
		desc: "Low-end rules: kicks lengthen the drops, warp the screen, and fire shockwaves from below.",
		w: { shock: 1.3, pulse: 1.2, jitter: 0.2, warp: 1.0, hue: 0, camera: 1.0 },
		shock: { origin: "bass", speed: 1.1, decay: 0.55, gain: 1.2 },
		hue: { mode: "none" },
		map({ f, k, base, I }) {
			k.baseBrightness = base.baseBrightness + f.beatBass * 0.5 * I;
			k.bloomStrength = clamp(base.bloomStrength * (1 + f.bass * 0.9 * I), 0, 1);
			k.fallSpeed = base.fallSpeed * (1 + f.bass * 0.4 * I);
		},
	},
	{
		id: "cursor-storm",
		name: "Cursor Storm",
		desc: "Frenetic — onsets spike the cursors, glyphs scramble, shockwaves on every transient.",
		w: { shock: 1.0, pulse: 0.8, jitter: 1.4, warp: 0.4, hue: 0, camera: 0.8, spawn: 0.9 },
		shock: { origin: "random", speed: 1.3, decay: 0.32, gain: 0.9 },
		hue: { mode: "none" },
		map({ f, k, base, I }) {
			k.cursorIntensity = base.cursorIntensity * (1 + (f.onset * 1.5 + f.beatPulse * 0.8) * I);
			k.cycleSpeed = base.cycleSpeed * (1 + (f.treble * 3 + f.onset * 4) * I);
			k.brightnessDecay = clamp(base.brightnessDecay * (1 + f.onset * 0.5 * I), 0, 1);
			k.baseBrightness = base.baseBrightness + f.onset * 0.3 * I;
		},
	},
	{
		id: "neon-drift",
		name: "Neon Drift",
		jumpPalette: "synthwave",
		desc: "Chill. A slow hue drift, gentle bass pulse, lazy fall — built for ambient and downtempo.",
		w: { shock: 0.3, pulse: 0.8, jitter: 0.2, warp: 0.5, hue: 0.8, camera: 0.5, windSway: 0.9 },
		shock: { origin: "center", speed: 0.5, decay: 0.7, gain: 0.5 },
		hue: { mode: "drift", rate: 0.02, bleed: 0.4 },
		map({ f, k, base, I }) {
			k.fallSpeed = base.fallSpeed * (0.8 + f.level * 0.4 * I);
			k.baseBrightness = base.baseBrightness + (f.beatPulse * 0.25 + f.level * 0.15) * I;
			k.bloomStrength = clamp(base.bloomStrength * (1 + f.level * 0.5 * I), 0, 1);
		},
	},
	{
		id: "strobe-core",
		name: "Strobe Core",
		jumpPalette: "plasma",
		desc: "Club mode. Big brightness+bloom flashes on the beat, fast center shockwaves, hue flips.",
		w: { shock: 1.4, pulse: 1.4, jitter: 0.6, warp: 0.6, hue: 1.0, camera: 1.0 },
		shock: { origin: "center", speed: 1.5, decay: 0.3, gain: 1.3 },
		hue: { mode: "beat", spread: 0.5, bleed: 0.6 },
		map({ f, k, base, I }) {
			k.baseBrightness = base.baseBrightness + f.beatPulse * 0.8 * I;
			k.baseContrast = base.baseContrast * (1 + f.beatPulse * 0.4 * I);
			k.bloomStrength = clamp(base.bloomStrength * (1 + f.beatPulse * 1.2 * I), 0, 1);
			k.cursorIntensity = base.cursorIntensity * (1 + f.beatPulse * 1.0 * I);
		},
	},
	{
		id: "deep-space",
		name: "Deep Space (3D)",
		jumpMode: "morpheus",
		desc: "Made for volumetric modes — bass dollies the camera, beats shake & roll it, energy speeds the dive.",
		w: { shock: 0.5, pulse: 1.0, jitter: 0.4, warp: 0.3, hue: 0.3, camera: 1.6 },
		shock: { origin: "center", speed: 0.8, decay: 0.5, gain: 0.7 },
		hue: { mode: "drift", rate: 0.015, bleed: 0.3 },
		map({ f, k, base, I }) {
			k.animationSpeed = base.animationSpeed * (1 + (f.energy * 0.6 + f.bass * 0.4) * I);
			k.baseBrightness = base.baseBrightness + f.beatPulse * 0.4 * I;
			k.bloomStrength = clamp(base.bloomStrength * (1 + f.bass * 0.7 * I), 0, 1);
		},
	},
	{
		id: "orbit",
		name: "Orbit (3D)",
		jumpMode: "trinity",
		desc: "A slow cinematic flight through the code — the camera strafes, booms, pans, tilts and rolls through the 3D field; stereo steers it side to side.",
		w: { shock: 0.4, pulse: 0.9, jitter: 0.3, warp: 0.2, hue: 0.4, camera: 1.9 },
		shock: { origin: "center", speed: 0.8, decay: 0.5, gain: 0.6 },
		hue: { mode: "drift", rate: 0.012, bleed: 0.3 },
		map({ f, k, base, I }) {
			k.animationSpeed = base.animationSpeed * (1 + (f.energy * 0.4 + f.bass * 0.3) * I);
			k.baseBrightness = base.baseBrightness + f.beatPulse * 0.35 * I;
			k.bloomStrength = clamp(base.bloomStrength * (1 + f.bass * 0.6 * I), 0, 1);
		},
	},
	{
		id: "aurora",
		name: "Aurora",
		jumpPalette: "ice",
		desc: "Brightness paints the hue, chroma blooms, bass breathes the frame. Slow and pretty.",
		w: { shock: 0.3, pulse: 0.7, jitter: 0.3, warp: 0.8, hue: 1.0, camera: 0.4 },
		shock: { origin: "center", speed: 0.6, decay: 0.6, gain: 0.5 },
		hue: { mode: "centroid", spread: 0.85, bleed: 0.9 },
		map({ f, k, base, I }) {
			k.fallSpeed = base.fallSpeed * (0.85 + f.energy * 0.3 * I);
			k.baseBrightness = base.baseBrightness + (f.beatPulse * 0.3 + f.mid * 0.2) * I;
			k.baseContrast = base.baseContrast * (1 + f.highMid * 0.3 * I);
		},
	},
	{
		id: "glitch-matrix",
		name: "Glitch Matrix",
		jumpPalette: "toxic",
		desc: "Datamosh. Heavy glyph scramble + cycling, onset shockwaves, jittery hue on transients.",
		w: { shock: 1.1, pulse: 0.6, jitter: 1.6, warp: 0.7, hue: 0.9, camera: 0.7 },
		shock: { origin: "random", speed: 1.4, decay: 0.28, gain: 1.0 },
		hue: { mode: "bass", spread: 0.4, bleed: 0.8 },
		map({ f, k, base, I }) {
			k.cycleSpeed = base.cycleSpeed * (1 + (f.treble * 4 + f.onset * 5) * I);
			k.brightnessDecay = clamp(base.brightnessDecay * (1 + f.onset * 0.7 * I), 0, 1);
			k.baseBrightness = base.baseBrightness + (f.onset * 0.35 + f.beatPulse * 0.25) * I;
			k.cursorIntensity = base.cursorIntensity * (1 + f.onset * 1.0 * I);
		},
	},
	{
		id: "tempest",
		name: "Tempest",
		desc: "A storm: the rain sways in the wind, beat shockwaves ripple through it, and fresh drops burst from the top on the beat.",
		w: { shock: 1.0, pulse: 0.8, jitter: 0.4, warp: 0.4, hue: 0.5, camera: 0.7, windSway: 1.0, spawn: 0.7 },
		shock: { origin: "random", speed: 1.1, decay: 0.4, gain: 1.0 },
		hue: { mode: "drift", rate: 0.02, bleed: 0.4 },
		map({ f, k, base, I }) {
			k.fallSpeed = base.fallSpeed * (1 + f.energy * 0.4 * I);
			k.baseBrightness = base.baseBrightness + f.beatPulse * 0.4 * I;
			k.bloomStrength = clamp(base.bloomStrength * (1 + f.bass * 0.6 * I), 0, 1);
		},
	},
	{
		id: "nightmare-fuel",
		name: "Nightmare Fuel",
		desc: "Horror. Lightning stabs from the top, glyphs scramble violently, drops burst on the beat. Nightmare mode: gothic red with thunder.",
		jumpMode: "nightmare",
		w: { shock: 1.2, pulse: 0.7, jitter: 1.4, warp: 0.7, hue: 0.4, camera: 0.5, spawn: 0.8 },
		shock: { origin: "top", speed: 1.3, decay: 0.3, gain: 1.1 },
		hue: { mode: "bass", spread: 0.3, bleed: 0.7 },
		map({ f, k, base, I }) {
			k.cycleSpeed = base.cycleSpeed * (1 + (f.treble * 2.5 + f.onset * 3) * I);
			k.baseBrightness = base.baseBrightness + (f.beatBass * 0.7 + f.onset * 0.4) * I; // stabs of light in the dark
			k.brightnessDecay = clamp(base.brightnessDecay * (1 + f.onset * 0.5 * I), 0, 1);
			k.fallSpeed = base.fallSpeed * (1 + f.energy * 0.4 * I);
		},
	},
	{
		id: "compile",
		name: "Compile",
		desc: "Hacker console. Bright cursors flare, fresh lines burst on the beat, characters flicker as they resolve. Operator mode in the Amber palette.",
		jumpMode: "operator",
		jumpPalette: "amber",
		w: { shock: 0.4, pulse: 0.6, jitter: 0.5, warp: 0.2, hue: 0, camera: 0.4, spawn: 1.0 },
		shock: { origin: "random", speed: 0.9, decay: 0.4, gain: 0.6 },
		hue: { mode: "none" },
		map({ f, k, base, I }) {
			k.cursorIntensity = base.cursorIntensity * (1 + (f.onset * 0.8 + f.beatPulse * 0.6) * I);
			k.cycleSpeed = base.cycleSpeed * (1 + (f.treble * 1.5 + f.onset * 2) * I);
			k.baseBrightness = base.baseBrightness + f.beatPulse * 0.3 * I;
			k.fallSpeed = base.fallSpeed * (1 + f.energy * 0.3 * I);
		},
	},
	{
		id: "dreamwave",
		name: "Dreamwave",
		desc: "Retrowave chill. Lazy fall, columns sway in the breeze, a slow hue drift. Twilight mode in the Synthwave palette.",
		jumpMode: "twilight",
		jumpPalette: "synthwave",
		intensity: 0.9,
		w: { shock: 0.3, pulse: 0.7, jitter: 0.2, warp: 0.5, hue: 0.7, camera: 0.4, windSway: 0.8 },
		shock: { origin: "center", speed: 0.5, decay: 0.7, gain: 0.4 },
		hue: { mode: "drift", rate: 0.012, spread: 0.5, bleed: 0.5 },
		map({ f, k, base, I }) {
			k.fallSpeed = base.fallSpeed * (0.85 + f.level * 0.4 * I);
			k.baseBrightness = base.baseBrightness + (f.beatPulse * 0.25 + f.mid * 0.2) * I;
			k.bloomStrength = clamp(base.bloomStrength * (1 + f.level * 0.6 * I), 0, 1);
		},
	},
	{
		id: "stereo-field",
		name: "Stereo Field",
		jumpMode: "classic",
		jumpPalette: "fire",
		desc: "Stereo made visible. The stereo width sways the columns like wind; in 3D modes the balance also steers the camera side to side.",
		w: { shock: 0.4, pulse: 0.6, jitter: 0.4, warp: 0.3, hue: 0.5, camera: 1.2, windSway: 1.1 },
		shock: { origin: "random", speed: 1.0, decay: 0.4, gain: 0.6 },
		hue: { mode: "centroid", spread: 0.5, bleed: 0.5 },
		channelDrivers: { windSway: { mix: [{ f: "stereoWidth", a: 1.1 }, { f: "mid", a: 0.3 }] } },
		map({ f, k, base, I }) {
			k.fallSpeed = base.fallSpeed * (1 + f.energy * 0.35 * I);
			k.baseBrightness = base.baseBrightness + f.beatPulse * 0.3 * I;
			k.cycleSpeed = base.cycleSpeed * (1 + f.treble * 1.2 * I);
		},
	},
	{
		id: "swarm",
		name: "Swarm (3D)",
		desc: "A fast blue plunge through the swarm. Bugs mode: energy drives the dive, bass dollies and blooms, beats shake the camera.",
		jumpMode: "bugs",
		w: { shock: 0.5, pulse: 1.0, jitter: 0.5, warp: 0.3, hue: 0.3, camera: 1.7 },
		shock: { origin: "center", speed: 0.9, decay: 0.45, gain: 0.7 },
		hue: { mode: "drift", rate: 0.02, spread: 0.3, bleed: 0.3 },
		map({ f, k, base, I }) {
			k.animationSpeed = base.animationSpeed * (1 + (f.energy * 0.7 + f.bass * 0.4) * I);
			k.baseBrightness = base.baseBrightness + f.beatPulse * 0.4 * I;
			k.bloomStrength = clamp(base.bloomStrength * (1 + f.bass * 0.7 * I), 0, 1);
		},
	},
];

export const PRESET_BY_ID = Object.fromEntries(PRESETS.map((p) => [p.id, p]));

// Characters whose map is built for the 3D camera — selecting one switches to a 3D mode.
const VOLUMETRIC_CHARACTERS = new Set(["deep-space", "orbit"]);

// Which knob groups does a preset's character map actually drive? Probe it with strong
// features on a unit base and see which knob keys change. Used to seed a preset's
// default mixer (so a preset only reacts on the knobs it was built around).
function detectUsedKnobs(preset) {
	const probeBase = {};
	for (const keys of Object.values(KNOB_KEYS)) for (const key of keys) probeBase[key] = 1;
	const k = { ...probeBase };
	const pf = { energy: 0.8, level: 0.7, bass: 0.7, lowMid: 0.7, mid: 0.7, highMid: 0.7, treble: 0.7, beatPulse: 0.7, beatBass: 0.7, onset: 0.7, centroid: 0.6, flux: 0.5, bpm: 140, balance: 0, stereoWidth: 0.4 };
	try {
		preset.map({ f: pf, k, base: probeBase, dt: 0.016, I: 1 });
	} catch (e) {}
	const used = new Set();
	for (const [knob, keys] of Object.entries(KNOB_KEYS)) {
		if (keys.some((key) => k[key] !== probeBase[key])) used.add(knob);
	}
	return used;
}

function buildDefaultMixer(preset) {
	const w = preset.w || {};
	const used = detectUsedKnobs(preset);
	const m = {};
	for (const e of EFFECTS) {
		if (e.group === "physics") {
			// pulseWarp had no preset weight (was a global toggle) -> on by default at full strength
			const wt = e.id === "pulseWarp" ? w.pulseWarp ?? 1 : w[e.id] ?? 0;
			m[e.id] = { on: wt > 0, strength: wt > 0 ? wt : e.def };
		} else if (e.group === "camera") {
			const wt = w.camera ?? 0;
			m[e.id] = { on: wt > 0, strength: wt > 0 ? wt : e.def };
		} else {
			m[e.id] = { on: used.has(e.id), strength: 1 };
		}
	}
	return m;
}

// Fresh default preset records (the shipped library) — fully numeric + serializable.
export function buildDefaultRecords() {
	const recs = PRESETS.map((p) => ({
		id: p.id,
		name: p.name,
		desc: p.desc,
		characterId: p.id,
		builtin: true,
		jumpMode: p.jumpMode !== undefined ? p.jumpMode : VOLUMETRIC_CHARACTERS.has(p.id) ? "3d" : null, // scene binding: switch to this mode on apply
		jumpPalette: p.jumpPalette ?? null, // A1: signature palette, switched to on apply
		intensity: p.intensity ?? 1.0,
		mixer: buildDefaultMixer(p),
		shock: { ...p.shock }, // per-preset shape (was read off the shared character)
		hue: { ...p.hue },
		drivers: extractDrivers(p), // per-preset reactivity, as data (equivalence-tested vs map())
		channelDrivers: p.channelDrivers ? completeChannelDrivers(p.channelDrivers) : defaultChannelDrivers(), // per-preset pulse/bassWarp/windSway feature mixes (P3)
	}));
	recs.push({ id: "random", name: "🎲 Random", builtin: true, fixed: true, generative: true }); // rolled on apply
	return recs;
}

// ---- engine ----------------------------------------------------------------
const SHADER_ZERO_KEYS = ["pulse", "shockStrength", "glyphJitter", "bassWarp", "hueShift", "colorBleed", "spectrum", "spawn", "windSway", "pulseWarp", "cameraStrafe", "cameraBoom", "cameraDolly", "cameraYaw", "cameraPitch", "cameraShakeX", "cameraShakeY", "cameraRoll"];

export const mapping = {
	beatT: -10,
	shockX: 0.5,
	shockY: 0.5,
	hueState: 0,
	hueBeatAccum: 0,
	// plan-transitions: a pluggable "look" source. null = read live A.* (normal); during a same-mode
	// preset transition the controller installs a fn returning blendLook(from, live, eased_t).
	_lookProvider: null,

	_hueTarget(h, f, t) {
		switch (h.mode) {
			case "centroid":
				return f.centroid * (h.spread ?? 0.5);
			case "drift":
				return t * (h.rate ?? 0.02);
			case "bass":
				return f.bass * (h.spread ?? 0.4);
			case "beat":
				return this.hueBeatAccum * (h.spread ?? 0.5);
			default:
				// A2: "none" (and any unmapped mode) still drifts slowly, so the "Spectral hue shift"
				// mixer effect always does *something* when enabled instead of being inert. The
				// `s.hueShift = hueMx > 0 ? ... : 0` gate below keeps the effect OFF = vanilla, so this
				// only shows when a user turns the hue effect on for a none-mode preset.
				return t * 0.015;
		}
	},

	apply(t, dt) {
		const f = A.features;
		const base = A.base;
		const k = A.knobs;
		const s = A.shader;
		const reactive = A.reactive ? 1 : 0;

		// 1) reset knobs to the mode's base values
		for (const key in base) k[key] = base[key];

		// 2) not reactive -> calm vanilla; zero shader channels and bail
		if (!reactive) {
			for (const key of SHADER_ZERO_KEYS) s[key] = 0;
			return;
		}

		// the active "look" — live A.* by default, or a blended look during a same-mode preset transition.
		const look = (this._lookProvider && this._lookProvider(t, dt)) || liveLook();
		const I = (look.intensity ?? 1) * reactive;

		const M = look.mixer || {};
		const mx = (id) => {
			const e = M[id];
			return e && e.on ? e.strength : 0;
		};
		const character = PRESET_BY_ID[look.characterId] || PRESETS[0];
		// shock/hue come from the active preset RECORD (per-preset authoring), pushed onto A by the
		// store; fall back to the character for records that predate the fields.
		const shockCfg = look.shockCfg || character.shock || {};
		const hueCfg = look.hueCfg || character.hue || { mode: "none" };

		// 3) knobs: interpret the active preset's driver DATA (the DEFAULT_KNOB_MAP baseline is
		// folded into each preset's drivers), then gate + scale each knob group by its mixer
		// strength. Any knob enabled on any preset is live; presets keep their distinct character.
		applyDrivers(look.drivers, base, f, I, k);
		for (const knob in KNOB_KEYS) {
			const m = mx(knob);
			for (const key of KNOB_KEYS[knob]) k[key] = base[key] + (k[key] - base[key]) * m;
		}

		// 3b) HARDENING — a non-finite or zero knob fed into the feedback compute buffers
		// (especially raindropLength, which the raindrop shader divides by) produces NaN
		// that poisons those ping-pong buffers permanently: a black screen that toggling
		// can't undo (only a rebuild clears it). Keep every knob finite + in a safe range.
		for (const key in base) {
			if (!Number.isFinite(k[key])) k[key] = base[key];
		}
		if (!(Math.abs(k.raindropLength) > 0.02)) k.raindropLength = base.raindropLength || 0.3;
		if (!Number.isFinite(k.animationSpeed) || k.animationSpeed < 0) k.animationSpeed = base.animationSpeed;
		k.brightnessDecay = k.brightnessDecay < 0 ? 0 : k.brightnessDecay > 1 ? 1 : k.brightnessDecay;

		// 4) physics drivers — mixer strength (on?strength:0) replaces the old toggle x weight.
		const shockMx = mx("shock");
		const sh = shockCfg;
		if (f.beat && shockMx > 0) {
			this.beatT = t;
			const o = sh.origin;
			if (o === "random") {
				this.shockX = 0.15 + 0.7 * pseudoRand(t);
				this.shockY = 0.15 + 0.7 * pseudoRand(t * 1.7 + 3);
			} else if (o === "bass") {
				this.shockX = 0.5;
				this.shockY = 0.92; // from the bottom
			} else if (o === "top") {
				this.shockX = 0.5;
				this.shockY = 0.08;
			} else {
				this.shockX = 0.5;
				this.shockY = 0.5;
			}
			if (hueCfg.mode === "beat") this.hueBeatAccum += 0.13;
		}
		const since = t - this.beatT;
		s.shockX = this.shockX;
		s.shockY = this.shockY;
		s.shockPhase = since * (sh.speed ?? 0.9);
		s.shockStrength = shockMx > 0 ? shockMx * I * Math.exp(-since / (sh.decay ?? 0.45)) * (sh.gain ?? 1) : 0;

		// pulse / bassWarp / windSway: editable per-preset feature MIX over each channel's FIXED output
		// form (see CHANNEL_META). glyphJitter stays inline — it's feature-less (mixer-gain × I only).
		applyChannelDrivers(look.channelDrivers, f, I, mx, s);
		s.glyphJitter = clamp(mx("jitter") * I, 0, 2);

		const hueMx = mx("hue");
		const hueT = this._hueTarget(hueCfg, f, t);
		this.hueState = lerp(this.hueState, hueT, smoothK(dt, 0.3));
		s.hueShift = hueMx > 0 ? this.hueState * hueMx : 0;
		s.colorBleed = hueMx > 0 ? clamp((hueCfg.bleed || 0) * I * (0.4 + f.energy * 0.8), 0, 1.5) : 0;

		s.spectrum = mx("spectrum") * Math.min(1.2, 0.6 + I * 0.5);
		s.spawn = mx("spawn") * Math.min(1.2, 0.5 + I * 0.6);
		// s.windSway computed above by applyChannelDrivers (editable feature mix)
		s.pulseWarp = mx("pulseWarp");

		// 3D camera rig — each part scaled by its own mixer strength (gate + strength),
		// clamped to stay inside the field's overscan margin so it never reveals the edge.
		const cd = mx("cameraDrift");
		const cp = mx("cameraPan");
		const cb = mx("cameraBass");
		const csk = mx("cameraShake");
		if (cd > 0 || cp > 0 || cb > 0 || csk > 0) {
			const bal = f.balance; // -1 (L) .. +1 (R)
			s.cameraStrafe = clamp((Math.sin(t * 0.07) * 0.1 * cd + bal * 0.16 * cp) * I, -0.32, 0.32);
			s.cameraYaw = clamp((Math.sin(t * 0.13) * 0.09 * cd + bal * 0.12 * cp) * I, -0.16, 0.16);
			s.cameraBoom = clamp((Math.cos(t * 0.11) * 0.07 * cd + (f.bass - 0.45) * 0.1 * cb) * I, -0.28, 0.28);
			s.cameraDolly = clamp((-Math.abs(Math.sin(t * 0.045)) * 0.18 * cd - f.energy * 0.1 * cb) * I, -0.55, 0);
			s.cameraPitch = clamp((-0.04 * cd + Math.sin(t * 0.09 + 1.3) * 0.05 * cd + f.beatPulse * 0.04 * csk) * I, -0.15, 0.08);
			s.cameraRoll = clamp((Math.sin(t * 0.06) * 0.05 * cd + f.bass * 0.03 * cb) * I, -0.15, 0.15);
			s.cameraShakeX = clamp(f.onset * 0.02 * csk * I * Math.sin(t * 30.0), -0.1, 0.1);
			s.cameraShakeY = clamp(f.onset * 0.02 * csk * I * Math.cos(t * 27.0), -0.1, 0.1);
		} else {
			s.cameraStrafe = s.cameraBoom = s.cameraDolly = s.cameraYaw = s.cameraPitch = s.cameraRoll = s.cameraShakeX = s.cameraShakeY = 0;
		}
	},
};

// deterministic-ish pseudo-random from a float (avoids Math.random per the lab habit,
// and keeps shock origins reproducible for a given time)
function pseudoRand(x) {
	const v = Math.sin(x * 127.1 + 311.7) * 43758.5453;
	return v - Math.floor(v);
}

export function initMapping(MV) {
	MV.onFrame((t, dt) => mapping.apply(t, dt));
	return mapping; // the preset store sets the initial active preset
}
