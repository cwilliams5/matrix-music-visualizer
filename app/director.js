// matrix-music-viz — the director.
// AVS/Milkdrop-style automatic rotation of modes, presets, and post-effect palettes, driven by a
// timer AND by musical structure (energy drops/builds). Two orthogonal knobs:
//   - WEIGHTING: each fire rolls each enabled axis by its own frequency (freqModes/Presets/Palettes).
//   - METHOD: how the next value is chosen once an axis changes — random / shuffle / cycle.
// All tuning is exposed in the Advanced panel and persisted (localStorage + Export/Import).

import { A } from "../vendor/matrix/js/reactive.js";
import { store } from "./presets-store.js";
import { palettes } from "./palette-store.js";

const VOLUMETRIC = ["3d", "trinity", "morpheus", "bugs"];
// Palettes the director may rotate through come from the palette store — everything but the
// debug/anatomy view (palettes.rotatableIds()), so auto-rotation never lands on it.
const LS_KEY = "matrixviz.director.v1";
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// Tunable config (everything except the master `enabled` + transient cursors); persisted + exported.
const CONFIG_KEYS = ["interval", "onDrop", "onTrackChange", "rotateModes", "rotatePresets", "rotatePalettes", "usePresetMode", "usePresetPalette", "method", "freqModes", "freqPresets", "freqPalettes", "guaranteeChange", "dropSensitivity", "modePool", "palettePool", "presetPool"];

export const director = {
	enabled: false, // master on/off — not in the director's own config blob; the SESSION store persists it
	// (plan-grabbag C1: "lose nothing on refresh"), so a reload resumes the director if it was running.
	interval: 30, // seconds between timed switches
	onDrop: true, // also switch on big musical drops/builds
	onTrackChange: true, // also switch when the track changes

	rotateModes: true, // per-axis on/off (the quick checkboxes)
	rotatePresets: true,
	rotatePalettes: true,
	usePresetMode: false, // honor a picked preset's jumpMode? default OFF (the director owns the mode axis)
	usePresetPalette: false, // honor a picked preset's jumpPalette? default OFF (director owns palette)

	method: "shuffle", // "random" | "shuffle" | "cycle" — HOW the next value is chosen
	freqModes: 0.55, // per-axis WEIGHTING: chance the axis changes on a given fire (0..1)
	freqPresets: 1.0,
	freqPalettes: 0.5,
	guaranteeChange: true, // if a fire rolled nothing, force the top-priority enabled axis
	dropSensitivity: 0.5, // 0 (insensitive) .. 1 (hair-trigger) -> energy-jump threshold
	modePool: null, // which mode ids the director may pick (null -> all; set in initDirector)
	palettePool: null, // which palette ids the director may pick (null -> all aesthetic)
	presetPool: null, // which preset ids the director may pick (null -> all non-generative; Random opt-in)

	lastSwitch: 0,
	lastDrop: -100,
	prevDelta: 0,
	_mv: null,
	_bags: {}, // per-axis shuffle bags
	_sync: null, // initDirector installs a "push state -> UI controls" fn here

	// Energy-jump threshold for a drop-triggered switch, from dropSensitivity (0.5 ≈ the old 0.26).
	dropThreshold() {
		return 0.45 - this.dropSensitivity * 0.36; // sens 0 -> 0.45, 0.5 -> 0.27, 1 -> 0.09
	},

	tick(t, dt) {
		if (!this.enabled) return;
		const f = A.features;

		// timed switch
		if (t - this.lastSwitch > this.interval) {
			this.switchNow(t, "timer");
			return;
		}

		// musical drop/build: rising edge of (short energy - long energy)
		if (this.onDrop && f.playing && t - this.lastDrop > 10 && t - this.lastSwitch > 6) {
			const delta = f.energy - f.energySlow;
			const thr = this.dropThreshold();
			if (delta > thr && this.prevDelta <= thr && f.beatPulse > 0.4) {
				this.lastDrop = t;
				this.switchNow(t, "drop");
				this.prevDelta = delta;
				return;
			}
			this.prevDelta = delta;
		}
	},

	// Switch on track change — a distinct event trigger (not the timer/drop). Called by the player wiring.
	trackChanged() {
		if (this.enabled && this.onTrackChange) this.switchNow(A.features.time, "track");
	},

	// Pick the next value for an axis per the current method. items = full ordered list; current =
	// the active value; isOk = optional compatibility filter. random = uniform != current; cycle =
	// next in list order (skipping !ok / current); shuffle = a reshuffling bag, each visited once.
	_next(axisKey, items, current, isOk) {
		const ok = isOk || (() => true);
		const pool = items.filter((x) => ok(x));
		if (!pool.length) return current;

		if (this.method === "cycle") {
			let i = items.indexOf(current);
			for (let n = 0; n < items.length; n++) {
				i = (i + 1) % items.length;
				if (items[i] !== current && ok(items[i])) return items[i];
			}
			return pool[0];
		}

		if (this.method === "shuffle") {
			let bag = this._bags[axisKey];
			for (let guard = 0; guard < items.length * 2 + 2; guard++) {
				if (!bag || !bag.length) {
					bag = items.slice();
					for (let j = bag.length - 1; j > 0; j--) {
						const r = Math.floor(Math.random() * (j + 1));
						const tmp = bag[j];
						bag[j] = bag[r];
						bag[r] = tmp;
					}
					this._bags[axisKey] = bag;
				}
				const cand = bag.pop();
				if (cand !== current && ok(cand)) return cand;
			}
			return pool[Math.floor(Math.random() * pool.length)];
		}

		// random (default)
		const cand = pool.filter((x) => x !== current);
		const arr = cand.length ? cand : pool;
		return arr[Math.floor(Math.random() * arr.length)];
	},

	switchNow(t, reason) {
		this.lastSwitch = t;
		const MV = this._mv;
		if (!MV) return;

		let version = MV.current.version;
		let effect = MV.current.effect;

		// Roll each enabled axis by its frequency.
		let changeMode = this.rotateModes && Math.random() < this.freqModes;
		let changePalette = this.rotatePalettes && Math.random() < this.freqPalettes;
		let changePreset = this.rotatePresets && Math.random() < this.freqPresets;

		// "Always change something": if nothing rolled, force the top-priority enabled axis.
		if (this.guaranteeChange && !changeMode && !changePalette && !changePreset) {
			if (this.rotatePresets) changePreset = true;
			else if (this.rotateModes) changeMode = true;
			else if (this.rotatePalettes) changePalette = true;
		}

		if (changeMode) {
			const pool = MV.MODES.filter((m) => this.modePool.includes(m));
			version = this._next("mode", pool.length ? pool : MV.MODES, MV.current.version);
		}
		if (changePalette) {
			const rotatable = palettes.rotatableIds();
			const pool = rotatable.filter((p) => this.palettePool.includes(p));
			effect = this._next("palette", pool.length ? pool : rotatable, MV.current.effect);
		}
		if (changePalette && effect === "random") palettes.rollRandom(); // wildcard: fresh roll each pick
		if (changeMode || changePalette) MV.setMode(version, effect, { source: "director" });

		// A mode change always re-picks a preset (a new mode — especially a 3D one — wants a
		// compatible preset), even if the preset axis itself didn't roll this fire.
		if (changePreset || changeMode) this.pickPreset(version, changeMode);

		window.dispatchEvent(new CustomEvent("viz:director", { detail: { reason, version, effect } }));
	},

	// Mode-aware preset choice via the current method. 2D modes exclude 3D-camera presets; 3D modes
	// include everything. In RANDOM method a 3D mode also biases toward 3D presets so the camera
	// showcases (cycle/shuffle just traverse the compatible pool — 3D presets are in the rotation).
	// 2D modes exclude 3D-camera presets; 3D modes include everything. Compatibility is DERIVED from
	// a preset's jumpMode (volumetric => "prefers 3D"). By default the director owns mode + palette
	// (switchMode/switchPalette false, so a preset never triggers a rebuild); usePresetMode /
	// usePresetPalette let a picked preset's scene bindings apply instead.
	pickPreset(version, modeChanged) {
		const vol = VOLUMETRIC.includes(version);
		// Honor the preset pool: only pick ids the user left enabled. The generative Random preset is in
		// the pool ONLY if explicitly opted in (off by default) — when picked, setActive('random') rolls a
		// FRESH generative preset each time (the same wildcard behavior the Random palette has).
		const pool = this.presetPool;
		const all = store.list().filter((r) => !pool || pool.includes(r.id));
		if (!all.length) return;
		const prefersVol = (r) => VOLUMETRIC.includes(r.jumpMode);
		const opts = { switchMode: this.usePresetMode, switchPalette: this.usePresetPalette, source: "director" };
		if (vol && this.method === "random") {
			const volPresets = all.filter(prefersVol);
			if (volPresets.length && Math.random() < (modeChanged ? 0.6 : 0.3)) {
				store.setActive(volPresets[Math.floor(Math.random() * volPresets.length)].id, opts);
				return;
			}
		}
		const okId = (id) => {
			const r = all.find((x) => x.id === id);
			return !!r && (vol || !prefersVol(r));
		};
		const id = this._next("preset", all.map((r) => r.id), store.activeId, okId);
		if (id) store.setActive(id, opts); // setActive('random') re-rolls a wildcard generative preset
	},

	// ---- config: persist (localStorage) + export/import ----
	getConfig() {
		const c = {};
		for (const k of CONFIG_KEYS) c[k] = this[k];
		return c;
	},
	setConfig(c, opts = {}) {
		if (!c) return;
		if (typeof c.interval === "number") this.interval = Math.max(5, Math.min(120, c.interval));
		if (typeof c.onDrop === "boolean") this.onDrop = c.onDrop;
		if (typeof c.onTrackChange === "boolean") this.onTrackChange = c.onTrackChange;
		if (typeof c.rotateModes === "boolean") this.rotateModes = c.rotateModes;
		if (typeof c.rotatePresets === "boolean") this.rotatePresets = c.rotatePresets;
		if (typeof c.rotatePalettes === "boolean") this.rotatePalettes = c.rotatePalettes;
		if (typeof c.usePresetMode === "boolean") this.usePresetMode = c.usePresetMode;
		if (typeof c.usePresetPalette === "boolean") this.usePresetPalette = c.usePresetPalette;
		if (c.method === "random" || c.method === "shuffle" || c.method === "cycle") this.method = c.method;
		if (typeof c.freqModes === "number") this.freqModes = clamp01(c.freqModes);
		if (typeof c.freqPresets === "number") this.freqPresets = clamp01(c.freqPresets);
		if (typeof c.freqPalettes === "number") this.freqPalettes = clamp01(c.freqPalettes);
		if (typeof c.guaranteeChange === "boolean") this.guaranteeChange = c.guaranteeChange;
		if (typeof c.dropSensitivity === "number") this.dropSensitivity = clamp01(c.dropSensitivity);
		if (Array.isArray(c.modePool)) this.modePool = this._mv ? c.modePool.filter((m) => this._mv.MODES.includes(m)) : c.modePool.slice();
		if (Array.isArray(c.palettePool)) this.palettePool = c.palettePool.filter((p) => palettes.rotatableIds().includes(p));
		if (Array.isArray(c.presetPool)) this.presetPool = c.presetPool.filter((p) => store.poolableIds().includes(p));
		if (this.modePool && !this.modePool.length && this._mv) this.modePool = [...this._mv.MODES];
		if (this.palettePool && !this.palettePool.length) this.palettePool = [...palettes.defaultPoolIds()];
		if (this.presetPool && !this.presetPool.length) this.presetPool = [...store.defaultPoolIds()];
		this._bags = {}; // lists/method may differ now; reset shuffle bags
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

export function initDirector(MV) {
	director._mv = MV;
	MV.onFrame((t, dt) => director.tick(t, dt));

	const $ = (id) => document.getElementById(id);
	const els = {
		toggle: $("director-toggle"),
		interval: $("director-interval"),
		intervalVal: $("director-interval-val"),
		onDrop: $("director-ondrop"),
		onTrackChange: $("director-ontrackchange"),
		modes: $("director-modes"),
		presets: $("director-presets"),
		palettes: $("director-palettes"),
		freqModes: $("director-freq-modes"),
		freqModesVal: $("director-freq-modes-val"),
		freqPresets: $("director-freq-presets"),
		freqPresetsVal: $("director-freq-presets-val"),
		freqPalettes: $("director-freq-palettes"),
		freqPalettesVal: $("director-freq-palettes-val"),
		guarantee: $("director-guarantee"),
		drop: $("director-dropsens"),
		dropVal: $("director-dropsens-val"),
		usePresetMode: $("director-usepreset-mode"),
		usePresetPalette: $("director-usepreset-palette"),
	};

	const setFreq = (slider, label, val, enabled) => {
		const pct = Math.round(val * 100);
		if (slider) {
			slider.value = pct;
			slider.disabled = !enabled;
		}
		if (label) label.textContent = pct + "%";
	};

	// Push director state -> all controls (after load / import).
	const sync = () => {
		if (els.interval) els.interval.value = director.interval;
		if (els.intervalVal) els.intervalVal.textContent = director.interval;
		if (els.onDrop) els.onDrop.checked = director.onDrop;
		if (els.onTrackChange) els.onTrackChange.checked = director.onTrackChange;
		if (els.modes) els.modes.checked = director.rotateModes;
		if (els.presets) els.presets.checked = director.rotatePresets;
		if (els.palettes) els.palettes.checked = director.rotatePalettes;
		document.querySelectorAll("[data-director-method]").forEach((b) => b.classList.toggle("active", b.dataset.directorMethod === director.method));
		setFreq(els.freqModes, els.freqModesVal, director.freqModes, director.rotateModes);
		setFreq(els.freqPresets, els.freqPresetsVal, director.freqPresets, director.rotatePresets);
		setFreq(els.freqPalettes, els.freqPalettesVal, director.freqPalettes, director.rotatePalettes);
		if (els.guarantee) els.guarantee.checked = director.guaranteeChange;
		if (els.drop) {
			els.drop.value = director.dropSensitivity;
			els.drop.disabled = !director.onDrop;
		}
		if (els.dropVal) els.dropVal.textContent = director.dropSensitivity.toFixed(2);
		if (els.usePresetMode) els.usePresetMode.checked = director.usePresetMode;
		if (els.usePresetPalette) els.usePresetPalette.checked = director.usePresetPalette;
	};
	// Pool checklists (which modes / palettes the director may pick) — built dynamically.
	const labelMode = (id) => (MV.MODE_LABELS && MV.MODE_LABELS[id]) || id;
	const labelPalette = (id) => palettes.get(id).name;
	const labelPreset = (id) => {
		const r = store.list().find((x) => x.id === id);
		return r ? (r.builtin ? r.name : r.name + " *") : id;
	};
	const buildPool = (hostId, items, labelOf, poolKey) => {
		const host = document.getElementById(hostId);
		if (!host) return;
		host.innerHTML = "";
		for (const id of items) {
			const lab = document.createElement("label");
			lab.className = "pool-item";
			lab.title = "Include “" + labelOf(id) + "” in the director's rotation"; // D: tooltip per pool entry
			const cb = document.createElement("input");
			cb.type = "checkbox";
			cb.checked = (director[poolKey] || []).includes(id);
			cb.addEventListener("change", () => {
				const pool = director[poolKey];
				const i = pool.indexOf(id);
				if (cb.checked && i < 0) pool.push(id);
				else if (!cb.checked && i >= 0) {
					if (pool.length > 1) pool.splice(i, 1);
					else cb.checked = true; // keep at least one in the pool
				}
				director._persist();
			});
			const span = document.createElement("span");
			span.textContent = labelOf(id);
			lab.appendChild(cb);
			lab.appendChild(span);
			host.appendChild(lab);
		}
	};
	const buildPools = () => {
		buildPool("director-mode-pool", MV.MODES, labelMode, "modePool");
		buildPool("director-palette-pool", palettes.rotatableIds(), labelPalette, "palettePool");
		buildPool("director-preset-pool", store.poolableIds(), labelPreset, "presetPool");
	};
	director._sync = () => {
		sync();
		buildPools();
	};

	els.toggle?.addEventListener("change", () => {
		director.enabled = els.toggle.checked;
		director.lastSwitch = A.features.time; // reset timer so it doesn't fire instantly
	});
	els.interval?.addEventListener("input", () => {
		director.interval = parseFloat(els.interval.value);
		if (els.intervalVal) els.intervalVal.textContent = els.interval.value;
		director._persist();
	});
	els.onDrop?.addEventListener("change", (e) => {
		director.onDrop = e.target.checked;
		if (els.drop) els.drop.disabled = !e.target.checked; // grey the sensitivity slider when drops are off
		director._persist();
	});
	els.onTrackChange?.addEventListener("change", (e) => {
		director.onTrackChange = e.target.checked;
		director._persist();
	});

	const wireRotate = (cb, key, slider) => {
		cb?.addEventListener("change", (e) => {
			director[key] = e.target.checked;
			if (slider) slider.disabled = !e.target.checked;
			director._persist();
		});
	};
	wireRotate(els.modes, "rotateModes", els.freqModes);
	wireRotate(els.presets, "rotatePresets", els.freqPresets);
	wireRotate(els.palettes, "rotatePalettes", els.freqPalettes);

	const wireFreq = (slider, label, key) => {
		slider?.addEventListener("input", () => {
			director[key] = parseFloat(slider.value) / 100;
			if (label) label.textContent = slider.value + "%";
			director._persist();
		});
	};
	wireFreq(els.freqModes, els.freqModesVal, "freqModes");
	wireFreq(els.freqPresets, els.freqPresetsVal, "freqPresets");
	wireFreq(els.freqPalettes, els.freqPalettesVal, "freqPalettes");

	els.guarantee?.addEventListener("change", (e) => {
		director.guaranteeChange = e.target.checked;
		director._persist();
	});
	els.drop?.addEventListener("input", () => {
		director.dropSensitivity = parseFloat(els.drop.value);
		if (els.dropVal) els.dropVal.textContent = parseFloat(els.drop.value).toFixed(2);
		director._persist();
	});
	els.usePresetMode?.addEventListener("change", (e) => {
		director.usePresetMode = e.target.checked;
		director._persist();
	});
	els.usePresetPalette?.addEventListener("change", (e) => {
		director.usePresetPalette = e.target.checked;
		director._persist();
	});

	// Method segmented buttons.
	document.querySelectorAll("[data-director-method]").forEach((b) => {
		b.addEventListener("click", () => {
			director.method = b.dataset.directorMethod;
			director._bags = {};
			document.querySelectorAll("[data-director-method]").forEach((x) => x.classList.toggle("active", x === b));
			director._persist();
		});
	});

	// Export/Import hook (presets-store bundles this into the settings file) + load persisted config.
	store.directorIO = { get: () => director.getConfig(), set: (c) => director.setConfig(c) };
	director._load();
	// Pool defaults / prune to the live mode + palette sets (needs MV.MODES + palettes — available now).
	const pruneOrAll = (pool, valid, dflt) => {
		const p = Array.isArray(pool) ? pool.filter((x) => valid.includes(x)) : [];
		return p.length ? p : [...(dflt || valid)];
	};
	director.modePool = pruneOrAll(director.modePool, MV.MODES);
	director.palettePool = pruneOrAll(director.palettePool, palettes.rotatableIds(), palettes.defaultPoolIds());
	director.presetPool = pruneOrAll(director.presetPool, store.poolableIds(), store.defaultPoolIds());
	director._sync();

	// When the palette library changes (add/edit/delete/restore), prune the pool + rebuild its list.
	window.addEventListener("viz:palettes-changed", () => {
		director.palettePool = pruneOrAll(director.palettePool, palettes.rotatableIds());
		director._sync();
	});
	// Same for the preset library (save/save-as/delete/restore) — prune the preset pool + rebuild it.
	window.addEventListener("viz:presets-changed", () => {
		director.presetPool = pruneOrAll(director.presetPool, store.poolableIds(), store.defaultPoolIds());
		director._sync();
	});

	return director;
}
