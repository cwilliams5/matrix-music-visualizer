// matrix-music-viz — orchestrator.
// Owns the vendored renderer lifecycle (build / teardown / rebuild on mode change),
// captures each mode's base knob values for the reactive mapping layer, and runs a
// single per-frame master tick (via the renderer's own rAF, through A.update) that
// all subsystems (audio engine, mapping, director, overlay) hook into.

import makeConfig from "../vendor/matrix/js/config.js";
import makeMatrixRenderer from "../vendor/matrix/js/regl/main.js";
import { A } from "../vendor/matrix/js/reactive.js";
import { palettes } from "./palette-store.js";
import { session } from "./session-store.js";
import { transitions } from "./transitions.js";
import "./embed.js"; // embedded-adapter: sets html.matrixviz-embedded + capabilities before first paint

const ASSET_BASE = "vendor/matrix/";

// Modes worth exposing (holoplay needs Looking Glass hardware; aliases omitted).
export const MODES = [
	"classic",
	"resurrections",
	"3d",
	"megacity",
	"operator",
	"nightmare",
	"paradise",
	"trinity",
	"morpheus",
	"bugs",
	"palimpsest",
	"twilight",
	"neomatrixology",
];

export const MODE_LABELS = {
	classic: "Classic",
	resurrections: "Resurrections",
	"3d": "3D Rain",
	megacity: "Megacity",
	operator: "Operator (1999)",
	nightmare: "Nightmare",
	paradise: "Paradise",
	trinity: "Trinity (3D)",
	morpheus: "Morpheus (3D)",
	bugs: "Bugs (3D)",
	palimpsest: "Palimpsest",
	twilight: "Twilight",
	neomatrixology: "Neomatrixology",
};

// Post-effect "palettes" now live in the palette store (palette-store.js) — built-in specials
// (mode default / plain / spectrum / debug) + editable brightness->color ramps (fire, ice, …) +
// user palettes. boot resolves the active palette id into renderer config via palettes.resolve().

// Knobs the mapping layer anchors to per mode.
const BASE_KNOBS = [
	"fallSpeed",
	"cycleSpeed",
	"animationSpeed",
	"raindropLength",
	"brightnessDecay",
	"baseBrightness",
	"baseContrast",
	"cursorIntensity",
	"glintIntensity",
	"bloomStrength",
];

const stage = document.getElementById("stage");

let handle = null; // { regl, tick, destroy, config }
let canvas = null;
let building = false;
let pendingMode = null; // latest-wins request while building
export const current = { version: "classic", effect: "mode-default" }; // effect = the active palette id

function buildConfig(version, paletteId, extra = {}) {
	const res = palettes.resolve(paletteId); // { effect, palette? } — effect routes the pass, palette overrides
	const params = { version, effect: res.effect, ...extra };
	const strParams = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]));
	const config = makeConfig(strParams);
	config.assetBase = ASSET_BASE;
	if (res.palette) config.palette = res.palette; // ramp palette -> override the brightness->color map
	if (res.stripeColors) config.stripeColors = res.stripeColors; // stripe palette -> custom 1D gradient
	return config;
}

function captureBase(config) {
	const base = {};
	for (const k of BASE_KNOBS) base[k] = config[k];
	A.base = base;
	// Reset live knobs to base so silent/non-reactive playback == vanilla matrix.
	A.knobs = { ...base };
	// Reset shader extras.
	for (const k in A.shader) A.shader[k] = k === "shockX" || k === "shockY" ? 0.5 : 0;
	// Mode shape info for presets/director.
	A.modeInfo = {
		version: config.version ?? current.version,
		effect: config.effect ?? current.effect,
		volumetric: !!config.volumetric,
		numColumns: config.numColumns,
		isPolar: !!config.isPolar,
		hasThunder: !!config.hasThunder,
		font: config.font,
		slant: config.slant || 0, // field slant (rad) — the grid-injected glyph titles can't map it
		glyphHeightToWidth: config.glyphHeightToWidth || 1, // grid-row → screen-Y scale (corrected in-shader)
	};
}

export function getHandle() {
	return handle;
}

export async function setMode(version = current.version, effect = current.effect, opts = {}) {
	const source = opts.source || "manual"; // 'manual' | 'director' — the transition policy keys on this
	const extra = opts.extra || {};
	if (building) {
		pendingMode = { version, effect, opts };
		return;
	}
	building = true;
	// Escape the current call stack before touching the renderer. The director calls
	// setMode from inside the render frame callback (via A.update); a 0ms defer lets the
	// in-flight frame finish first. Imperceptible (~1 tick) for UI/click switches.
	await new Promise((r) => setTimeout(r, 0));
	try {
		const config = buildConfig(version, effect, extra);
		const structuralChange = version !== current.version || effect !== current.effect;
		// plan-transitions P1: a SAME-MODE ramp↔ramp palette change morphs the gradient in place (no
		// rebuild, no pop) instead of crossfading two pipelines. Both must be ramp palettes (each routes
		// to a palettePass with a gradient override the morph can re-colour).
		const fromPal = handle ? palettes.get(current.effect) : null;
		const toPal = palettes.get(effect);
		const rampMorph = handle && version === current.version && effect !== current.effect && fromPal && fromPal.kind === "ramp" && toPal && toPal.kind === "ramp" && transitions.wantsPaletteMorph(source);
		if (!handle) {
			// First build: create the ONE persistent renderer (context + canvas).
			captureBase(config);
			canvas = document.createElement("canvas");
			stage.appendChild(canvas);
			handle = await makeMatrixRenderer(canvas, config);
		} else if (rampMorph) {
			// In-place gradient morph: NO rebuild, NO captureBase (same mode keeps the base knobs), so the
			// rain's compute buffers + reactive knobs stay continuous — only the colours flow A→B.
			transitions.snapActivePipeline();
			if (canvas) canvas.style.opacity = "1";
			if (A.modeInfo) A.modeInfo.effect = config.effect;
			const pp = transitions.pipelineParams();
			transitions.runPaletteMorph({
				fromEntries: palettes.resolve(current.effect).palette,
				toEntries: palettes.resolve(effect).palette,
				dur: pp.dur,
				ease: pp.ease,
				done: () => handle.rekeyActive(config),
			});
		} else if (structuralChange && transitions.wantsPipelineCrossfade(source)) {
			// plan-transitions P2: crossfade two rendered pipelines instead of the fade-through-black cut.
			// We keep the OLD pipeline live, build the new one, and composite by an eased mix over the
			// transition window (driven from the frame clock by the controller). ~2× GPU for the window.
			captureBase(config);
			transitions.snapActivePipeline(); // finalize any in-flight transition first (latest-wins)
			if (canvas) canvas.style.opacity = "1"; // a prior hard-cut may have left the canvas mid-fade
			await handle.beginCrossfade(config);
			const { dur, ease } = transitions.pipelineParams();
			transitions.runPipeline({ dur, ease, setMix: (m) => handle.setCrossfadeMix(m), done: () => handle.endCrossfade() });
		} else {
			// hard-cut: fade through black across the rebuild (today's baseline; also the boot/restore path).
			captureBase(config);
			transitions.snapActivePipeline(); // a hard-cut mid-transition should settle it first
			if (canvas) canvas.style.opacity = "0";
			await handle.rebuild(config);
			requestAnimationFrame(() =>
				requestAnimationFrame(() => {
					if (canvas) canvas.style.opacity = "1";
				})
			);
		}
		current.version = version;
		current.effect = effect;
		window.dispatchEvent(new CustomEvent("viz:mode", { detail: { ...current } }));
	} catch (err) {
		console.error("[matrix-music-viz] setMode failed:", err);
	} finally {
		building = false;
		if (pendingMode) {
			const p = pendingMode;
			pendingMode = null;
			setMode(p.version, p.effect, p.opts);
		}
	}
}

export function nextMode(dir = 1) {
	const i = MODES.indexOf(current.version);
	const n = (i + dir + MODES.length) % MODES.length;
	setMode(MODES[n], current.effect);
}
export function randomMode() {
	const pool = MODES.filter((m) => m !== current.version);
	setMode(pool[Math.floor(Math.random() * pool.length)], current.effect);
}

// ---- single per-frame master tick -----------------------------------------
// Subsystems register here; the renderer calls A.update() once per rendered frame.
const frameHooks = [];
export function onFrame(fn) {
	frameHooks.push(fn);
	return () => {
		const i = frameHooks.indexOf(fn);
		if (i >= 0) frameHooks.splice(i, 1);
	};
}

let lastT = NaN;
let fpsAccum = 0;
let fpsFrames = 0;
let fpsLast = 0;
const fpsReadout = document.getElementById("fps-readout");
const fpsHud = document.getElementById("fps-hud"); // lightweight ` -toggled HUD (separate from the D overlay)

A.update = (t) => {
	let dt = t - lastT;
	if (!(dt > 0) || dt > 0.25) dt = 1 / 60;
	lastT = t;
	A.features.time = t;
	A.features.dt = dt;

	for (let i = 0; i < frameHooks.length; i++) {
		try {
			frameHooks[i](t, dt);
		} catch (e) {
			console.error("[matrix-music-viz] frame hook error:", e);
		}
	}

	// MATRIX-VIZ: integrate the speed knobs into continuous phases (after the hooks have
	// set this frame's knobs). The rain/3D-depth shaders read these instead of
	// time*speed, so reactive speed changes stay smooth and only ever move forward.
	A.fallPhase += (A.knobs.fallSpeed ?? A.base.fallSpeed ?? 0.3) * (A.knobs.animationSpeed ?? A.base.animationSpeed ?? 1) * dt;
	A.animPhase += (A.knobs.animationSpeed ?? A.base.animationSpeed ?? 1) * dt;

	// FPS readout (throttled, ~2 Hz). One toFixed alloc per 0.5s — reused by BOTH the debug overlay
	// readout and the lightweight FPS HUD (no second rAF, no per-frame alloc).
	fpsAccum += dt;
	fpsFrames++;
	if (t - fpsLast > 0.5) {
		const fps = fpsFrames / fpsAccum;
		A.fps = fps;
		const fpsStr = fps.toFixed(0);
		if (fpsReadout) fpsReadout.textContent = fpsStr;
		if (fpsHud && !fpsHud.classList.contains("hidden")) fpsHud.textContent = fpsStr;
		fpsAccum = 0;
		fpsFrames = 0;
		fpsLast = t;
	}
};

// ---- shell UI wiring (panel, selects, keys, fullscreen) --------------------
function populateSelect(sel, values, labels, selected) {
	if (!sel) return;
	sel.innerHTML = "";
	for (const v of values) {
		const opt = document.createElement("option");
		opt.value = v;
		opt.textContent = labels?.[v] ?? v;
		if (v === selected) opt.selected = true;
		sel.appendChild(opt);
	}
}

function wireShell() {
	const modeSel = document.getElementById("mode-select");
	const effectSel = document.getElementById("effect-select");
	populateSelect(modeSel, MODES, MODE_LABELS, current.version);
	// Palette dropdown sourced from the palette store; repopulated when the library changes.
	const refreshPalettes = () => {
		const ids = palettes.list().map((r) => r.id);
		const labels = Object.fromEntries(palettes.list().map((r) => [r.id, r.builtin ? r.name : r.name + " *"]));
		populateSelect(effectSel, ids, labels, current.effect);
	};
	refreshPalettes();
	window.addEventListener("viz:palettes-changed", refreshPalettes);

	modeSel?.addEventListener("change", () => setMode(modeSel.value, current.effect));
	effectSel?.addEventListener("change", () => {
		if (effectSel.value === "random") palettes.rollRandom(); // re-roll a fresh random on (re)select
		setMode(current.version, effectSel.value);
	});
	document.getElementById("mode-prev")?.addEventListener("click", () => nextMode(-1));
	document.getElementById("mode-next")?.addEventListener("click", () => nextMode(1));
	document.getElementById("mode-random")?.addEventListener("click", () => randomMode());

	// keep selects synced when mode changes elsewhere (director, keys)
	window.addEventListener("viz:mode", (e) => {
		if (modeSel) modeSel.value = e.detail.version;
		if (effectSel) effectSel.value = e.detail.effect;
		const mr = document.getElementById("mode-readout");
		if (mr) mr.textContent = MODE_LABELS[e.detail.version] ?? e.detail.version;
	});

	// panel toggle
	const panel = document.getElementById("panel");
	const toggle = document.getElementById("panel-toggle");
	toggle?.addEventListener("click", () => panel?.classList.toggle("collapsed"));

	// debug overlay
	const overlay = document.getElementById("overlay");

	// keyboard shortcuts
	window.addEventListener("keydown", (e) => {
		if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
		switch (e.key.toLowerCase()) {
			case "tab":
				e.preventDefault();
				panel?.classList.toggle("collapsed");
				break;
			case "d":
				overlay?.classList.toggle("hidden");
				break;
			case "`": // lightweight FPS HUD (separate from the full Debug overlay on D)
				fpsHud?.classList.toggle("hidden");
				break;
			case "f":
				toggleFullscreen();
				break;
			// mode/preset/random keys (N/B, ⇧N, P/⇧P, R) live in app-init.js — they need the preset store.
		}
	});
}

function toggleFullscreen() {
	if (document.fullscreenElement == null) {
		document.documentElement.requestFullscreen?.();
	} else {
		document.exitFullscreen?.();
	}
}

// Global handle for debugging + cross-module access in the prototype.
export const MV = {
	A,
	MODES,
	MODE_LABELS,
	setMode,
	nextMode,
	randomMode,
	getHandle,
	onFrame,
	get current() {
		return current;
	},
};
window.MV = MV;

// ---- boot ------------------------------------------------------------------
// A fatal, user-facing message shown in the stage when the visualizer can't run (e.g. no WebGL),
// instead of a silent black screen. Static text via textContent (never innerHTML).
function webglSupported() {
	try {
		const c = document.createElement("canvas");
		return !!(window.WebGLRenderingContext && (c.getContext("webgl") || c.getContext("experimental-webgl")));
	} catch (e) {
		return false;
	}
}
function showFatal(msg) {
	console.error("[matrix-music-viz] " + msg);
	if (!stage) return;
	const box = document.createElement("div");
	box.className = "fatal-msg";
	box.textContent = msg;
	stage.appendChild(box);
}

async function boot() {
	palettes.init();
	wireShell();
	if (!webglSupported()) {
		showFatal("This visualizer needs WebGL, which isn't available or is disabled in this browser.");
		return;
	}
	// Restore the last session's mode + palette up-front (flash-free); the rest restores in wireSession.
	const s = session.load();
	const startVer = s && MODES.includes(s.mode) ? s.mode : "classic";
	const startPal = s && s.effect && palettes.list().some((p) => p.id === s.effect) ? s.effect : "plain";
	await setMode(startVer, startPal);
	if (!getHandle()) {
		showFatal("The visualizer failed to start (WebGL initialization error). See the console for details.");
		return;
	}
	// Subsystems are initialized after the first mode is up.
	try {
		const mod = await import("./app-init.js");
		await mod.initSubsystems(MV);
	} catch (e) {
		console.warn("[matrix-music-viz] subsystems not yet available:", e);
	}
}

if (document.readyState === "loading") {
	document.addEventListener("DOMContentLoaded", boot);
} else {
	boot();
}
