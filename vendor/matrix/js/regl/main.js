import { makeFullScreenQuad, makePipeline, setAssetBase } from "./utils.js"; // MATRIX-VIZ
import { A } from "../reactive.js"; // MATRIX-VIZ: shared reactive bridge

import makeRain from "./rainPass.js";
import makeBloomPass from "./bloomPass.js";
import makePalettePass from "./palettePass.js";
import makeStripePass from "./stripePass.js";
import makeImagePass from "./imagePass.js";
import makeQuiltPass from "./quiltPass.js";
import makeMirrorPass from "./mirrorPass.js";
import { setupCamera, cameraCanvas, cameraAspectRatio } from "../camera.js";
import getLKG from "./lkgHelper.js";

const effects = {
	none: null,
	plain: makePalettePass,
	palette: makePalettePass,
	customStripes: makeStripePass,
	stripes: makeStripePass,
	spectrum: makeStripePass, // MATRIX-VIZ: was "pride"; "trans"/"transPride" removed
	image: makeImagePass,
	mirror: makeMirrorPass,
};

const loadJS = (src) =>
	new Promise((resolve, reject) => {
		const tag = document.createElement("script");
		tag.onload = resolve;
		tag.onerror = reject;
		tag.src = src;
		document.body.appendChild(tag);
	});

export default async (canvas, config) => {
	const base = config.assetBase ?? ""; // MATRIX-VIZ: asset base path
	setAssetBase(base); // MATRIX-VIZ
	await Promise.all([loadJS(base + "lib/regl.min.js"), loadJS(base + "lib/gl-matrix.js")]); // MATRIX-VIZ

	// MATRIX-VIZ: ONE persistent regl context + canvas for the whole app life. Mode
	// switches rebuild only the PIPELINE (see rebuild() below), never the WebGL context.
	// Recreating the context per switch was unreliable — it churns the browser's WebGL
	// context budget / GPU memory and intermittently produced black renders after a
	// handful of switches. dimensions starts {0,0} so the first frame always sizes FBOs.
	const dimensions = { width: 0, height: 0 };

	// Mutable render state, swapped atomically on rebuild.
	const state = {
		config,
		pipeline: null,
		drawToScreen: null,
		targetFrameTime: 1000 / config.fps,
		// MATRIX-VIZ (plan-transitions): during a mode/palette crossfade, the SECOND pipeline +
		// composite mix live here; null = the normal single-pipeline path. See beginCrossfade below.
		crossfade: null,
	};

	const resize = () => {
		const devicePixelRatio = window.devicePixelRatio ?? 1;
		canvas.width = Math.ceil(canvas.clientWidth * devicePixelRatio * (state.config.resolution ?? 1));
		canvas.height = Math.ceil(canvas.clientHeight * devicePixelRatio * (state.config.resolution ?? 1));
	};
	window.onresize = resize;
	// MATRIX-VIZ: removed the window-level double-click-to-fullscreen-the-CANVAS. Fullscreen is owned by
	// the app (app/fullscreen.js) — a single document-fullscreen mode entered via the F key or a
	// double-click bound to the STAGE only. The original fired on ANY double-click (incl. on the UI
	// controls) and fullscreened only the canvas, hiding the whole UI. See MODIFICATIONS.md.

	if (config.useCamera) {
		await setupCamera();
	}

	const extensions = ["OES_texture_half_float", "OES_texture_half_float_linear"];
	// These extensions are also needed, but Safari misreports that they are missing
	const optionalExtensions = ["EXT_color_buffer_half_float", "WEBGL_color_buffer_float", "OES_standard_derivatives"];

	switch (config.testFix) {
		case "fwidth_10_1_2022_A":
			extensions.push("OES_standard_derivatives");
			break;
		case "fwidth_10_1_2022_B":
			optionalExtensions.forEach((ext) => extensions.push(ext));
			extensions.length = 0;
			break;
	}

	const regl = createREGL({ canvas, pixelRatio: 1, extensions, optionalExtensions });

	const cameraTex = regl.texture(cameraCanvas);
	const lkg = await getLKG(config.useHoloplay, true);

	// MATRIX-VIZ: persistent 1D spectrum texture (one luminance texel per FFT bin), updated
	// each frame from A.spectrum and sampled per-column by the raindrop shader (Spectrum Rain).
	const specBins = A.spectrum.length;
	const specBytes = new Uint8Array(specBins);
	const spectrumTex = regl.texture({ width: specBins, height: 1, format: "luminance", type: "uint8", min: "linear", mag: "linear", wrap: "clamp", data: specBytes });
	// MATRIX-VIZ: reused upload descriptor (data === specBytes, mutated in place) so the
	// per-frame spectrum update never allocates a fresh options object.
	const specUpload = { width: specBins, height: 1, format: "luminance", type: "uint8", min: "linear", mag: "linear", wrap: "clamp", data: specBytes };

	// MATRIX-VIZ (plan-transitions): the Glyph song-title mask. A 2D canvas of the title text (white on
	// black) is uploaded here; the rain render pass boosts glyph brightness where the mask is lit (scaled
	// by A.title.amount), burning the title into the code. Starts 1×1 black (no title). setTitleMask uploads.
	const titleMaskTex = regl.texture({ width: 1, height: 1, format: "rgba", min: "linear", mag: "linear", wrap: "clamp", data: [0, 0, 0, 255] });
	const setTitleMask = (source) => {
		try {
			titleMaskTex({ data: source, min: "linear", mag: "linear", wrap: "clamp", flipY: false });
		} catch (e) {
			console.warn("[matrix-viz] setTitleMask failed:", e);
		}
	};

	// All this takes place in a full screen quad.
	// MATRIX-VIZ: inject audio-reactive uniforms here. REGL scope propagation makes
	// these available to EVERY nested pass shader (same mechanism that feeds `time`).
	// Shaders that don't declare a given uniform simply ignore it.
	// MATRIX-VIZ: reused scratch for the vec2 uShockOrigin uniform (avoid a per-frame array alloc).
	const shockOrigin = [0.5, 0.5];
	const fullScreenQuad = makeFullScreenQuad(regl, {
		uReactive: () => (A.reactive ? 1 : 0),
		uIntensity: () => A.intensity,
		uTime: () => A.features.time,
		uFallPhase: () => A.fallPhase,
		uAnimPhase: () => A.animPhase,
		uBass: () => A.features.bass,
		uLowMid: () => A.features.lowMid,
		uMid: () => A.features.mid,
		uHighMid: () => A.features.highMid,
		uTreble: () => A.features.treble,
		uLevel: () => A.features.level,
		uCentroid: () => A.features.centroid,
		uFlux: () => A.features.flux,
		uBeat: () => A.features.beat,
		uBeatPulse: () => A.features.beatPulse,
		uBeatBass: () => A.features.beatBass,
		uBeatPhase: () => A.features.beatPhase,
		uOnset: () => A.features.onset,
		uEnergy: () => A.features.energy,
		uPulse: () => A.shader.pulse,
		uShockPhase: () => A.shader.shockPhase,
		uShockStrength: () => A.shader.shockStrength,
		uShockOrigin: () => {
			shockOrigin[0] = A.shader.shockX;
			shockOrigin[1] = A.shader.shockY;
			return shockOrigin;
		},
		uRipple: () => A.shader.ripple,
		uGlyphJitter: () => A.shader.glyphJitter,
		uBassWarp: () => A.shader.bassWarp,
		uHueShift: () => A.shader.hueShift,
		uColorBleed: () => A.shader.colorBleed,
		uSpectrumAmount: () => A.shader.spectrum,
		uWindSway: () => A.shader.windSway,
		uSpawnAmount: () => A.shader.spawn,
		uBeatClock: () => A.features.beatClock,
		uBeatSeed: () => A.features.beatCount,
		uPulseWarp: () => A.shader.pulseWarp,
	});

	// MATRIX-VIZ: build a pipeline for a config while recording every GPU resource it
	// allocates (FBOs + textures), so a later rebuild can free them. We transiently wrap
	// regl.framebuffer/regl.texture for the duration of the (sync factory calls + async
	// asset loads); the frame loop never allocates these, so only this pipeline's
	// resources are captured. Commands/programs are deduped by regl's own source cache.
	const buildPipeline = async (cfg) => {
		const resources = [];
		const origFb = regl.framebuffer;
		const origTex = regl.texture;
		regl.framebuffer = function (...a) {
			const r = origFb.apply(this, a);
			resources.push(r);
			return r;
		};
		regl.texture = function (...a) {
			const r = origTex.apply(this, a);
			resources.push(r);
			return r;
		};
		let pipeline, drawToScreen;
		try {
			// MATRIX-VIZ: a "#roll"/"#rev" cache-bust suffix routes by the BASE effect name (the full
			// string stays the pipeline-cache key), so a re-rolled stripe/ramp rebuilds with new colors.
			const baseEffect = (cfg.effect || "palette").split("#")[0];
			const effectName = baseEffect in effects ? baseEffect : "palette";
			const context = { regl, config: cfg, lkg, cameraTex, cameraAspectRatio, spectrumTex, titleMaskTex };
			pipeline = makePipeline(context, [makeRain, makeBloomPass, effects[effectName], makeQuiltPass]);
			drawToScreen = regl({ uniforms: { tex: pipeline[pipeline.length - 1].outputs.primary } });
			await Promise.all(pipeline.map((step) => step.ready));
		} finally {
			regl.framebuffer = origFb;
			regl.texture = origTex;
		}
		return { pipeline, drawToScreen, resources, sizedW: 0, sizedH: 0 };
	};

	// Size a pipeline's FBOs to the canvas, but skip if it's already at that size (cache
	// hits returning to the same window size). Redundant resizes reallocate FBOs and churn
	// GL state for no reason (and emit transient "no buffer bound" warnings).
	const sizePipeline = (entry) => {
		if (canvas.width > 0 && canvas.height > 0) {
			if (entry.sizedW !== canvas.width || entry.sizedH !== canvas.height) {
				for (const step of entry.pipeline) step.setSize(canvas.width, canvas.height);
				entry.sizedW = canvas.width;
				entry.sizedH = canvas.height;
			}
			dimensions.width = canvas.width;
			dimensions.height = canvas.height;
		} else {
			dimensions.width = 0;
			dimensions.height = 0; // force the frame loop to size on first real frame
		}
	};

	// MATRIX-VIZ: build-once-per-mode cache. Switching modes reuses a previously built
	// pipeline instead of allocating + freeing one each time. This makes switches instant,
	// bounds GPU memory by the number of distinct modes actually used, and avoids the regl
	// resource-destroy churn (each .destroy() briefly unbinds GL state -> transient
	// "no buffer bound to attribute" warnings). Keyed by version|effect (the baked-in
	// structure); reactive knobs stay live via uniform functions, so one cached pipeline
	// per mode serves every audio state.
	const pipelineCache = new Map();
	const CACHE_MAX = 24;
	const getPipeline = async (cfg) => {
		const key = `${cfg.version ?? "classic"}|${cfg.effect ?? "palette"}`;
		const hit = pipelineCache.get(key);
		if (hit) {
			pipelineCache.delete(key); // refresh LRU order
			pipelineCache.set(key, hit);
			return hit;
		}
		const entry = await buildPipeline(cfg);
		pipelineCache.set(key, entry);
		if (pipelineCache.size > CACHE_MAX) {
			const oldestKey = pipelineCache.keys().next().value;
			const evicted = pipelineCache.get(oldestKey);
			pipelineCache.delete(oldestKey);
			if (evicted)
				setTimeout(() => {
					for (const r of evicted.resources) {
						try {
							r.destroy();
						} catch (e) {}
					}
				}, 300);
		}
		return entry;
	};

	// MATRIX-VIZ (plan-transitions): the crossfade composite. Blends two pipelines' final FBOs to the
	// screen by `uMix` (0 = old pipeline, 1 = new). Used only during a mode / cross-pass-type palette
	// transition; the normal path draws a single pipeline (drawToScreen). Reused prop object — no alloc.
	const crossfadeDraw = regl({
		vert: `
			precision mediump float;
			attribute vec2 aPosition;
			varying vec2 vUV;
			void main() { vUV = 0.5 * (aPosition + 1.0); gl_Position = vec4(aPosition, 0, 1); }`,
		frag: `
			precision mediump float;
			varying vec2 vUV;
			uniform sampler2D texA;
			uniform sampler2D texB;
			uniform float uMix;
			void main() { gl_FragColor = mix(texture2D(texA, vUV), texture2D(texB, vUV), uMix); }`,
		attributes: { aPosition: [-4, -4, 4, -4, 0, 4] },
		count: 3,
		uniforms: { texA: regl.prop("texA"), texB: regl.prop("texB"), uMix: regl.prop("uMix") },
		depth: { enable: false },
	});
	const crossfadeProps = { texA: null, texB: null, uMix: 0 };

	// First pipeline.
	resize();
	let built = await getPipeline(config);
	state.entry = built;
	state.pipeline = built.pipeline;
	state.drawToScreen = built.drawToScreen;
	sizePipeline(built);

	let last = NaN;
	const tick = regl.frame(({ viewportWidth, viewportHeight }) => {
		if (state.config.once) {
			tick.cancel();
		}

		A.update(regl.now()); // MATRIX-VIZ: audio sample + mapping + director, once per frame

		// MATRIX-VIZ: push the latest spectrum into the 1D texture (Spectrum Rain). Gated —
		// mapping.apply already ran this frame, so A.shader.spectrum is current; when the effect
		// is off it's 0 and we skip the fill + upload entirely. specUpload is reused (no per-frame
		// object alloc); its .data is specBytes, mutated in place below.
		if (A.shader.spectrum > 0) {
			for (let i = 0; i < specBins; i++) {
				const v = A.spectrum[i] * 255;
				specBytes[i] = v < 0 ? 0 : v > 255 ? 255 : v;
			}
			spectrumTex(specUpload);
		}

		const now = regl.now() * 1000;
		if (isNaN(last)) last = now;

		const shouldRender = state.config.fps >= 60 || now - last >= state.targetFrameTime || state.config.once == true;
		if (shouldRender) {
			while (now - state.targetFrameTime > last) last += state.targetFrameTime;
		}

		if (state.config.useCamera) cameraTex(cameraCanvas);
		if (dimensions.width !== viewportWidth || dimensions.height !== viewportHeight) {
			dimensions.width = viewportWidth;
			dimensions.height = viewportHeight;
			for (const step of state.pipeline) step.setSize(viewportWidth, viewportHeight);
			if (state.entry) {
				state.entry.sizedW = viewportWidth;
				state.entry.sizedH = viewportHeight;
			}
			// MATRIX-VIZ: keep the crossfade's second pipeline sized to the canvas too.
			if (state.crossfade) {
				for (const step of state.crossfade.entryB.pipeline) step.setSize(viewportWidth, viewportHeight);
				state.crossfade.entryB.sizedW = viewportWidth;
				state.crossfade.entryB.sizedH = viewportHeight;
			}
		}
		if (state.crossfade) {
			// MATRIX-VIZ (plan-transitions): render BOTH pipelines this frame into their final FBOs,
			// then composite to the screen by the eased mix (boot drives the mix via setCrossfadeMix).
			const entryB = state.crossfade.entryB;
			fullScreenQuad(() => {
				for (const step of state.pipeline) step.execute(shouldRender);
				for (const step of entryB.pipeline) step.execute(shouldRender);
			});
			crossfadeProps.texA = state.pipeline[state.pipeline.length - 1].outputs.primary;
			crossfadeProps.texB = entryB.pipeline[entryB.pipeline.length - 1].outputs.primary;
			crossfadeProps.uMix = state.crossfade.mix;
			crossfadeDraw(crossfadeProps);
		} else {
			fullScreenQuad(() => {
				for (const step of state.pipeline) step.execute(shouldRender);
				state.drawToScreen();
			});
		}
	});

	// MATRIX-VIZ: rebuild the pipeline for a new mode/config on the SAME context.
	const rebuild = async (newConfig) => {
		newConfig.assetBase = newConfig.assetBase ?? base;
		const next = await getPipeline(newConfig); // cache hit = instant + no allocation
		built = next;
		state.entry = next;
		state.config = newConfig;
		state.targetFrameTime = 1000 / newConfig.fps;
		state.pipeline = next.pipeline;
		state.drawToScreen = next.drawToScreen;
		resize(); // resolution may differ between modes
		sizePipeline(next);
	};

	// MATRIX-VIZ (plan-transitions): the mode/palette crossfade API. boot calls beginCrossfade(newConfig)
	// to build the second pipeline and enter the dual-render path, drives setCrossfadeMix(0..1) from the
	// frame clock, and calls endCrossfade() to settle on the new pipeline.
	const finalizeCrossfade = () => {
		if (!state.crossfade) return;
		const b = state.crossfade.entryB;
		built = b;
		state.entry = b;
		state.config = state.crossfade.config;
		state.targetFrameTime = 1000 / state.config.fps;
		state.pipeline = b.pipeline;
		state.drawToScreen = b.drawToScreen;
		state.crossfade = null;
		resize(); // the new mode's resolution may differ; settle the canvas + re-size the now-sole pipeline
		sizePipeline(b);
	};
	const beginCrossfade = async (newConfig) => {
		newConfig.assetBase = newConfig.assetBase ?? base;
		if (state.crossfade) finalizeCrossfade(); // snap any in-flight crossfade to its target first (latest-wins)
		const entryB = await getPipeline(newConfig); // cache hit = instant
		sizePipeline(entryB); // size B to the current canvas (A keeps the canvas size during the fade)
		state.crossfade = { entryB, mix: 0, config: newConfig };
	};
	const setCrossfadeMix = (m) => {
		if (state.crossfade) state.crossfade.mix = m < 0 ? 0 : m > 1 ? 1 : m;
	};
	const endCrossfade = () => finalizeCrossfade();
	const isCrossfading = () => !!state.crossfade;

	// MATRIX-VIZ (plan-transitions): re-key the LIVE pipeline to a new effect (palette) WITHOUT a rebuild.
	// The end of an in-place gradient morph: the live pipeline's palette texture is already re-coloured to
	// the target, so we move its cache entry to the new key (dropping any prior entry there) + update
	// state.config. The compute buffers stay continuous (no pop); re-selecting the OLD palette later
	// rebuilds a fresh, correctly-coloured pipeline (no cache poisoning).
	const rekeyActive = (newConfig) => {
		newConfig.assetBase = newConfig.assetBase ?? base;
		const oldKey = `${state.config.version ?? "classic"}|${state.config.effect ?? "palette"}`;
		const newKey = `${newConfig.version ?? "classic"}|${newConfig.effect ?? "palette"}`;
		if (oldKey !== newKey) {
			const entry = pipelineCache.get(oldKey);
			pipelineCache.delete(oldKey);
			const prior = pipelineCache.get(newKey);
			if (prior && prior !== entry) {
				pipelineCache.delete(newKey);
				for (const r of prior.resources) {
					try {
						r.destroy();
					} catch (e) {}
				}
			}
			if (entry) pipelineCache.set(newKey, entry);
		}
		state.config = newConfig;
		state.targetFrameTime = 1000 / newConfig.fps;
	};

	const destroy = () => {
		try {
			tick.cancel();
		} catch (e) {}
		try {
			regl.destroy();
		} catch (e) {}
	};
	return { regl, tick, destroy, rebuild, beginCrossfade, setCrossfadeMix, endCrossfade, isCrossfading, rekeyActive, setTitleMask, get config() { return state.config; } };
};
