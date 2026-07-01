// matrix-music-viz — transition controller (plan-transitions).
// Smooths the hard cuts between preset / palette / mode changes into adjustable blends, and owns the
// song-title splash. Three axes, three mechanics:
//   - PRESET (same pipeline)        -> param-blend: mapping reads blendLook(from, live, eased) / frame.
//   - PALETTE ramp↔ramp (same pipe) -> gradient morph: A.paletteMorph re-uploads the palette texture.
//   - MODE / cross-pass-type palette -> dual-pipeline crossfade composite (driven via the renderer).
//
// Policy `when`: Always | Director-only | Off. Manual changes, the director, and the random roll all
// route through here (setMode / store.setActive carry a `source`), so the policy is honored everywhere.

import { A } from "../vendor/matrix/js/reactive.js";
import { mapping, liveLook, blendLook } from "./presets.js";
import { bakePaletteRGBA, PALETTE_SIZE } from "../vendor/matrix/js/regl/palettePass.js";

const LS_KEY = "matrixviz.transitions.v1";
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// rgb (0..255) <-> hsl (0..1) — for the hue-path palette morph (rotate hue around the wheel instead of
// a straight RGB line, which would pass through a grey midpoint between distant hues).
function rgbToHsl(r, g, b) {
	r /= 255;
	g /= 255;
	b /= 255;
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const l = (max + min) / 2;
	let h = 0;
	let s = 0;
	const d = max - min;
	if (d > 1e-6) {
		s = d / (1 - Math.abs(2 * l - 1));
		if (max === r) h = ((g - b) / d) % 6;
		else if (max === g) h = (b - r) / d + 2;
		else h = (r - g) / d + 4;
		h /= 6;
		if (h < 0) h += 1;
	}
	return [h, s, l];
}
function hslToRgb(h, s, l) {
	const a = s * Math.min(l, 1 - l);
	const f = (n) => {
		const k = (n + h * 12) % 12;
		return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
	};
	return [f(0), f(8), f(4)];
}

// easing curves, t in 0..1 -> 0..1 (all monotonic, f(0)=0, f(1)=1).
const EASINGS = {
	linear: (t) => t,
	smooth: (t) => t * t * (3 - 2 * t), // smoothstep — ease-in-out (slow→fast→slow)
	smoother: (t) => t * t * t * (t * (t * 6 - 15) + 10), // smootherstep — more dramatic ease-in-out
	easeOut: (t) => 1 - (1 - t) * (1 - t), // quadratic decel (fast→slow)
	easeIn: (t) => t * t, // quadratic accel (slow→fast)
};
export const EASING_IDS = Object.keys(EASINGS);
export const EASING_LABELS = { linear: "Linear", smooth: "Smooth", smoother: "Smoother", easeOut: "Ease-out", easeIn: "Ease-in" };

const CONFIG_KEYS = ["when", "length", "type", "easing", "blendPreset", "blendPalette", "crossfadeMode", "titleEffect", "titleAuto", "titleDuration"];

export const transitions = {
	// ---- config (persisted to localStorage + bundled in Export/Import) ----
	when: "always", // 'always' | 'director' | 'off' — when a change blends vs hard-cuts
	length: 1.5, // transition length, seconds
	type: "complex", // 'simple' (linear) | 'complex' (eased) | 'random' (roll the easing per transition)
	easing: "smooth", // the eased curve used by 'complex'
	blendPreset: true, // param-blend on a same-mode preset change
	blendPalette: true, // gradient-morph a same-mode ramp↔ramp palette change
	crossfadeMode: true, // dual-pipeline crossfade for mode / cross-pass-type palette changes
	titleEffect: "glyph", // 'normal' (text overlay) | 'glyph' (burn into the rain — P3)
	titleAuto: true, // show the title on track change
	titleDuration: 3.0, // seconds the title holds (fade-in + hold + fade-out scaled to this)

	// ---- runtime ----
	suspended: true, // true during boot/restore — the initial activation must not animate
	_mv: null,
	_sync: null, // initTransitions installs a "push state -> controls" fn
	_preset: null, // active preset param-blend: { from, t0, dur, ease }
	_pipe: null, // active mode/palette crossfade: { t0, dur, ease, setMix, done }
	_morph: null, // active same-mode ramp↔ramp palette gradient morph: { arrA, arrB, data, t0, dur, ease, done }
	_titleEl: null,
	_titleT: null,
	// title slots: TITLE_N concurrent titles (a new T claims a slot, never clobbers an in-flight one). Each
	// slot owns a mask band in the shared atlas + its state in A.title.{amount,drop,releaseT,...}[i].
	_slots: null, // [{ active, mode, t0, dur, holdFrac, released, start, end }] × _TN
	_atlas: null, // offscreen atlas canvas (_AW × _AH*_TN) — the stacked title masks

	// ---- policy ----------------------------------------------------------------
	// Does a change from `source` get a transition? off -> never; always -> any change; director ->
	// only the director's auto-switches (manual stays snappy).
	enabledFor(source) {
		if (this.suspended || this.when === "off") return false;
		if (this.when === "always") return true;
		return source === "director";
	},

	// per-transition easing + duration (type-aware). simple = linear; complex = the chosen curve;
	// random = roll a curve + jitter the length (variety per transition).
	_pickEase() {
		if (this.type === "simple") return "linear";
		if (this.type === "random") return EASING_IDS[Math.floor(Math.random() * EASING_IDS.length)];
		return this.easing;
	},
	_pickDur() {
		if (this.type === "random") return clamp(this.length * (0.6 + Math.random() * 0.9), 0.2, 10);
		return this.length;
	},

	// ---- preset param-blend (same pipeline) ------------------------------------
	// Called by store.setActive AFTER it applied the new look to A.* (so liveLook() == the destination).
	// fromLook = the snapshot taken BEFORE. pipelineChanged = a mode/palette rebuild is also happening
	// (then the crossfade carries the visual transition and we skip the param-blend).
	presetChanged(fromLook, opts = {}) {
		const source = opts.source || "manual";
		if (!fromLook || opts.pipelineChanged || !this.blendPreset || !this.enabledFor(source)) {
			this._endPreset();
			return;
		}
		this._preset = { from: fromLook, t0: A.features.time, dur: this._pickDur(), ease: this._pickEase(), stagger: this._pickStagger() };
		mapping._lookProvider = (t) => this._presetLook(t);
	},
	// the per-param stagger for the preset param-blend: simple = none; complex = the colour group (shock
	// origin + hue) leads and the reactivity group (mixer + drivers) lags ("colours-first-then-reactivity");
	// random = roll which group leads + how much overlap.
	_pickStagger() {
		if (this.type === "simple") return null;
		if (this.type === "random") return { lead: Math.random() < 0.5 ? "color" : "motion", amount: +(0.18 + Math.random() * 0.34).toFixed(2) };
		return { lead: "color", amount: 0.35 };
	},
	_presetLook(t) {
		const p = this._preset;
		if (!p) return null;
		const raw = (t - p.t0) / p.dur;
		if (raw >= 1) return null; // done — mapping falls back to liveLook() (== destination); tick clears
		const ez = EASINGS[p.ease];
		if (!p.stagger) return blendLook(p.from, liveLook(), ez(clamp01(raw)));
		const amt = p.stagger.amount;
		const leadE = ez(clamp01(raw / (1 - amt))); // reaches 1 by raw = 1 - amt (finishes early)
		const lagE = ez(clamp01((raw - amt) / (1 - amt))); // starts at raw = amt (begins late)
		const colorT = p.stagger.lead === "color" ? leadE : lagE;
		const motionT = p.stagger.lead === "color" ? lagE : leadE;
		return blendLook(p.from, liveLook(), ez(clamp01(raw)), { colorT, motionT });
	},
	_endPreset() {
		this._preset = null;
		if (mapping._lookProvider) mapping._lookProvider = null;
	},

	// ---- mode / palette crossfade (driven by boot's setMode, which owns the renderer handle) --------
	// Does a mode / cross-pass-type palette change get the dual-pipeline crossfade?
	wantsPipelineCrossfade(source) {
		return this.crossfadeMode && this.enabledFor(source);
	},
	// a same-mode ramp↔ramp palette change gets the in-place gradient morph (cheaper + truer than the
	// crossfade dissolve — the colours actually flow A→B on the one live pipeline).
	wantsPaletteMorph(source) {
		return this.blendPalette && this.enabledFor(source);
	},
	pipelineParams() {
		return { dur: this._pickDur(), ease: this._pickEase() };
	},
	// finalize any in-flight crossfade / palette-morph NOW (snap to its target) — boot calls this before
	// starting a new transition so the renderer's single transition slot is free + latest-wins.
	snapActivePipeline() {
		if (this._pipe) {
			this._pipe.setMix(1);
			this._pipe.done();
			this._pipe = null;
		}
		if (this._morph) {
			const m = this._morph;
			this._morph = null;
			A.paletteMorph = null;
			if (m.done) m.done(); // re-key the live pipeline to the morph's target
		}
	},

	// ---- palette gradient morph (same-mode ramp↔ramp) --------------------------
	// boot passes the two resolved palette entry-lists + a `done` closure that re-keys the live pipeline
	// to the target. We bake both gradients once, then lerp them into A.paletteMorph.data each frame; the
	// live palettePass uploads the blended gradient in place (no rebuild). On finish, `done` re-keys.
	runPaletteMorph({ fromEntries, toEntries, dur, ease, done }) {
		this.snapActivePipeline();
		const arrA = bakePaletteRGBA(fromEntries, PALETTE_SIZE);
		const arrB = bakePaletteRGBA(toEntries, PALETTE_SIZE);
		const data = new Uint8Array(PALETTE_SIZE * 4);
		data.set(arrA);
		A.paletteMorph = { active: true, data, size: PALETTE_SIZE, gen: 1 };
		const path = this._pickColorPath(); // 'rgb' (straight lerp) | 'hue' (rotate hue around the wheel)
		let hslA = null;
		let hslB = null;
		if (path === "hue") {
			hslA = new Float32Array(PALETTE_SIZE * 3);
			hslB = new Float32Array(PALETTE_SIZE * 3);
			for (let i = 0; i < PALETTE_SIZE; i++) {
				const ca = rgbToHsl(arrA[i * 4], arrA[i * 4 + 1], arrA[i * 4 + 2]);
				const cb = rgbToHsl(arrB[i * 4], arrB[i * 4 + 1], arrB[i * 4 + 2]);
				hslA[i * 3] = ca[0];
				hslA[i * 3 + 1] = ca[1];
				hslA[i * 3 + 2] = ca[2];
				hslB[i * 3] = cb[0];
				hslB[i * 3 + 1] = cb[1];
				hslB[i * 3 + 2] = cb[2];
			}
		}
		this._morph = { arrA, arrB, data, t0: A.features.time, dur, ease, done, gen: 1, finishing: false, path, hslA, hslB };
	},
	// the colour interpolation path: straight RGB by default; the Random type may roll the hue-path
	// (rotate A's hue toward B's around the wheel — stays vivid instead of dipping through a grey midpoint).
	_pickColorPath() {
		return this.type === "random" && Math.random() < 0.5 ? "hue" : "rgb";
	},

	// boot calls runPipeline with closures that set the composite mix + finalize; the controller drives
	// the eased mix from the frame clock. Snap-to-latest: a new crossfade finalizes the active one first.
	runPipeline({ dur, ease, setMix, done }) {
		if (this._pipe) {
			this._pipe.setMix(1);
			this._pipe.done();
			this._pipe = null;
		}
		this._pipe = { t0: A.features.time, dur, ease, setMix, done };
		setMix(0);
	},
	pipelineActive() {
		return !!this._pipe;
	},

	// ---- the per-frame tick (registered as a frame hook, after mapping) --------
	tick(t, dt) {
		if (this._preset && (t - this._preset.t0) / this._preset.dur >= 1) this._endPreset();
		if (this._pipe) {
			const p = this._pipe;
			const raw = (t - p.t0) / p.dur;
			if (raw >= 1) {
				this._pipe = null;
				p.setMix(1);
				p.done();
			} else {
				p.setMix(EASINGS[p.ease](clamp01(raw)));
			}
		}
		if (this._slots) {
			for (let i = 0; i < this._slots.length; i++) if (this._slots[i].active) this._applySlot(i, t);
		}
		if (this._morph) {
			const m = this._morph;
			if (m.finishing) {
				// the target gradient was uploaded last frame; now re-key the live pipeline + clear.
				this._morph = null;
				A.paletteMorph = null;
				if (m.done) m.done();
			} else {
				const raw = (t - m.t0) / m.dur;
				const e = raw >= 1 ? 1 : EASINGS[m.ease](clamp01(raw));
				const d = m.data;
				if (m.path === "hue") {
					const hA = m.hslA;
					const hB = m.hslB;
					for (let i = 0; i < PALETTE_SIZE; i++) {
						let dh = hB[i * 3] - hA[i * 3];
						if (dh > 0.5) dh -= 1;
						else if (dh < -0.5) dh += 1; // shortest arc around the wheel
						const rgb = hslToRgb(hA[i * 3] + dh * e, hA[i * 3 + 1] + (hB[i * 3 + 1] - hA[i * 3 + 1]) * e, hA[i * 3 + 2] + (hB[i * 3 + 2] - hA[i * 3 + 2]) * e);
						d[i * 4] = rgb[0];
						d[i * 4 + 1] = rgb[1];
						d[i * 4 + 2] = rgb[2];
						d[i * 4 + 3] = 255;
					}
				} else {
					const a = m.arrA;
					const b = m.arrB;
					for (let i = 0; i < d.length; i++) d[i] = a[i] + (b[i] - a[i]) * e;
				}
				A.paletteMorph.gen = ++m.gen;
				if (raw >= 1) m.finishing = true; // uploaded B this frame; finalize next frame
			}
		}
	},

	// ---- song-title splash -----------------------------------------------------
	// tint = the palette's bright "head" colour so the title reads as part of the viz; falls back to the
	// phosphor green CSS var when the palette has no extractable colours (mode-default / plain / debug).
	_paletteTint() {
		const MV = this._mv;
		if (!MV || !MV.palettes) return null;
		const r = MV.palettes.get(MV.current.effect);
		let cols = null;
		if (r && r.kind === "ramp" && Array.isArray(r.ramp)) cols = r.ramp;
		else if (r && r.kind === "random") {
			const p = MV.palettes;
			if (Array.isArray(p._randomRamp)) cols = p._randomRamp;
			else if (Array.isArray(p._randomStripe)) cols = p._randomStripe.map((c) => ({ h: c.values[0], s: c.values[1], l: c.values[2] }));
		}
		if (!cols || !cols.length) return null;
		let best = cols[0];
		for (const c of cols) if ((c.l ?? 0) > (best.l ?? 0)) best = c;
		const h = Math.round((((best.h ?? 0.33) % 1) + 1) % 1 * 360);
		const s = Math.round(clamp(best.s ?? 1, 0.4, 1) * 100);
		const l = Math.round(clamp(best.l ?? 0.7, 0.55, 0.85) * 100);
		return `hsl(${h} ${s}% ${l}%)`;
	},

	// show the title. Overlay = a DOM text overlay (single; re-trigger restarts). The Glyph modes spawn a
	// SLOT that burns into the rain — TITLE_N slots STACK, so a new T never clobbers an in-flight title.
	showTitle(text, sub) {
		if (this.titleEffect === "off" || !text) return;
		if (this.titleEffect === "normal") return this._showOverlay(text, sub);
		let mode = this.titleEffect; // 'glyph' (Mask) | 'drop' (Hold and Rain) | 'fall' | 'grandom'
		if (mode === "grandom") mode = ["glyph", "drop", "fall"][Math.floor(Math.random() * 3)];
		this._spawnGlyphSlot(text, mode);
	},

	// ---- glyph title SLOTS -----------------------------------------------------
	_TN: 8, // concurrent slot count (must match TITLE_N in the shaders)
	_AW: 512,
	_AH: 256, // per-slot mask size; the atlas is _AW × (_AH × _TN)
	_ensureSlots() {
		if (this._slots) return;
		this._atlas = document.createElement("canvas");
		this._atlas.width = this._AW;
		this._atlas.height = this._AH * this._TN;
		const g = this._atlas.getContext("2d");
		if (g) {
			g.fillStyle = "#000";
			g.fillRect(0, 0, this._atlas.width, this._atlas.height);
		}
		this._slots = Array.from({ length: this._TN }, () => ({ active: false }));
	},
	// claim a free slot, or recycle the oldest active one (nearest finishing).
	_claimSlot() {
		this._ensureSlots();
		const s = this._slots;
		for (let i = 0; i < s.length; i++) if (!s[i].active) return i;
		let idx = 0;
		let oldest = Infinity;
		for (let i = 0; i < s.length; i++)
			if (s[i].t0 < oldest) {
				oldest = s[i].t0;
				idx = i;
			}
		return idx;
	},
	// rasterize the title into atlas band `idx` (white on black), re-upload the atlas, return the text band.
	_drawSlotMask(idx, text) {
		const g = this._atlas.getContext("2d");
		const W = this._AW;
		const H = this._AH;
		const y0 = idx * H;
		g.fillStyle = "#000";
		g.fillRect(0, y0, W, H);
		g.fillStyle = "#fff";
		g.textAlign = "center";
		g.textBaseline = "middle";
		const font = (s) => `700 ${s}px "SFMono-Regular", "Consolas", "Liberation Mono", monospace`;
		let size = 130;
		g.font = font(size);
		const maxW = W * 0.9;
		const w = g.measureText(text).width;
		if (w > maxW) {
			size = Math.max(30, Math.floor((size * maxW) / w));
			g.font = font(size);
		}
		g.fillText(text, W / 2, y0 + H / 2);
		const m = g.measureText(text);
		const ascent = m.actualBoundingBoxAscent || size * 0.5;
		const descent = m.actualBoundingBoxDescent || size * 0.22;
		const handle = this._mv && this._mv.getHandle && this._mv.getHandle();
		if (handle && handle.setTitleMask) handle.setTitleMask(this._atlas);
		return { topV: (H / 2 - ascent) / H, bottomV: (H / 2 + descent) / H };
	},
	// spawn a glyph title into a slot. mode 'glyph' (Mask, render-pass) | 'drop' (Hold and Rain) | 'fall'.
	// Drop/Fall fall back to Mask on non-grid scenes (volumetric/polar/slant). No renderer → the Overlay.
	_spawnGlyphSlot(text, mode) {
		const handle = this._mv && this._mv.getHandle && this._mv.getHandle();
		if (!handle || !handle.setTitleMask) return this._showOverlay(text);
		if ((mode === "drop" || mode === "fall") && !this._gridGlyphOk()) mode = "glyph";
		const idx = this._claimSlot();
		const band = this._drawSlotMask(idx, text);
		const s = this._slots[idx];
		s.active = true;
		s.mode = mode;
		s.t0 = A.features.time;
		s.dur = this.titleDuration;
		s.released = false;
		if (mode === "fall") {
			s.start = -band.bottomV - 0.01; // bottom edge just above the screen top
			s.end = 1 - band.topV + 0.04; // top edge just past the screen bottom
		} else if (mode === "drop") {
			s.holdFrac = 0.5;
		}
		this._applySlot(idx, s.t0);
	},
	// advance one slot's per-frame A.title state (from tick); frees the slot when its life ends.
	_applySlot(idx, t) {
		const s = this._slots[idx];
		const T = A.title;
		const e = t - s.t0;
		if (e >= s.dur) return this._freeSlot(idx);
		if (s.mode === "glyph") {
			T.amount[idx] = this._titleEnvelope(e / s.dur); // Mask (render-pass) brightness boost
			T.drop[idx] = 0;
		} else if (s.mode === "fall") {
			T.amount[idx] = 0;
			T.drop[idx] = 2;
			T.holdLevel[idx] = 1;
			T.releaseT[idx] = s.start + (s.end - s.start) * (e / s.dur); // rigid scroll straight through
		} else {
			// drop (Hold and Rain): hold the lit state, then release it to fall as rain
			T.amount[idx] = 0;
			T.drop[idx] = 1;
			T.holdLevel[idx] = e < 0.12 ? e / 0.12 : 1; // quick form-in
			const holdEnd = s.dur * s.holdFrac;
			if (e < holdEnd) {
				T.releaseT[idx] = -1; // HOLD
			} else {
				if (!s.released) {
					s.released = true;
					T.releasePhase[idx] = A.fallPhase; // anchor the fall to the rain's phase at release
				}
				T.releaseT[idx] = e - holdEnd; // FALL
			}
		}
	},
	_freeSlot(idx) {
		this._slots[idx].active = false;
		A.title.amount[idx] = 0;
		A.title.drop[idx] = 0;
		A.title.releaseT[idx] = -1;
	},
	// the grid-injected glyph titles map cleanly only on a straight grid (no slant/polar/volumetric);
	// glyphHeightToWidth is corrected in-shader, so it doesn't disqualify.
	_gridGlyphOk() {
		const mi = A.modeInfo;
		if (!mi) return true;
		return !mi.volumetric && !mi.isPolar && Math.abs(mi.slant || 0) < 0.001;
	},
	// ---- the Normal (Overlay) DOM title ----------------------------------------
	_showOverlay(text, sub) {
		const el = this._titleEl;
		if (!el) return;
		const main = el.querySelector(".vt-main");
		const subEl = el.querySelector(".vt-sub");
		if (main) main.textContent = text;
		if (subEl) {
			subEl.textContent = sub || "";
			subEl.style.display = sub ? "" : "none";
		}
		const tint = this._paletteTint();
		if (tint) el.style.color = tint;
		else el.style.removeProperty("color");
		el.style.setProperty("--vt-dur", this.titleDuration + "s");
		el.classList.remove("show");
		void el.offsetWidth;
		el.classList.add("show");
		clearTimeout(this._titleT);
		this._titleT = setTimeout(() => el.classList.remove("show"), this.titleDuration * 1000 + 50);
	},
	// title brightness envelope: attack (burn in) -> hold -> release (rain away).
	_titleEnvelope(r) {
		if (r < 0.1) return r / 0.1;
		if (r < 0.6) return 1;
		const k = (r - 0.6) / 0.4;
		return 1 - k * k; // ease-out release
	},

	// fired from the player on track change (if titleAuto) and from the T key (manual, always).
	onTrackChange(track) {
		if (!this.titleAuto || this.suspended) return;
		this.showTitle(track && (track.title || track.src), track && track.artist);
	},
	triggerTitle() {
		const MV = this._mv;
		const tr = MV && MV.player && MV.player.tracks[MV.player.index];
		this.showTitle(tr ? tr.title || tr.src : "matrix·music", tr ? tr.artist : null);
	},

	// ---- config persistence + export/import ------------------------------------
	getConfig() {
		const c = {};
		for (const k of CONFIG_KEYS) c[k] = this[k];
		return c;
	},
	setConfig(c, opts = {}) {
		if (!c) return;
		if (c.when === "always" || c.when === "director" || c.when === "off") this.when = c.when;
		if (typeof c.length === "number") this.length = clamp(c.length, 0.2, 10);
		if (c.type === "simple" || c.type === "complex" || c.type === "random") this.type = c.type;
		if (EASING_IDS.includes(c.easing)) this.easing = c.easing;
		if (typeof c.blendPreset === "boolean") this.blendPreset = c.blendPreset;
		if (typeof c.blendPalette === "boolean") this.blendPalette = c.blendPalette;
		if (typeof c.crossfadeMode === "boolean") this.crossfadeMode = c.crossfadeMode;
		if (c.titleEffect === "normal" || c.titleEffect === "glyph" || c.titleEffect === "drop" || c.titleEffect === "fall" || c.titleEffect === "grandom" || c.titleEffect === "off") this.titleEffect = c.titleEffect;
		if (typeof c.titleAuto === "boolean") this.titleAuto = c.titleAuto;
		if (typeof c.titleDuration === "number") this.titleDuration = clamp(c.titleDuration, 1, 10);
		if (!opts.noPersist) this._persist();
		if (this._sync) this._sync();
	},
	_persist() {
		try {
			localStorage.setItem(LS_KEY, JSON.stringify(this.getConfig()));
		} catch (e) {}
	},
	_load() {
		try {
			const c = JSON.parse(localStorage.getItem(LS_KEY));
			if (c) this.setConfig(c, { noPersist: true });
		} catch (e) {}
	},
};

export function initTransitions(MV) {
	transitions._mv = MV;
	transitions._titleEl = document.getElementById("viz-title");
	MV.onFrame((t, dt) => transitions.tick(t, dt));

	const $ = (id) => document.getElementById(id);
	const els = {
		when: $("trans-when"),
		length: $("trans-length"),
		lengthVal: $("trans-length-val"),
		type: $("trans-type"),
		easing: $("trans-easing"),
		easingField: $("trans-easing-field"),
		blendPreset: $("trans-blend-preset"),
		blendPalette: $("trans-blend-palette"),
		crossfadeMode: $("trans-crossfade-mode"),
		titleEffect: $("title-effect"),
		titleAuto: $("title-auto"),
		titleDuration: $("title-duration"),
		titleDurationVal: $("title-duration-val"),
		titleTest: $("title-test"),
	};

	// Push state -> controls (after load / import).
	const sync = () => {
		if (els.when) els.when.value = transitions.when;
		if (els.length) els.length.value = transitions.length;
		if (els.lengthVal) els.lengthVal.textContent = transitions.length.toFixed(1) + "s";
		if (els.type) els.type.value = transitions.type;
		if (els.easing) els.easing.value = transitions.easing;
		if (els.easingField) els.easingField.style.display = transitions.type === "complex" ? "" : "none"; // easing only matters for 'complex'
		if (els.blendPreset) els.blendPreset.checked = transitions.blendPreset;
		if (els.blendPalette) els.blendPalette.checked = transitions.blendPalette;
		if (els.crossfadeMode) els.crossfadeMode.checked = transitions.crossfadeMode;
		if (els.titleEffect) els.titleEffect.value = transitions.titleEffect;
		if (els.titleAuto) els.titleAuto.checked = transitions.titleAuto;
		if (els.titleDuration) els.titleDuration.value = transitions.titleDuration;
		if (els.titleDurationVal) els.titleDurationVal.textContent = transitions.titleDuration.toFixed(1) + "s";
	};
	transitions._sync = sync;

	els.when?.addEventListener("change", () => transitions.setConfig({ when: els.when.value }));
	els.length?.addEventListener("input", () => {
		transitions.length = parseFloat(els.length.value);
		if (els.lengthVal) els.lengthVal.textContent = transitions.length.toFixed(1) + "s";
		transitions._persist();
	});
	els.type?.addEventListener("change", () => transitions.setConfig({ type: els.type.value }));
	els.easing?.addEventListener("change", () => transitions.setConfig({ easing: els.easing.value }));
	els.blendPreset?.addEventListener("change", () => transitions.setConfig({ blendPreset: els.blendPreset.checked }));
	els.blendPalette?.addEventListener("change", () => transitions.setConfig({ blendPalette: els.blendPalette.checked }));
	els.crossfadeMode?.addEventListener("change", () => transitions.setConfig({ crossfadeMode: els.crossfadeMode.checked }));
	els.titleEffect?.addEventListener("change", () => transitions.setConfig({ titleEffect: els.titleEffect.value }));
	els.titleAuto?.addEventListener("change", () => transitions.setConfig({ titleAuto: els.titleAuto.checked }));
	els.titleDuration?.addEventListener("input", () => {
		transitions.titleDuration = parseFloat(els.titleDuration.value);
		if (els.titleDurationVal) els.titleDurationVal.textContent = transitions.titleDuration.toFixed(1) + "s";
		transitions._persist();
	});
	els.titleTest?.addEventListener("click", () => transitions.triggerTitle());

	// (store.transitionsIO for Export/Import is installed by app-init, where `store` is in scope.)
	transitions._load();
	sync();

	// Show the title on track change (player.onTrackChange -> transitions.onTrackChange, wired in app-init).
	return transitions;
}
