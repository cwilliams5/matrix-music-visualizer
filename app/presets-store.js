// matrix-music-viz — preset store.
// Owns the live list of presets (built-in + user), persisted to localStorage. A preset
// record is fully numeric/serializable: { id, name, desc, characterId, builtin, requires3D,
// intensity, mixer:{effectId:{on,strength}} }. characterId references a built-in knob-formula
// "character" (see presets.js). Loading a preset copies its mixer into the working A.mixer.

import { A } from "../vendor/matrix/js/reactive.js";
import { buildDefaultRecords, EFFECT_IDS, EFFECT_DEF, PRESET_BY_ID, extractDrivers, randomDrivers, completeDrivers, defaultChannelDrivers, completeChannelDrivers, randomChannelDrivers, snapshotLook } from "./presets.js";
import { transitions } from "./transitions.js";

const LS_KEY = "matrixviz.presets.v1";
// Data-schema version stamped into the persisted blob (distinct from the LS_KEY "v1" namespace). A
// stored blob older than this triggers a one-time migration in _migrate(). Bumped to 2 for the A1
// cursor/glint driver rework; to 3 for the curated preset refresh (signature palettes + specific
// volumetric targets + the new mode/stereo presets) so it reaches existing libraries.
export const PRESET_SCHEMA = 3;
const SHOCK_ORIGINS = ["center", "random", "bass", "top"];
const HUE_MODES = ["centroid", "drift", "beat", "bass"]; // generative Random biases away from "none"

const fire = (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail }));
const lsGet = (k) => {
	try {
		return JSON.parse(localStorage.getItem(k)) ?? undefined;
	} catch (e) {
		return undefined;
	}
};

export const store = {
	records: [],
	activeId: null,
	mv: null,
	directorIO: null, // { get, set } — installed by initDirector so export/import bundle director config
	palettesIO: null, // { get, set } — installed by wirePaletteControls so export/import bundle palettes
	transitionsIO: null, // { get, set } — installed by app-init so export/import bundle transition config

	init(mv) {
		this.mv = mv;
		this.records = this._load() || buildDefaultRecords();
		this._migrate();
		this.setActive(this.records[0].id, { switchMode: false });
		return this;
	},

	list() {
		return this.records;
	},
	active() {
		return this.records.find((r) => r.id === this.activeId) || null;
	},

	// director-pool helpers (mirror palette-store): poolable = every preset INCLUDING the generative
	// Random (checkable but OFF by default); defaultPool = the non-generative presets (Random opt-in only).
	poolableIds() {
		return this.records.map((r) => r.id);
	},
	defaultPoolIds() {
		return this.records.filter((r) => !r.generative).map((r) => r.id);
	},

	_loadedVersion: 0, // schema version of the blob we loaded (0 = fresh build / nothing stored)
	_load() {
		try {
			const o = JSON.parse(localStorage.getItem(LS_KEY));
			if (o && Array.isArray(o.presets) && o.presets.length) {
				this._loadedVersion = o.version || 1;
				return o.presets;
			}
			return null;
		} catch (e) {
			return null;
		}
	},
	_persist() {
		try {
			localStorage.setItem(LS_KEY, JSON.stringify({ version: PRESET_SCHEMA, presets: this.records }));
		} catch (e) {
			console.warn("[matrix-music-viz] preset persist failed:", e);
		}
	},
	// forward-compat: ensure every record's mixer covers all current effects
	_migrate() {
		// A1 (schema 2): older blobs baked the pre-A1 cursor curve + an inert glint into each preset's
		// `drivers` data (the runtime path is the baked drivers, not DEFAULT_KNOB_MAP). Re-bake JUST the
		// cursor + glint knob drivers for built-ins from their character so the new dim-baseline-then-flare
		// default reaches existing libraries. Surgical: only these two knobs; customs + other knobs untouched.
		const wasBehind = this._loadedVersion > 0 && this._loadedVersion < PRESET_SCHEMA;
		// Schema 3 (the curated preset refresh): re-seed the built-in library from the fresh defaults so the
		// signature palettes, specific volumetric targets, and the new mode/stereo presets reach existing
		// libraries. Customs are preserved; runs once on the version bump (mirrors restoreDefaults' merge).
		if (this._loadedVersion > 0 && this._loadedVersion < 3) {
			const defs = buildDefaultRecords();
			const defIds = new Set(defs.map((d) => d.id));
			const customs = this.records.filter((r) => !defIds.has(r.id) && !r.builtin);
			this.records = [...defs, ...customs];
		}
		for (const r of this.records) {
			if (r.generative) continue; // generative presets carry no static fields
			if (!r.mixer) r.mixer = {};
			for (const id of EFFECT_IDS) if (!r.mixer[id]) r.mixer[id] = { on: false, strength: EFFECT_DEF[id] };
			// backfill per-preset shock/hue (added for authoring) from the character for old records
			const ch = PRESET_BY_ID[r.characterId] || PRESET_BY_ID[r.id];
			if (r.builtin && ch) r.desc = ch.desc; // refresh canonical built-in descriptions (de-colored, etc.)
			if (!r.shock) r.shock = ch && ch.shock ? { ...ch.shock } : { origin: "center", speed: 0.9, decay: 0.45, gain: 0.8 };
			if (!r.hue) r.hue = ch && ch.hue ? { ...ch.hue } : { mode: "none" };
			if (!r.drivers) r.drivers = ch ? extractDrivers(ch) : null;
			if (r.drivers) r.drivers = completeDrivers(r.drivers); // ensure newly-added knobs (e.g. glint) exist
			if (wasBehind && r.builtin && ch && r.drivers) {
				const fresh = extractDrivers(ch); // re-derive from the (new) DEFAULT_KNOB_MAP + character
				r.drivers.cursorIntensity = fresh.cursorIntensity;
				r.drivers.glintIntensity = fresh.glintIntensity;
			}
			r.channelDrivers = completeChannelDrivers(r.channelDrivers); // backfill pulse/bassWarp/windSway mixes (P3)
			if (r.jumpMode === undefined) r.jumpMode = r.requires3D ? "3d" : null; // migrate old requires3D
			if (r.jumpPalette === undefined) r.jumpPalette = null;
		}
		// ensure the fixed generative Random preset exists (older saved blobs predate it)
		if (!this.records.some((r) => r.id === "random")) {
			this.records.push({ id: "random", name: "🎲 Random", builtin: true, fixed: true, generative: true });
		}
		if (wasBehind) {
			this._loadedVersion = PRESET_SCHEMA; // mark migrated (don't re-bake again this session)
			this._persist(); // stamp the new schema + bake the re-derived cursor/glint drivers in
		}
	},

	_snapshotMixer() {
		const m = {};
		for (const id of EFFECT_IDS) {
			const e = A.mixer[id] || { on: false, strength: EFFECT_DEF[id] };
			m[id] = { on: !!e.on, strength: +e.strength };
		}
		return m;
	},

	// activate a preset: copy its mixer into the working A.mixer, set character + intensity,
	// 3D-flagged presets jump to a volumetric mode.
	setActive(id, opts = {}) {
		const fromLook = snapshotLook(A); // capture the OLD look BEFORE we overwrite A.* (for the param-blend)
		const r = this.records.find((x) => x.id === id) || this.records[0];
		this.activeId = r.id;
		if (r.generative) {
			this._rollPreset(); // generative "🎲 Random" — fresh roll into A.mixer/intensity/character/shock/hue/drivers
		} else {
			const m = {};
			for (const eid of EFFECT_IDS) {
				const e = r.mixer[eid] || { on: false, strength: EFFECT_DEF[eid] };
				m[eid] = { on: !!e.on, strength: +e.strength };
			}
			A.mixer = m;
			A.characterId = r.characterId || r.id;
			A.shockCfg = r.shock ? { ...r.shock } : null; // per-preset shape -> read by mapping.apply
			A.hueCfg = r.hue ? { ...r.hue } : null;
			A.drivers = completeDrivers(r.drivers ? JSON.parse(JSON.stringify(r.drivers)) : null); // working COPY (all knobs present) -> mapping.apply
			A.channelDrivers = completeChannelDrivers(r.channelDrivers ? JSON.parse(JSON.stringify(r.channelDrivers)) : null); // working COPY of pulse/bassWarp/windSway mixes
			A.jumpMode = r.jumpMode || null; // scene bindings -> applied below, editable in Advanced
			A.jumpPalette = r.jumpPalette || null;
			A.intensity = r.intensity ?? 1;
		}
		fire("viz:preset", { id: r.id, name: r.name, desc: r.desc, builtin: !!r.builtin });
		// honor the preset's scene bindings: manual select applies both; the director gates each via
		// opts.switchMode / opts.switchPalette (its usePresetMode / usePresetPalette toggles).
		let change = false;
		if (this.mv) {
			let ver = this.mv.current.version;
			let eff = this.mv.current.effect;
			// honor the preset's specific scene target; jumping to the mode you're already on is a no-op
			// (presets now bind SPECIFIC volumetric modes: trinity / morpheus / bugs, not a generic "3d")
			if (r.jumpMode && opts.switchMode !== false && r.jumpMode !== ver) {
				ver = r.jumpMode;
				change = true;
			}
			if (r.jumpPalette && opts.switchPalette !== false && r.jumpPalette !== eff) {
				eff = r.jumpPalette;
				change = true;
			}
			if (change) this.mv.setMode(ver, eff, { source: opts.source });
		}
		// plan-transitions: param-blend the preset change. Skipped when a mode/palette rebuild is also
		// happening (the crossfade carries that), or when policy/suspended says hard-cut.
		transitions.presetChanged(fromLook, { pipelineChanged: change, source: opts.source });
		return r;
	},

	// generative Random preset: randomize the exposed advanced mappings DIRECTLY — a constrained mixer +
	// random shock shape + random hue behavior + a fresh per-knob driver mix (spans the driver space).
	_rollPreset() {
		const m = {};
		for (const id of EFFECT_IDS) {
			const on = Math.random() < 0.48; // ~half the effects on — never all / none-ish
			m[id] = { on, strength: on ? +(0.4 + Math.random() * 1.2).toFixed(2) : EFFECT_DEF[id] };
		}
		A.mixer = m;
		A.intensity = +(0.8 + Math.random() * 0.5).toFixed(2);
		A.characterId = "random";
		A.shockCfg = { origin: SHOCK_ORIGINS[Math.floor(Math.random() * SHOCK_ORIGINS.length)], speed: +(0.5 + Math.random()).toFixed(2), decay: +(0.28 + Math.random() * 0.5).toFixed(2), gain: +(0.5 + Math.random() * 0.9).toFixed(2) };
		A.hueCfg = { mode: HUE_MODES[Math.floor(Math.random() * HUE_MODES.length)], rate: +(0.01 + Math.random() * 0.04).toFixed(3), spread: +(0.3 + Math.random() * 0.6).toFixed(2), bleed: +(0.3 + Math.random() * 0.6).toFixed(2) };
		A.drivers = randomDrivers();
		A.channelDrivers = randomChannelDrivers(); // physics channels join the rolled driver space
		A.jumpMode = null;
		A.jumpPalette = null;
	},

	// overwrite the active preset with the current working state
	save() {
		const r = this.active();
		if (!r || r.fixed) return; // can't overwrite a fixed/generative preset — use Save as new
		r.mixer = this._snapshotMixer();
		r.intensity = A.intensity ?? 1;
		r.characterId = A.characterId || r.characterId;
		if (A.shockCfg) r.shock = { ...A.shockCfg };
		if (A.hueCfg) r.hue = { ...A.hueCfg };
		if (A.drivers) r.drivers = JSON.parse(JSON.stringify(A.drivers));
		if (A.channelDrivers) r.channelDrivers = JSON.parse(JSON.stringify(A.channelDrivers));
		r.jumpMode = A.jumpMode || null;
		r.jumpPalette = A.jumpPalette || null;
		this._persist();
		fire("viz:presets-changed");
		fire("viz:preset-saved", { id: r.id, name: r.name });
	},

	// reject names that collide with a built-in (anti-footgun: avoids two same-named entries after restore)
	_isReserved(name) {
		const n = (name || "").trim().toLowerCase();
		return this.records.some((r) => r.builtin && (r.name || "").toLowerCase() === n);
	},

	saveAsNew(name) {
		const base = this.active();
		const clean = (name || "Custom").trim() || "Custom";
		if (this._isReserved(clean)) return null; // reserved built-in name — caller shows a hint
		const slug = clean.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "preset";
		const r = {
			id: "user-" + slug + "-" + Date.now().toString(36),
			name: clean,
			desc: "",
			characterId: A.characterId || (base && base.characterId) || "pulse-rain",
			builtin: false,
			jumpMode: A.jumpMode || (base && base.jumpMode) || null,
			jumpPalette: A.jumpPalette || (base && base.jumpPalette) || null,
			intensity: A.intensity ?? 1,
			mixer: this._snapshotMixer(),
			shock: A.shockCfg ? { ...A.shockCfg } : base && base.shock ? { ...base.shock } : { origin: "center", speed: 0.9, decay: 0.45, gain: 0.8 },
			hue: A.hueCfg ? { ...A.hueCfg } : base && base.hue ? { ...base.hue } : { mode: "none" },
			drivers: A.drivers ? JSON.parse(JSON.stringify(A.drivers)) : base && base.drivers ? JSON.parse(JSON.stringify(base.drivers)) : null,
			channelDrivers: A.channelDrivers ? JSON.parse(JSON.stringify(A.channelDrivers)) : base && base.channelDrivers ? JSON.parse(JSON.stringify(base.channelDrivers)) : defaultChannelDrivers(),
		};
		this.records.push(r);
		this.activeId = r.id;
		this._persist();
		fire("viz:presets-changed");
		fire("viz:preset", { id: r.id, name: r.name, desc: r.desc, builtin: false });
		return r;
	},

	deletePreset(id) {
		if (this.records.length <= 1) return false;
		const i = this.records.findIndex((r) => r.id === id);
		if (i < 0 || this.records[i].fixed) return false; // Random is fixed — not deletable
		this.records.splice(i, 1);
		this._persist();
		if (this.activeId === id) this.setActive(this.records[Math.max(0, i - 1)].id, { switchMode: false });
		fire("viz:presets-changed");
		return true;
	},

	// Non-destructive: re-add any deleted built-in + reset edited built-ins to factory; keep customs.
	restoreDefaults() {
		const defs = buildDefaultRecords();
		const defIds = new Set(defs.map((d) => d.id));
		const customs = this.records.filter((r) => !defIds.has(r.id) && !r.builtin);
		this.records = [...defs, ...customs];
		this._migrate();
		this._persist();
		// Re-apply the active preset (kept if it survived) so a reset built-in refreshes the working state.
		const keepId = this.records.find((r) => r.id === this.activeId) ? this.activeId : this.records[0].id;
		this.setActive(keepId, { switchMode: false });
		fire("viz:presets-changed");
	},

	exportJSON() {
		// full backup: presets + palettes + director + the live session (look) + player prefs
		const data = JSON.stringify({ version: 1, exported: new Date().toISOString(), presets: this.records, director: this.directorIO ? this.directorIO.get() : undefined, palettes: this.palettesIO ? this.palettesIO.get() : undefined, transitions: this.transitionsIO ? this.transitionsIO.get() : undefined, session: lsGet("matrixviz.session.v1"), player: lsGet("matrixviz.player.v1") }, null, 2);
		const blob = new Blob([data], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = "matrix-music-viz-settings.json";
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	},

	importJSON(text) {
		const o = JSON.parse(text);
		if (!o || !Array.isArray(o.presets)) throw new Error("Not a matrix-music-viz settings file.");
		// Write every blob to its store's localStorage key, then reload so all stores re-init uniformly
		// from the imported state (presets/palettes/director/session/player). Musical state is excluded.
		localStorage.setItem(LS_KEY, JSON.stringify({ version: 1, presets: o.presets }));
		if (Array.isArray(o.palettes)) localStorage.setItem("matrixviz.palettes.v1", JSON.stringify({ version: 1, palettes: o.palettes }));
		if (o.director) localStorage.setItem("matrixviz.director.v1", JSON.stringify(o.director));
		if (o.transitions) localStorage.setItem("matrixviz.transitions.v1", JSON.stringify(o.transitions));
		if (o.session) localStorage.setItem("matrixviz.session.v1", JSON.stringify(o.session));
		if (o.player) localStorage.setItem("matrixviz.player.v1", JSON.stringify(o.player));
		location.reload();
	},
};
