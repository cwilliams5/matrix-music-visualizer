// matrix-music-viz — palette store.
// The post-effect "palettes" library (mirrors presets-store). A palette record:
//   { id, name, builtin, kind, ramp? }
//     kind "ramp"  -> palette pass, brightness->color override. ramp = [{h,s,l,at}]. EDITABLE.
//     kind "moded" -> palette pass, NO override (each mode's own colors). locked.
//     kind "plain" -> plain pass. locked.
//     kind "stripe"-> stripe pass (spectrum's spatial rainbow). locked.
//     kind "debug" -> none/anatomy pass. locked.
// Only "ramp" palettes are author-editable; the rest are structural built-ins. resolve(id) turns a
// palette into the renderer config overrides boot.buildConfig applies.

const LS_KEY = "matrixviz.palettes.v1";
const fire = (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail }));
const s = (h, sat, l, at) => ({ h, s: sat, l, at }); // ramp stop

// The creative defaults — brightness->color ramps (0 = dim glyphs, 1 = bright heads).
function buildDefaults() {
	return [
		{ id: "mode-default", name: "Mode default", builtin: true, kind: "moded" },
		{ id: "plain", name: "Plain", builtin: true, kind: "plain" },
		{ id: "spectrum", name: "Spectrum", builtin: true, kind: "stripe" },
		{ id: "fire", name: "Fire", builtin: true, kind: "ramp", ramp: [s(0, 0, 0, 0), s(0, 1, 0.35, 0.32), s(0.05, 1, 0.5, 0.55), s(0.11, 1, 0.55, 0.78), s(0.15, 1, 0.92, 1)] },
		{ id: "ice", name: "Ice", builtin: true, kind: "ramp", ramp: [s(0.62, 0.9, 0.03, 0), s(0.58, 1, 0.45, 0.4), s(0.5, 1, 0.62, 0.72), s(0.5, 0.4, 0.96, 1)] },
		{ id: "amber", name: "Amber", builtin: true, kind: "ramp", ramp: [s(0.09, 1, 0, 0), s(0.1, 1, 0.45, 0.6), s(0.13, 0.9, 0.85, 1)] },
		{ id: "synthwave", name: "Synthwave", builtin: true, kind: "ramp", ramp: [s(0.72, 0.8, 0.05, 0), s(0.85, 1, 0.45, 0.4), s(0.92, 1, 0.62, 0.7), s(0.5, 1, 0.8, 1)] },
		{ id: "toxic", name: "Toxic", builtin: true, kind: "ramp", ramp: [s(0.33, 0.9, 0.02, 0), s(0.28, 1, 0.4, 0.5), s(0.22, 1, 0.55, 0.8), s(0.18, 1, 0.92, 1)] },
		{ id: "plasma", name: "Plasma", builtin: true, kind: "ramp", ramp: [s(0.75, 0.7, 0.08, 0), s(0.85, 0.9, 0.45, 0.35), s(0.02, 1, 0.55, 0.65), s(0.13, 1, 0.85, 1)] },
		{ id: "ocean", name: "Ocean", builtin: true, kind: "ramp", ramp: [s(0.6, 0.8, 0.03, 0), s(0.52, 1, 0.4, 0.45), s(0.45, 1, 0.55, 0.75), s(0.45, 0.4, 0.95, 1)] },
		{ id: "random", name: "🎲 Random", builtin: true, kind: "random", fixed: true, generative: true },
		{ id: "debug", name: "Debug (anatomy)", builtin: true, kind: "debug", fixed: true },
	];
}

// A harmony-biased, ascending-lightness brightness ramp for the generative "🎲 Random" palette
// (dim glyphs dark -> bright heads). Random kind/scheme keeps it varied but rarely muddy.
function rollRamp(chaos) {
	const baseHue = Math.random();
	const schemes = ["mono", "analogous", "complement", "triad", "spread"];
	const scheme = schemes[Math.floor(Math.random() * schemes.length)];
	const spreadAmt = 0.3 + Math.random() * 0.5;
	// chaos: a fresh random hue per stop (no harmony scheme). The ascending-lightness structure + the
	// visibility floor are KEPT — they're what makes a brightness ramp readable, not "harmony".
	const hueAt = (t) => {
		if (chaos) return Math.random();
		switch (scheme) {
			case "mono":
				return baseHue;
			case "analogous":
				return baseHue + (t - 0.5) * 0.18;
			case "complement":
				return baseHue + (t > 0.55 ? 0.5 : 0);
			case "triad":
				return baseHue + Math.floor(t * 2.999) / 3;
			default:
				return baseHue + t * spreadAmt;
		}
	};
	const n = 3 + Math.floor(Math.random() * 3); // 3..5 stops
	const stops = [];
	for (let i = 0; i < n; i++) {
		const at = n === 1 ? 1 : i / (n - 1);
		const h = ((hueAt(at) % 1) + 1) % 1;
		const sat = chaos ? 0.35 + Math.random() * 0.65 : 0.6 + Math.random() * 0.4;
		stops.push({ h, s: sat, l: 0.02 + at * (0.86 + Math.random() * 0.1), at });
	}
	return stops;
}

// A harmony-biased multi-color STRIPE (a spatial gradient swept across the columns — the "rainbow"
// kind) for a Random stripe roll. Colors are {space:"hsl",values} like the spectrum stripe.
function rollStripe(chaos) {
	const baseHue = Math.random();
	const arc = 0.25 + Math.random() * 0.6; // how far around the hue wheel the sweep travels
	const n = 4 + Math.floor(Math.random() * 5); // 4..8 colors
	const stops = [];
	for (let i = 0; i < n; i++) {
		const t = n === 1 ? 0 : i / (n - 1);
		// chaos: a random hue per column (no swept arc). Stripes carry no brightness-ramp constraint.
		const h = chaos ? Math.random() : (((baseHue + t * arc) % 1) + 1) % 1;
		stops.push({ space: "hsl", values: [h, 0.7 + Math.random() * 0.3, 0.45 + Math.random() * 0.25] });
	}
	return stops;
}

const slug = (name) =>
	(name || "palette")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "") || "palette";

export const palettes = {
	records: [],
	chaos: false, // generative Random palette: bypass the harmony bias for full-random HSL (default off)

	init() {
		this.records = this._load() || buildDefaults();
		this.chaos = this._loadFlag("chaos"); // a per-library roll preference, persisted alongside the records
		this._ensureFixed(); // make sure the fixed specials (Random, Debug) exist + are flagged on old blobs
		return this;
	},
	setChaos(v) {
		this.chaos = !!v;
		this._persist();
	},
	// Merge in any FIXED built-in special a previously-saved blob predates (e.g. Random) and (re)apply
	// the fixed/generative flags. Fixed entries can't be user-deleted, so absence = never-seen, not deleted.
	_ensureFixed() {
		for (const d of buildDefaults()) {
			if (!d.fixed) continue;
			const ex = this.records.find((r) => r.id === d.id);
			if (ex) {
				ex.fixed = true;
				ex.kind = d.kind;
				if (d.generative) ex.generative = true;
			} else {
				this.records.push(d);
			}
		}
	},

	list() {
		return this.records;
	},
	get(id) {
		return this.records.find((r) => r.id === id) || this.records[0];
	},
	isEditable(id) {
		const r = this.get(id);
		return !!r && r.kind === "ramp";
	},
	// ids the director may rotate through — everything except the debug/anatomy view (Random IS
	// rotatable/checkable, but excluded from the DEFAULT pool below).
	rotatableIds() {
		return this.records.filter((r) => r.kind !== "debug").map((r) => r.id);
	},
	// pool ids the director DEFAULTS to: excludes the debug view AND the generative Random (opt-in only).
	defaultPoolIds() {
		return this.records.filter((r) => r.kind !== "debug" && !r.generative).map((r) => r.id);
	},
	// generative "🎲 Random" — re-rolled by the dice / R / a director pick; resolve() returns the
	// current roll with a fresh cache key (#roll) so the pipeline rebuilds with the new colors.
	rollRandom() {
		this._roll = (this._roll || 0) + 1;
		if (Math.random() < 0.6) {
			// ~60% a brightness->color RAMP ("one common set"); 40% a multi-column STRIPE ("rainbow")
			this._randomKind = "ramp";
			this._randomRamp = rollRamp(this.chaos);
			this._randomStripe = null;
		} else {
			this._randomKind = "stripe";
			this._randomStripe = rollStripe(this.chaos);
			this._randomRamp = null;
		}
		return this._randomKind === "ramp" ? this._randomRamp : this._randomStripe;
	},

	// Turn a palette id into renderer config overrides (boot.buildConfig applies these).
	resolve(id) {
		const r = this.get(id);
		if (!r) return { effect: "palette" };
		// `#rev` makes an edited ramp a fresh pipeline-cache key so new colors actually rebuild
		// (the palette pass bakes the gradient at build time); normal switches still cache-hit.
		if (r.kind === "ramp") return { effect: r.id + "#" + (r.rev || 0), palette: (r.ramp || []).map((st) => ({ color: { space: "hsl", values: [st.h, st.s, st.l] }, at: st.at })) };
		if (r.kind === "moded") return { effect: "palette" };
		if (r.kind === "plain") return { effect: "plain" };
		if (r.kind === "stripe") return { effect: "spectrum" };
		if (r.kind === "random") {
			if (!this._randomKind) this.rollRandom();
			if (this._randomKind === "stripe") return { effect: "customStripes#" + (this._roll || 0), stripeColors: this._randomStripe };
			return { effect: "random#" + (this._roll || 0), palette: this._randomRamp.map((st) => ({ color: { space: "hsl", values: [st.h, st.s, st.l] }, at: st.at })) };
		}
		return { effect: "none" };
	},

	// ---- authoring (ramp palettes) ----
	// reject names that collide with a built-in (anti-footgun: avoids two same-named entries after restore)
	_isReserved(name) {
		const n = (name || "").trim().toLowerCase();
		return this.records.some((r) => r.builtin && (r.name || "").toLowerCase() === n);
	},
	add(name, ramp) {
		if (this._isReserved(name)) return null; // reserved built-in palette name
		const r = { id: "user-" + slug(name) + "-" + Date.now().toString(36), name: (name || "Custom").trim() || "Custom", builtin: false, kind: "ramp", ramp: ramp.map((st) => ({ ...st })) };
		this.records.push(r);
		this._persist();
		fire("viz:palettes-changed");
		return r;
	},
	duplicate(id) {
		const src = this.get(id);
		if (src && src.fixed) return null; // Random / Debug are fixed — not duplicatable
		const ramp = src && src.kind === "ramp" ? src.ramp : [s(0.33, 1, 0.05, 0), s(0.3, 1, 0.55, 0.6), s(0.25, 1, 0.95, 1)];
		return this.add((src ? src.name : "Custom") + " copy", ramp);
	},
	update(id, patch) {
		const r = this.get(id);
		if (!r || r.kind !== "ramp") return false;
		if (typeof patch.name === "string" && patch.name.trim()) {
			const n = patch.name.trim();
			if (this._isReserved(n) && n.toLowerCase() !== (r.name || "").toLowerCase()) return false; // renaming onto a built-in
			r.name = n;
		}
		if (Array.isArray(patch.ramp) && patch.ramp.length) {
			r.ramp = patch.ramp.map((st) => ({ ...st }));
			r.rev = (r.rev || 0) + 1; // bump so the pipeline cache rebuilds with the new colors
		}
		this._persist();
		fire("viz:palettes-changed");
		return true;
	},
	deletePalette(id) {
		if (this.records.length <= 1) return false;
		const i = this.records.findIndex((r) => r.id === id);
		if (i < 0 || this.records[i].fixed) return false; // Random / Debug are fixed — not deletable
		this.records.splice(i, 1);
		this._persist();
		fire("viz:palettes-changed");
		return true;
	},
	// Non-destructive: re-add any deleted built-in + reset edited built-ins to factory; keep customs.
	restoreDefaults() {
		const defs = buildDefaults();
		const defIds = new Set(defs.map((d) => d.id));
		const customs = this.records.filter((r) => !defIds.has(r.id) && !r.builtin);
		this.records = [...defs, ...customs];
		this._persist();
		fire("viz:palettes-changed");
	},

	// ---- persistence + export/import payload ----
	exportData() {
		return this.records;
	},
	importData(arr) {
		if (!Array.isArray(arr) || !arr.length) return;
		this.records = arr;
		this._ensureFixed();
		this._persist();
		fire("viz:palettes-changed");
	},
	_persist() {
		try {
			localStorage.setItem(LS_KEY, JSON.stringify({ version: 1, palettes: this.records, chaos: !!this.chaos }));
		} catch (e) {}
	},
	_load() {
		try {
			const o = JSON.parse(localStorage.getItem(LS_KEY));
			return o && Array.isArray(o.palettes) && o.palettes.length ? o.palettes : null;
		} catch (e) {
			return null;
		}
	},
	_loadFlag(key) {
		try {
			const o = JSON.parse(localStorage.getItem(LS_KEY));
			return !!(o && o[key]);
		} catch (e) {
			return false;
		}
	},
};
