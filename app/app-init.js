// matrix-music-viz — subsystem wiring hub.
// boot.js calls initSubsystems(MV) after the first mode is rendering. Subsystems register
// per-frame work via MV.onFrame in order: audio engine -> beat detector -> mapping ->
// director -> overlay. This file also builds the effects-mixer UI + preset management.

import { A } from "../vendor/matrix/js/reactive.js";
import { initPlayer } from "./player.js";
import { initEngine } from "./audio-engine.js";
import { isEmbedded, hostBridge } from "./embed.js";
import { initBeat } from "./beat-detector.js";
import { initMapping, EFFECTS, EFFECT_DEF, verifyDriverEquivalence, verifyChannelEquivalence, DRIVER_FEATURES, CHANNEL_LABELS } from "./presets.js";
import { store, PRESET_SCHEMA } from "./presets-store.js";
import { palettes } from "./palette-store.js";
import { initDirector } from "./director.js";
import { initOverlay } from "./overlay.js";
import { initFullscreen } from "./fullscreen.js";
import { session } from "./session-store.js";
import { transitions, initTransitions } from "./transitions.js";

const GROUP_LABELS = { physics: "New physics", camera: "3D camera", motion: "Reactive motion (rain params)" };
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

export async function initSubsystems(MV) {
	const A = MV.A;
	const player = await initPlayer();
	const engine = initEngine(player, MV); // 1) features
	const beat = initBeat(MV); // 2) beats
	const map = initMapping(MV); // 3) knobs/shader (reads A.mixer)
	const trans = initTransitions(MV); // 3.5) transitions: registers tick, reads its DOM controls (before store.init so the first activation, which is suspended, doesn't animate)
	store.init(MV); // seed/load presets + activate the first one (sets A.mixer)
	const director = initDirector(MV); // 4) auto-switch
	initOverlay(MV); // 5) meters + beat flash

	MV.player = player;
	MV.engine = engine;
	MV.beat = beat;
	MV.mapping = map;
	MV.director = director;
	MV.transitions = trans;
	MV.store = store;
	MV.palettes = palettes;
	MV._verifyDrivers = verifyDriverEquivalence; // debug: knob driver-model equivalence gate
	MV._verifyChannels = verifyChannelEquivalence; // debug: channel driver-model equivalence gate
	window.MV.player = player;

	// plan-transitions: Export/Import bundles transition config; the title splash + the director's
	// switch-on-track-change both fire on track change.
	store.transitionsIO = { get: () => trans.getConfig(), set: (c) => trans.setConfig(c) };
	// Track-change drives the song-title splash + the director's switch-on-track-change.
	// Standalone: the player fires it. Embedded: the host bridge fires it (host owns playback).
	if (isEmbedded()) {
		const h = hostBridge;
		if (h && h.onTrackChange) {
			h.onTrackChange((np) => {
				trans.onTrackChange(np ? { title: np.title, artist: np.artist } : null);
				director.trackChanged();
			});
		}
	} else {
		player.onTrackChange = (t) => {
			trans.onTrackChange(t);
			director.trackChanged();
		};
	}

	wireModal();
	buildMixer(A);
	wirePresetControls(MV, A);
	wirePresetAdvanced(MV, A);
	wirePaletteControls(MV);
	uiFollow = wireUiFollowPalette(MV); // F4 — must precede wireSession (restore reads the controller)
	collapsibleSections = wireCollapsibleSections(); // F6 — same: restore reads the controller
	wireReactiveBasics(MV, A);
	wireSession(MV, A);
	wireContextMenu(MV, A);
	wireCheatSheet();
	initFullscreen(); // unified fullscreen mode: F / stage-double-click + immersive auto-hide

	// Boot + session-restore are done — from here, changes animate per the transition policy.
	trans.suspended = false;

	// Embedded: show what's currently playing once, now that transitions are live.
	if (isEmbedded()) {
		const h = hostBridge;
		const np = h && h.getNowPlaying && h.getNowPlaying();
		if (np) trans.onTrackChange({ title: np.title, artist: np.artist });
	}

	console.log("[matrix-music-viz] subsystems ready (mixer + preset + palette stores)");
}

// ---- confirmation modal ----------------------------------------------------
let modalOnOk = null;
function wireModal() {
	const modal = document.getElementById("modal");
	const ok = document.getElementById("modal-ok");
	const cancel = document.getElementById("modal-cancel");
	const close = () => modal.classList.add("hidden");
	ok?.addEventListener("click", () => {
		const fn = modalOnOk;
		modalOnOk = null;
		close();
		if (fn) fn();
	});
	cancel?.addEventListener("click", () => {
		modalOnOk = null;
		close();
	});
}
function confirmModal(msg, onOk) {
	document.getElementById("modal-msg").textContent = msg;
	modalOnOk = onOk;
	document.getElementById("modal").classList.remove("hidden");
}

// ---- dirty indicator -------------------------------------------------------
let dirty = false;
let scheduleSessionSave = () => {}; // wired by wireSession; setDirty (mixer/intensity/random) pings it
let refreshPresetAdvanced = () => {}; // wired by wirePresetAdvanced; re-reads A.shockCfg/A.hueCfg into its controls
let uiFollow = null; // F4 controller (wireUiFollowPalette) — read by wireSession for persistence
let collapsibleSections = null; // F6 controller (wireCollapsibleSections) — read by wireSession for persistence

function setDirty(v) {
	dirty = v;
	const el = document.getElementById("preset-dirty");
	if (el) el.textContent = v ? "• unsaved" : "";
	scheduleSessionSave();
}

// ---- dynamic Save-button label (shows what you'd overwrite) ----------------
function updateSaveLabel() {
	const btn = document.getElementById("preset-save");
	const r = store.active();
	if (!btn || !r) return;
	btn.textContent = "Save “" + r.name + "”";
	btn.title = "Overwrite “" + r.name + "” with the settings below";
}

// ---- contextual note: Spectrum Rain spans the full width only in 2D --------
function refreshMixerNote() {
	const note = document.getElementById("mixer-note");
	if (!note) return;
	const spectrumOn = !!(A.mixer && A.mixer.spectrum && A.mixer.spectrum.on);
	const volumetric = !!(A.modeInfo && A.modeInfo.volumetric);
	note.textContent =
		spectrumOn && volumetric
			? "Spectrum rain maps columns to frequency bands across the full width in 2D modes; in a 3D mode the perspective zooms it toward the center, so the spread narrows."
			: "";
}

// ---- the effects mixer (checkbox + strength slider per effect) -------------
function buildMixer(A) {
	const host = document.getElementById("mixer");
	if (!host) return;
	host.innerHTML = "";
	let lastGroup = null;
	for (const e of EFFECTS) {
		if (e.group !== lastGroup) {
			lastGroup = e.group;
			const h = document.createElement("div");
			h.className = "mix-group";
			h.textContent = GROUP_LABELS[e.group] || e.group;
			host.appendChild(h);
		}
		const row = document.createElement("div");
		row.className = "mix-row";
		row.dataset.id = e.id;
		if (e.tip) row.title = e.tip; // D: hovering the row (checkbox/label) explains what the effect does

		const cb = document.createElement("input");
		cb.type = "checkbox";
		cb.id = "mix-cb-" + e.id;

		const label = document.createElement("label");
		label.className = "mix-label";
		label.htmlFor = cb.id;
		label.textContent = e.label;

		const sl = document.createElement("input");
		sl.type = "range";
		sl.id = "mix-sl-" + e.id;
		sl.min = "0";
		sl.max = "2";
		sl.step = "0.05";
		sl.title = e.tip ? e.label + " strength (0–2)" : "strength";

		cb.addEventListener("change", () => {
			const m = A.mixer[e.id] || (A.mixer[e.id] = { on: false, strength: EFFECT_DEF[e.id] });
			m.on = cb.checked;
			// "check it = see it": enabling an effect left at 0 bumps it to a sensible default
			if (m.on && !(m.strength > 0)) {
				m.strength = EFFECT_DEF[e.id];
				sl.value = m.strength;
			}
			updateRow(row, cb, sl, m);
			setDirty(true);
			if (e.id === "spectrum") refreshMixerNote();
		});
		sl.addEventListener("input", () => {
			const m = A.mixer[e.id] || (A.mixer[e.id] = { on: false, strength: 0 });
			m.strength = parseFloat(sl.value);
			setDirty(true);
		});

		row.appendChild(cb);
		row.appendChild(label);
		row.appendChild(sl);
		host.appendChild(row);
	}
	refreshMixer(A);
}

function updateRow(row, cb, sl, m) {
	row.classList.toggle("off", !m.on);
	sl.disabled = !m.on;
}

function refreshMixer(A) {
	for (const e of EFFECTS) {
		const cb = document.getElementById("mix-cb-" + e.id);
		const sl = document.getElementById("mix-sl-" + e.id);
		if (!cb || !sl) continue;
		const m = A.mixer[e.id] || { on: false, strength: EFFECT_DEF[e.id] };
		cb.checked = !!m.on;
		sl.value = m.strength;
		updateRow(cb.closest(".mix-row"), cb, sl, m);
	}
	refreshMixerNote();
}

// ---- preset controls -------------------------------------------------------
function populatePresetSelect() {
	const sel = document.getElementById("preset-select");
	if (!sel) return;
	sel.innerHTML = "";
	for (const r of store.list()) {
		const o = document.createElement("option");
		o.value = r.id;
		o.textContent = r.builtin ? r.name : r.name + " *";
		if (r.id === store.activeId) o.selected = true;
		sel.appendChild(o);
	}
}

function wirePresetControls(MV, A) {
	const sel = document.getElementById("preset-select");
	const desc = document.getElementById("preset-desc");
	const readout = document.getElementById("preset-readout");
	const intensity = document.getElementById("intensity");
	const intensityVal = document.getElementById("intensity-val");
	populatePresetSelect();
	updateSaveLabel();

	sel?.addEventListener("change", () => store.setActive(sel.value)); // manual: may switch to 3D mode

	// store events: a preset became active / the list changed
	window.addEventListener("viz:preset", (e) => {
		if (sel) sel.value = e.detail.id;
		if (desc) {
			desc.textContent = e.detail.desc || "";
			desc.style.display = e.detail.desc ? "" : "none"; // collapse for customs / empty
		}
		if (readout) readout.textContent = e.detail.name;
		if (intensity) intensity.value = A.intensity ?? 1;
		if (intensityVal) intensityVal.textContent = (A.intensity ?? 1).toFixed(2);
		refreshMixer(A);
		updateSaveLabel();
		setDirty(false);
	});
	window.addEventListener("viz:presets-changed", populatePresetSelect);
	window.addEventListener("viz:mode", refreshMixerNote);

	const idx = () => store.list().findIndex((r) => r.id === store.activeId);
	document.getElementById("preset-prev")?.addEventListener("click", () => {
		const l = store.list();
		store.setActive(l[(idx() - 1 + l.length) % l.length].id);
	});
	document.getElementById("preset-next")?.addEventListener("click", () => {
		const l = store.list();
		store.setActive(l[(idx() + 1) % l.length].id);
	});
	document.getElementById("preset-random")?.addEventListener("click", () => {
		const pool = store.list().filter((r) => r.id !== store.activeId && !r.generative); // existing presets only
		if (pool.length) store.setActive(pool[Math.floor(Math.random() * pool.length)].id);
	});
	document.getElementById("preset-dice")?.addEventListener("click", () => store.setActive("random")); // generative roll

	document.getElementById("preset-save")?.addEventListener("click", () => {
		store.save();
		setDirty(false);
	});

	document.getElementById("preset-duplicate")?.addEventListener("click", () => {
		const r = store.active();
		store.saveAsNew(((r && r.name) || "Custom") + " copy");
		setDirty(false);
	});

	// Save as new — reveal an inline name field
	const saveasRow = document.getElementById("saveas-row");
	const saveasName = document.getElementById("saveas-name");
	document.getElementById("preset-saveas")?.addEventListener("click", () => {
		saveasRow.style.display = "flex";
		saveasName.value = (store.active()?.name || "Custom") + " copy";
		saveasName.focus();
		saveasName.select();
	});
	const doSaveAs = () => {
		const name = saveasName.value.trim();
		if (!name) {
			saveasRow.style.display = "none";
			return;
		}
		if (store.saveAsNew(name)) {
			setDirty(false);
			saveasRow.style.display = "none";
		} else {
			// reserved built-in name — keep the row open with a hint
			saveasName.value = "";
			saveasName.placeholder = `"${name}" is a built-in name — try another`;
			saveasName.focus();
		}
	};
	document.getElementById("saveas-ok")?.addEventListener("click", doSaveAs);
	document.getElementById("saveas-cancel")?.addEventListener("click", () => (saveasRow.style.display = "none"));
	saveasName?.addEventListener("keydown", (e) => {
		if (e.key === "Enter") doSaveAs();
		if (e.key === "Escape") saveasRow.style.display = "none";
	});

	document.getElementById("preset-delete")?.addEventListener("click", () => {
		const r = store.active();
		if (!r || r.fixed) return; // Random is fixed — not deletable
		if (store.list().length <= 1) return;
		confirmModal(`Delete preset "${r.name}"?`, () => store.deletePreset(r.id));
	});

	document.getElementById("preset-restore")?.addEventListener("click", () => {
		confirmModal("Restore the built-in presets to factory settings? Your custom presets are kept; deleted built-ins are re-added.", () => store.restoreDefaults());
	});

	document.getElementById("preset-export")?.addEventListener("click", () => store.exportJSON());

	const importFile = document.getElementById("preset-import-file");
	document.getElementById("preset-import")?.addEventListener("click", () => importFile.click());
	importFile?.addEventListener("change", (ev) => {
		const file = ev.target.files[0];
		if (!file) return;
		const reader = new FileReader();
		reader.onload = () => {
			confirmModal("Replace your presets with the imported file?", () => {
				try {
					store.importJSON(reader.result);
				} catch (err) {
					alert("Import failed: " + err.message);
				}
			});
		};
		reader.readAsText(file);
		importFile.value = "";
	});
}

// ---- preset/random keyboard helpers ----------------------------------------
function nextPreset() {
	const l = store.list();
	if (!l.length) return;
	const i = l.findIndex((r) => r.id === store.activeId);
	store.setActive(l[(i + 1) % l.length].id);
}
function randomPreset() {
	const pool = store.list().filter((r) => r.id !== store.activeId);
	if (pool.length) store.setActive(pool[Math.floor(Math.random() * pool.length)].id);
}
// "Roll everything" (R): a random mode + the generative Random palette + the generative Random preset
// — one keystroke for a whole new look. Reactivity stays INDEPENDENT (its own toggle): with it off, R
// still changes mode + palette; the random preset's reactive mixer just stays dormant until react is on.
function fullyRandom(MV) {
	const pool = MV.MODES.filter((m) => m !== MV.current.version);
	const ver = pool.length ? pool[Math.floor(Math.random() * pool.length)] : MV.current.version;
	MV.palettes.rollRandom();
	MV.setMode(ver, "random"); // random mode + random palette in one rebuild
	store.setActive("random"); // generative -> rolls a random preset (mixer + a random character's signature)
}

// ---- palette editor (create/edit brightness->color ramps) ------------------
// hsl<->hex for the native <input type="color">. hslToHex mirrors colorToRGB's hsl formula so the
// swatch matches what the renderer produces; hexToHsl is the standard inverse.
function hslToHex(h, s, l) {
	const a = s * Math.min(l, 1 - l);
	const f = (n) => {
		const k = (n + h * 12) % 12;
		const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
		return Math.round(Math.max(0, Math.min(1, c)) * 255)
			.toString(16)
			.padStart(2, "0");
	};
	return "#" + f(0) + f(8) + f(4);
}
function hexToHsl(hex) {
	const r = parseInt(hex.slice(1, 3), 16) / 255;
	const g = parseInt(hex.slice(3, 5), 16) / 255;
	const b = parseInt(hex.slice(5, 7), 16) / 255;
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const d = max - min;
	const l = (max + min) / 2;
	let h = 0;
	let s = 0;
	if (d !== 0) {
		s = d / (1 - Math.abs(2 * l - 1));
		if (max === r) h = ((g - b) / d) % 6;
		else if (max === g) h = (b - r) / d + 2;
		else h = (r - g) / d + 4;
		h /= 6;
		if (h < 0) h += 1;
	}
	return { h, s, l };
}
// hsl (0..1) -> [r,g,b] 0..255 (same formula as hslToHex). Used by F4 to build rgba() accents.
function hslToRgb(h, s, l) {
	const a = s * Math.min(l, 1 - l);
	const f = (n) => {
		const k = (n + h * 12) % 12;
		return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
	};
	return [f(0), f(8), f(4)];
}

function wirePaletteControls(MV) {
	const sel = document.getElementById("effect-select");
	const editor = document.getElementById("palette-editor");
	const stopsHost = document.getElementById("palette-stops");
	const nameInput = document.getElementById("palette-name");
	const hint = document.getElementById("palette-hint");
	if (!sel) return;

	let editing = { id: null, stops: [] }; // working copy: stops = [{h,s,l,at}]
	const showEditor = (show) => {
		if (editor) editor.style.display = show ? "block" : "none";
	};

	const renderStops = () => {
		if (!stopsHost) return;
		stopsHost.innerHTML = "";
		editing.stops.forEach((st, idx) => {
			const row = document.createElement("div");
			row.className = "stop-row";
			const color = document.createElement("input");
			color.type = "color";
			color.title = "Colour for this brightness stop";
			color.value = hslToHex(st.h, st.s, st.l);
			color.addEventListener("input", () => {
				const c = hexToHsl(color.value);
				st.h = c.h;
				st.s = c.s;
				st.l = c.l;
			});
			const pos = document.createElement("input");
			pos.type = "range";
			pos.min = "0";
			pos.max = "100";
			pos.step = "1";
			pos.value = Math.round(st.at * 100);
			pos.title = "brightness position";
			pos.addEventListener("input", () => (st.at = parseFloat(pos.value) / 100));
			const rm = document.createElement("button");
			rm.className = "mini";
			rm.textContent = "×";
			rm.title = "remove stop";
			rm.addEventListener("click", () => {
				if (editing.stops.length > 2) {
					editing.stops.splice(idx, 1);
					renderStops();
				}
			});
			row.appendChild(color);
			row.appendChild(pos);
			row.appendChild(rm);
			stopsHost.appendChild(row);
		});
	};

	const openEditor = (id) => {
		if (id && palettes.isEditable(id)) {
			const r = palettes.get(id);
			editing = { id, stops: r.ramp.map((st) => ({ ...st })) };
			if (nameInput) nameInput.value = r.name;
		} else {
			const cur = palettes.get(sel.value);
			// "+ New" while on Random seeds from the current roll (keep-a-roll); else from a ramp or a default
			const seed = cur && cur.kind === "ramp" ? cur.ramp : cur && cur.kind === "random" && palettes._randomRamp ? palettes._randomRamp : [{ h: 0.33, s: 1, l: 0.05, at: 0 }, { h: 0.3, s: 1, l: 0.55, at: 0.6 }, { h: 0.25, s: 1, l: 0.95, at: 1 }];
			editing = { id: null, stops: seed.map((st) => ({ ...st })) };
			if (nameInput) nameInput.value = (cur ? cur.name : "Custom") + " copy";
		}
		renderStops();
		showEditor(true);
	};

	// prev / next / random palette (mirrors the Mode controls; cycles the whole dropdown list)
	const palList = () => palettes.list().map((r) => r.id);
	const curPalIdx = () => palList().indexOf(MV.current.effect);
	document.getElementById("palette-prev")?.addEventListener("click", () => {
		const l = palList();
		if (l.length) MV.setMode(MV.current.version, l[(curPalIdx() - 1 + l.length) % l.length]);
	});
	document.getElementById("palette-next")?.addEventListener("click", () => {
		const l = palList();
		if (l.length) MV.setMode(MV.current.version, l[(curPalIdx() + 1) % l.length]);
	});
	document.getElementById("palette-random")?.addEventListener("click", () => {
		const pool = palettes.defaultPoolIds().filter((id) => id !== MV.current.effect); // existing palettes only (not 🎲/debug)
		if (pool.length) MV.setMode(MV.current.version, pool[Math.floor(Math.random() * pool.length)]);
	});
	document.getElementById("palette-dice")?.addEventListener("click", () => {
		palettes.rollRandom(); // generate a brand-new random palette
		MV.setMode(MV.current.version, "random");
	});

	// "Pure chaos": the generative Random palette rolls full-random HSL (no harmony bias). Re-rolls live
	// if Random is the active palette so the toggle's effect is immediately visible.
	const chaosCb = document.getElementById("palette-chaos");
	if (chaosCb) {
		chaosCb.checked = !!palettes.chaos;
		chaosCb.addEventListener("change", () => {
			palettes.setChaos(chaosCb.checked);
			if (MV.current.effect === "random") {
				palettes.rollRandom();
				MV.setMode(MV.current.version, "random");
			}
		});
	}

	document.getElementById("palette-new")?.addEventListener("click", () => openEditor(null));
	document.getElementById("palette-edit")?.addEventListener("click", () => {
		if (palettes.isEditable(sel.value)) openEditor(sel.value);
		else {
			openEditor(null); // built-ins aren't editable in place — start a new one seeded from it
			if (hint) hint.textContent = "Built-in palettes can't be edited in place — this is a new copy you can save.";
		}
	});
	document.getElementById("palette-add-stop")?.addEventListener("click", () => {
		editing.stops.push({ h: 0.5, s: 1, l: 0.6, at: 0.5 });
		renderStops();
	});
	document.getElementById("palette-cancel")?.addEventListener("click", () => showEditor(false));
	document.getElementById("palette-save")?.addEventListener("click", () => {
		const ramp = editing.stops.slice().sort((a, b) => a.at - b.at);
		const name = (nameInput && nameInput.value ? nameInput.value : "Custom").trim() || "Custom";
		let id;
		if (editing.id) {
			if (!palettes.update(editing.id, { name, ramp })) {
				if (hint) hint.textContent = `"${name}" is a built-in palette name — pick another.`;
				return; // reserved — keep the editor open
			}
			id = editing.id;
		} else {
			const r = palettes.add(name, ramp);
			if (!r) {
				if (hint) hint.textContent = `"${name}" is a built-in palette name — pick another.`;
				return; // reserved — keep the editor open
			}
			id = r.id;
		}
		showEditor(false);
		MV.setMode(MV.current.version, id); // apply (rebuilds with the new colors)
	});

	document.getElementById("palette-delete")?.addEventListener("click", () => {
		const id = sel.value;
		const r = palettes.get(id);
		if (!r || r.fixed || palettes.list().length <= 1) return; // Random / Debug are fixed
		confirmModal(`Delete palette "${r.name}"?`, () => {
			const wasActive = MV.current.effect === id;
			palettes.deletePalette(id);
			if (wasActive) MV.setMode(MV.current.version, "mode-default");
		});
	});
	document.getElementById("palette-restore")?.addEventListener("click", () => {
		confirmModal("Restore the built-in palettes to factory settings? Your custom palettes are kept; deleted built-ins are re-added.", () => {
			palettes.restoreDefaults();
			MV.setMode(MV.current.version, MV.current.effect);
		});
	});

	// Export/Import: the palette library rides in the settings file alongside presets + director.
	store.palettesIO = { get: () => palettes.exportData(), set: (arr) => palettes.importData(arr) };
}

// ---- F4: UI follows palette — re-skin the WHOLE UI in the palette's DOMINANT colour ----
// Opt-in (default OFF — green is the sane default). When on, the UI is recoloured MONOCHROMATICALLY
// around the palette's dominant/perceived hue — the colour the RAIN reads as (its vivid mid-body, where
// most glyphs sit), NOT its sparse bright heads. That keeps the panel matching the rain instead of
// clashing (e.g. a purple-dominant palette → purple UI, not an orange one keyed off the bright tips).
// Every themed colour is a CSS var (backgrounds, controls, borders, glows, the player bar, every
// rgba(var(--accent-rgb),a) literal) so the WHOLE UI follows, not just an accent. Per-role lightness is
// synthesized + clamped (dark surfaces → vivid accents → light text) so any palette stays legible. Works
// for ramp palettes AND multi-colour / "pure chaos" stripe rolls (the dominant is taken from the stripe).
// Reset (→ :root green) when off, or when the palette has no extractable colours (mode-default / plain /
// debug / the built-in full-spectrum stripe).
function wireUiFollowPalette(MV) {
	const root = document.documentElement;
	const toggle = document.getElementById("ui-follow-palette");
	// Every var F4 overrides; reset removes them so the :root green defaults take over again.
	// (--panel-border + --shadow are NOT here: they reference rgba(var(--accent-rgb), a) in :root, so
	// they follow automatically once --accent-rgb is set/cleared.)
	const VARS = ["--bg", "--deep-rgb", "--panel-bg", "--control-bg", "--input-bg", "--green-deep", "--green-dim", "--green", "--text-dim", "--text", "--accent-rgb"];
	const resetVars = () => {
		for (const v of VARS) root.style.removeProperty(v);
	};
	const hslCss = (h, s, l) => `hsl(${Math.round(((((h % 1) + 1) % 1) * 360))} ${Math.round(s * 100)}% ${Math.round(l * 100)}%)`;
	const chroma = (c) => c.s * (1 - Math.abs(2 * c.l - 1)); // HSL chroma — peaks at l=0.5, ~0 at black/white
	// Representative colours of the active palette as {h,s,l} (+ the ramp itself when it has one), or null
	// for the structural built-ins. A ramp → its stops; the generative Random → its current roll, which is
	// EITHER a brightness ramp OR a multi-colour stripe (so chaos / rainbow rolls are covered too).
	const paletteColors = (id) => {
		const r = MV.palettes.get(id);
		if (!r) return null;
		if (r.kind === "ramp" && Array.isArray(r.ramp)) return { ramp: r.ramp, cols: r.ramp.map((st) => ({ h: st.h, s: st.s, l: st.l })) };
		if (r.kind === "random") {
			const p = MV.palettes;
			if (p._randomKind === "stripe" && Array.isArray(p._randomStripe)) return { ramp: null, cols: p._randomStripe.map((c) => ({ h: c.values[0], s: c.values[1], l: c.values[2] })) };
			if (Array.isArray(p._randomRamp)) return { ramp: p._randomRamp, cols: p._randomRamp.map((st) => ({ h: st.h, s: st.s, l: st.l })) };
		}
		return null; // moded / plain / debug / built-in spectrum stripe -> nothing to extract
	};
	// Sample a ramp at brightness `at` (0..1), lerping h (shortest path) / s / l.
	const sampleRamp = (ramp, at) => {
		const s = ramp.slice().sort((a, b) => a.at - b.at);
		if (at <= s[0].at) return s[0];
		if (at >= s[s.length - 1].at) return s[s.length - 1];
		for (let i = 0; i < s.length - 1; i++) {
			const a = s[i], b = s[i + 1];
			if (at >= a.at && at <= b.at) {
				const t = (at - a.at) / (b.at - a.at || 1);
				let dh = b.h - a.h;
				if (dh > 0.5) dh -= 1;
				else if (dh < -0.5) dh += 1;
				return { h: a.h + dh * t, s: a.s + (b.s - a.s) * t, l: a.l + (b.l - a.l) * t };
			}
		}
		return s[s.length - 1];
	};
	// The palette's DOMINANT hue+sat = the colour the rain reads as. For a ramp that's the mid-body
	// (most visible glyphs are mid/dim, not bright heads) → sample at ~0.45; fall back to the max-chroma
	// colour if that point is washed out. For a stripe (no brightness order) → the max-chroma colour.
	const dominantHS = (pc) => {
		if (pc.ramp) {
			const mid = sampleRamp(pc.ramp, 0.45);
			if (chroma(mid) > 0.16) return { h: mid.h, s: mid.s };
		}
		let dom = null, best = -1;
		for (const c of pc.cols) {
			const ch = chroma(c);
			if (ch > best) {
				best = ch;
				dom = c;
			}
		}
		if (!dom || best < 0.1) return null; // grayscale palette -> no hue to follow
		return { h: dom.h, s: dom.s };
	};
	const apply = () => {
		if (!toggle || !toggle.checked) return resetVars();
		const pc = paletteColors(MV.current.effect);
		if (!pc || !pc.cols.length) return resetVars(); // mode-default / plain / debug / spectrum -> keep green
		const d = dominantHS(pc);
		if (!d) return resetVars(); // near-grayscale palette -> keep green
		const h = ((d.h % 1) + 1) % 1;
		const s = clamp(d.s, 0.5, 1);
		// Monochromatic re-skin: ONE hue, lightness synthesized per role (dark surfaces → vivid accents →
		// light text), all clamped so any palette stays legible. Backgrounds desaturate so the dark tints
		// don't muddy; text desaturates more so it reads as a near-white tint of the hue.
		const css = (l, sat = s) => hslCss(h, sat, l);
		const rgb = (l, sat = s) => hslToRgb(h, sat, l).join(", ");
		root.style.setProperty("--bg", css(0.022, s * 0.5));
		root.style.setProperty("--deep-rgb", rgb(0.03, s * 0.5)); // player bar / drop-hint
		root.style.setProperty("--panel-bg", `rgba(${rgb(0.06, s * 0.55)}, 0.9)`);
		root.style.setProperty("--control-bg", css(0.1, s * 0.55));
		root.style.setProperty("--input-bg", css(0.075, s * 0.55));
		root.style.setProperty("--green-deep", css(0.3, s * 0.9));
		root.style.setProperty("--green-dim", css(0.48));
		root.style.setProperty("--green", css(0.6));
		root.style.setProperty("--text-dim", css(0.66, s * 0.5));
		root.style.setProperty("--text", css(0.88, s * 0.32));
		root.style.setProperty("--accent-rgb", rgb(0.58)); // drives --panel-border, --shadow + every rgba(var(--accent-rgb),a)
	};
	toggle?.addEventListener("change", () => {
		apply();
		scheduleSessionSave();
	});
	window.addEventListener("viz:mode", apply); // active palette changed -> re-derive
	window.addEventListener("viz:palettes-changed", apply); // a ramp was edited / restored -> re-derive
	return {
		apply,
		isOn: () => !!(toggle && toggle.checked),
		setOn: (v) => {
			if (toggle) toggle.checked = !!v;
			apply();
		},
	};
}

// ---- F6: collapsible panel sections — click a heading to fold its section (persisted by index) ----
function wireCollapsibleSections() {
	const sections = [...document.querySelectorAll("#panel section")];
	sections.forEach((sec) => {
		const h3 = sec.querySelector("h3");
		if (!h3) return;
		h3.addEventListener("click", () => {
			sec.classList.toggle("section-collapsed");
			scheduleSessionSave();
		});
	});
	return {
		get: () => sections.reduce((acc, s, i) => (s.classList.contains("section-collapsed") ? (acc.push(i), acc) : acc), []),
		set: (arr) => {
			if (!Array.isArray(arr)) return;
			sections.forEach((s, i) => s.classList.toggle("section-collapsed", arr.includes(i)));
		},
	};
}

// ---- reactive master toggle + intensity + keyboard shortcuts ---------------
function wireReactiveBasics(MV, A) {
	const reactiveToggle = document.getElementById("reactive-toggle");
	reactiveToggle?.addEventListener("change", () => (A.reactive = reactiveToggle.checked));

	const intensity = document.getElementById("intensity");
	const intensityVal = document.getElementById("intensity-val");
	intensity?.addEventListener("input", () => {
		A.intensity = parseFloat(intensity.value);
		if (intensityVal) intensityVal.textContent = A.intensity.toFixed(2);
		setDirty(true);
	});

	// N/B next/prev mode · ⇧N random mode · P next preset · ⇧P random preset · R fully random.
	// (Shell keys Tab/D/F are in boot.js; Space is the player's.)
	window.addEventListener("keydown", (e) => {
		if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
		const k = e.key.toLowerCase();
		if (k === "n") {
			if (e.shiftKey) MV.randomMode();
			else MV.nextMode(1);
		} else if (k === "b") {
			MV.nextMode(-1);
		} else if (k === "p") {
			if (e.shiftKey) randomPreset();
			else nextPreset();
		} else if (k === "r") {
			fullyRandom(MV, A);
		} else if (k === "t") {
			transitions.triggerTitle(); // song-title splash (manual)
		}
	});
}

// ---- per-preset Advanced: shock shape + hue behavior (reads/writes A.shockCfg / A.hueCfg) -----
function wirePresetAdvanced(MV, A) {
	const $ = (id) => document.getElementById(id);
	const ensure = () => {
		if (!A.shockCfg) A.shockCfg = { origin: "center", speed: 0.9, decay: 0.45, gain: 0.8 };
		if (!A.hueCfg) A.hueCfg = { mode: "none" };
	};
	const shockOrigin = $("adv-shock-origin");
	const hueMode = $("adv-hue-mode");
	// scene-binding dropdowns: on apply, switch to a mode / palette (blank = keep current)
	const jumpMode = $("adv-jump-mode");
	const jumpPalette = $("adv-jump-palette");
	const fillSelect = (sel, items, labelOf, current) => {
		if (!sel) return;
		sel.innerHTML = "";
		const none = document.createElement("option");
		none.value = "";
		none.textContent = "(none — keep current)";
		sel.appendChild(none);
		for (const id of items) {
			const o = document.createElement("option");
			o.value = id;
			o.textContent = labelOf(id);
			sel.appendChild(o);
		}
		sel.value = current || "";
	};
	const fillJumpSelects = () => {
		fillSelect(jumpMode, MV.MODES, (id) => (MV.MODE_LABELS && MV.MODE_LABELS[id]) || id, A.jumpMode);
		fillSelect(jumpPalette, MV.palettes.list().map((p) => p.id), (id) => MV.palettes.get(id).name, A.jumpPalette);
	};
	jumpMode?.addEventListener("change", () => {
		A.jumpMode = jumpMode.value || null;
		setDirty(true);
	});
	jumpPalette?.addEventListener("change", () => {
		A.jumpPalette = jumpPalette.value || null;
		setDirty(true);
	});
	window.addEventListener("viz:palettes-changed", fillJumpSelects);
	// [slider id, value-label id, which cfg, field key, decimals, default]
	const SLIDERS = [
		["adv-shock-speed", "adv-shock-speed-val", "shock", "speed", 2, 0.9],
		["adv-shock-decay", "adv-shock-decay-val", "shock", "decay", 2, 0.45],
		["adv-shock-gain", "adv-shock-gain-val", "shock", "gain", 2, 0.8],
		["adv-hue-rate", "adv-hue-rate-val", "hue", "rate", 3, 0.02],
		["adv-hue-spread", "adv-hue-spread-val", "hue", "spread", 2, 0.5],
		["adv-hue-bleed", "adv-hue-bleed-val", "hue", "bleed", 2, 0.5],
	];
	const cfgOf = (which) => (which === "shock" ? A.shockCfg : A.hueCfg);

	// per-knob driver editor: edits A.drivers (the working COPY) live; save snapshots it to the record.
	const featOpts = DRIVER_FEATURES.concat(["one"]);
	const driverHost = $("preset-drivers");
	const channelHost = $("preset-channel-drivers");
	// shared mix-term editor (feature dropdown + amount + remove + "+ feature") for both the per-knob
	// driver rows and the per-channel rows. `mix` is edited in place; `rerender` rebuilds after add/remove.
	const makeTermsEl = (mix, rerender) => {
		const termsEl = document.createElement("div");
		termsEl.className = "drv-terms";
		mix.forEach((term, i) => {
			const sel = document.createElement("select");
			sel.className = "drv-feat";
			sel.title = "Audio feature that drives this";
			for (const fn of featOpts) {
				const o = document.createElement("option");
				o.value = fn;
				o.textContent = fn;
				if (fn === term.f) o.selected = true;
				sel.appendChild(o);
			}
			sel.addEventListener("change", () => {
				term.f = sel.value;
				setDirty(true);
			});
			const amt = document.createElement("input");
			amt.type = "number";
			amt.step = "0.05";
			amt.className = "drv-num";
			amt.title = "How strongly this feature contributes (coefficient)";
			amt.value = term.a;
			amt.addEventListener("input", () => {
				const v = parseFloat(amt.value);
				if (Number.isFinite(v)) {
					term.a = v;
					setDirty(true);
				}
			});
			const rm = document.createElement("button");
			rm.className = "mini drv-rm";
			rm.textContent = "✕";
			rm.title = "remove this feature";
			rm.addEventListener("click", () => {
				mix.splice(i, 1);
				setDirty(true);
				rerender();
			});
			termsEl.appendChild(sel);
			termsEl.appendChild(amt);
			termsEl.appendChild(rm);
		});
		const add = document.createElement("button");
		add.className = "mini drv-add";
		add.textContent = "+ feature";
		add.title = "add a driving feature";
		add.addEventListener("click", () => {
			mix.push({ f: featOpts[0], a: 0.3 });
			setDirty(true);
			rerender();
		});
		termsEl.appendChild(add);
		return termsEl;
	};
	function renderDrivers() {
		if (!driverHost) return;
		driverHost.innerHTML = "";
		const drivers = A.drivers;
		if (!drivers) {
			driverHost.textContent = "—";
			return;
		}
		for (const knob of Object.keys(drivers)) {
			const d = drivers[knob];
			const mix = d.mix || (d.mix = []);
			const row = document.createElement("div");
			row.className = "drv-knob";
			const head = document.createElement("div");
			head.className = "drv-head";
			const nm = document.createElement("span");
			nm.className = "drv-name";
			nm.textContent = knob;
			const op = document.createElement("span");
			op.className = "drv-op";
			op.textContent = d.mode === "add" ? "+" : "×";
			const baseInp = document.createElement("input");
			baseInp.type = "number";
			baseInp.step = "0.05";
			baseInp.className = "drv-num";
			baseInp.value = d.mode === "add" ? d.const ?? 0 : d.scale ?? 1;
			baseInp.title = d.mode === "add" ? "constant offset" : "base multiplier";
			baseInp.addEventListener("input", () => {
				const v = parseFloat(baseInp.value);
				if (!Number.isFinite(v)) return;
				if (d.mode === "add") d.const = v;
				else d.scale = v;
				setDirty(true);
			});
			head.appendChild(nm);
			head.appendChild(op);
			head.appendChild(baseInp);
			row.appendChild(head);
			const termsEl = makeTermsEl(mix, renderDrivers);
			row.appendChild(termsEl);
			driverHost.appendChild(row);
		}
	}

	// per-channel driver editor: edits A.channelDrivers (pulse/bassWarp/windSway feature mixes). The
	// output FORM per channel is fixed (baked in CHANNEL_META) — only the feature mix is editable.
	function renderChannelDrivers() {
		if (!channelHost) return;
		channelHost.innerHTML = "";
		const cd = A.channelDrivers;
		if (!cd) {
			channelHost.textContent = "—";
			return;
		}
		for (const ch of Object.keys(cd)) {
			const d = cd[ch];
			const mix = d.mix || (d.mix = []);
			const row = document.createElement("div");
			row.className = "drv-knob";
			const head = document.createElement("div");
			head.className = "drv-head";
			const nm = document.createElement("span");
			nm.className = "drv-name";
			nm.textContent = (CHANNEL_LABELS && CHANNEL_LABELS[ch]) || ch;
			head.appendChild(nm);
			row.appendChild(head);
			row.appendChild(makeTermsEl(mix, renderChannelDrivers));
			channelHost.appendChild(row);
		}
	}

	refreshPresetAdvanced = () => {
		if (shockOrigin) shockOrigin.value = (A.shockCfg && A.shockCfg.origin) || "center";
		if (hueMode) hueMode.value = (A.hueCfg && A.hueCfg.mode) || "none";
		for (const [slId, vId, which, key, dp, def] of SLIDERS) {
			const sl = $(slId);
			const v = $(vId);
			const cfg = cfgOf(which) || {};
			const val = cfg[key] != null ? cfg[key] : def;
			if (sl) sl.value = val;
			if (v) v.textContent = (+val).toFixed(dp);
		}
		fillJumpSelects();
		renderDrivers();
		renderChannelDrivers();
	};

	shockOrigin?.addEventListener("change", () => {
		ensure();
		A.shockCfg.origin = shockOrigin.value;
		setDirty(true);
	});
	hueMode?.addEventListener("change", () => {
		ensure();
		A.hueCfg.mode = hueMode.value;
		setDirty(true);
	});
	for (const [slId, vId, which, key, dp] of SLIDERS) {
		const sl = $(slId);
		const v = $(vId);
		sl?.addEventListener("input", () => {
			ensure();
			cfgOf(which)[key] = parseFloat(sl.value);
			if (v) v.textContent = parseFloat(sl.value).toFixed(dp);
			setDirty(true);
		});
	}

	window.addEventListener("viz:preset", refreshPresetAdvanced);
	refreshPresetAdvanced();
}

// ---- session persistence: a refresh restores everything but musical state -----
// Snapshots the live selection + working state to matrixviz.session.v1; restored once on load.
// ---- keyboard cheat-sheet overlay (? toggles; Esc closes) -----
function wireCheatSheet() {
	const sheet = document.createElement("div");
	sheet.className = "cheatsheet hidden";
	const playbackRows = [
		["Space", "Play / pause"],
		["← / →", "Scrub −/+ 5s"],
		["↑ / ↓", "Volume −/+ 5%"],
		["[ / ]", "Previous / next track"],
		["M", "Mute"],
	];
	// Embedded: the host owns playback, so its transport keys aren't bound — omit them from help.
	const rows = [
		...(isEmbedded() ? [] : playbackRows),
		["N / B", "Next / previous mode"],
		["⇧N", "Random mode"],
		["P / ⇧P", "Next / random preset"],
		["R", "Randomize everything"],
		["T", "Show song title"],
		["Tab", "Toggle panel"],
		["D", "Debug overlay"],
		["`", "FPS meter"],
		["F", "Fullscreen"],
		["?", "This help"],
	];
	sheet.innerHTML = '<h3>Keyboard shortcuts</h3><div class="cheat-rows">' + rows.map((r) => `<kbd>${r[0]}</kbd><span>${r[1]}</span>`).join("") + '</div><p class="hint">? or Esc to close · right-click the viz for a menu · double-click the rain for fullscreen</p>';
	document.body.appendChild(sheet);
	window.addEventListener("keydown", (e) => {
		if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
		if (e.key === "?") {
			e.preventDefault();
			sheet.classList.toggle("hidden");
		} else if (e.key === "Escape") {
			sheet.classList.add("hidden");
		}
	});
}

// ---- right-click context menu on the viz (native menu kept on the panel + inputs) -----
function wireContextMenu(MV, A) {
	const menu = document.createElement("div");
	menu.className = "context-menu hidden";
	document.body.appendChild(menu);
	const reactiveToggle = document.getElementById("reactive-toggle");
	const directorToggle = document.getElementById("director-toggle");
	const panel = document.getElementById("panel");
	const flip = (cb) => {
		if (!cb) return;
		cb.checked = !cb.checked;
		cb.dispatchEvent(new Event("change"));
	};
	const items = () => [
		// Embedded: the host owns playback — no transport items in the viz's own menu.
		...(isEmbedded() ? [] : [["▶ / ⏸  Play / Pause", () => MV.player.toggle()], ["⏭  Next track", () => MV.player.next()], ["⏮  Previous track", () => MV.player.prev()], null]),
		["🎲  Randomize everything", () => fullyRandom(MV)],
		[`${A.reactive ? "✓ " : ""}React to music`, () => flip(reactiveToggle)],
		[`${MV.director.enabled ? "✓ " : ""}Director (auto-switch)`, () => flip(directorToggle)],
		null,
		["Next mode", () => MV.nextMode(1)],
		[
			"Next palette",
			() => {
				const l = palettes.defaultPoolIds();
				const i = l.indexOf(MV.current.effect);
				MV.setMode(MV.current.version, l[(i + 1) % l.length] || l[0]);
			},
		],
		[
			"Next preset",
			() => {
				const l = store.list().filter((r) => !r.generative);
				const i = l.findIndex((r) => r.id === store.activeId);
				if (l.length) store.setActive(l[(i + 1) % l.length].id);
			},
		],
		null,
		["Toggle panel", () => panel && panel.classList.toggle("collapsed")],
		["Fullscreen", () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen && document.documentElement.requestFullscreen())],
		null,
		["⤓  Export all settings", () => store.exportJSON()],
		["⤒  Import all settings", () => document.getElementById("preset-import") && document.getElementById("preset-import").click()],
	];
	const hide = () => menu.classList.add("hidden");
	const show = (x, y) => {
		menu.innerHTML = "";
		for (const it of items()) {
			if (!it) {
				const sep = document.createElement("div");
				sep.className = "ctx-sep";
				menu.appendChild(sep);
				continue;
			}
			const b = document.createElement("button");
			b.className = "ctx-item";
			b.textContent = it[0];
			b.addEventListener("click", () => {
				hide();
				it[1]();
			});
			menu.appendChild(b);
		}
		menu.classList.remove("hidden");
		const r = menu.getBoundingClientRect();
		menu.style.left = Math.min(x, window.innerWidth - r.width - 6) + "px";
		menu.style.top = Math.min(y, window.innerHeight - r.height - 6) + "px";
	};
	// Universal: the custom menu covers EVERY surface — the viz, the panel, the playlist, the player.
	// The native menu is kept only inside the menu itself and on editable text fields (so copy/paste
	// still works in the name inputs / number boxes); sliders, checkboxes, selects and buttons all get
	// the custom menu.
	const EDITABLE = 'input[type="text"], input[type="number"], input[type="search"], input[type="email"], input[type="url"], input[type="tel"], input[type="password"], input:not([type]), textarea, [contenteditable="true"]';
	window.addEventListener("contextmenu", (e) => {
		const t = e.target;
		if (t.closest && (t.closest(".context-menu") || t.closest(EDITABLE))) return;
		e.preventDefault();
		show(e.clientX, e.clientY);
	});
	window.addEventListener("click", hide);
	window.addEventListener("keydown", (e) => {
		if (e.key === "Escape") hide();
	});
}

function wireSession(MV, A) {
	const panel = document.getElementById("panel");
	const overlay = document.getElementById("overlay");
	const reactiveToggle = document.getElementById("reactive-toggle");
	const intensity = document.getElementById("intensity");
	const intensityVal = document.getElementById("intensity-val");
	const directorToggle = document.getElementById("director-toggle");

	const snapshot = () => ({
		mode: MV.current.version, // NOT "version" — that key is the schema version in session.save()
		effect: MV.current.effect,
		presetId: store.activeId,
		mixer: JSON.parse(JSON.stringify(A.mixer || {})),
		characterId: A.characterId || null,
		shockCfg: A.shockCfg ? { ...A.shockCfg } : null,
		hueCfg: A.hueCfg ? { ...A.hueCfg } : null,
		drivers: A.drivers ? JSON.parse(JSON.stringify(A.drivers)) : null,
		channelDrivers: A.channelDrivers ? JSON.parse(JSON.stringify(A.channelDrivers)) : null,
		driversSchema: PRESET_SCHEMA, // so a stale working-copy from a pre-A1 session isn't restored over the re-baked record
		jumpMode: A.jumpMode || null,
		jumpPalette: A.jumpPalette || null,
		intensity: A.intensity ?? 1,
		reactive: !!A.reactive,
		dirty: !!dirty,
		directorEnabled: !!(MV.director && MV.director.enabled),
		panelCollapsed: !!(panel && panel.classList.contains("collapsed")),
		overlayVisible: !!(overlay && !overlay.classList.contains("hidden")),
		uiFollowPalette: !!(uiFollow && uiFollow.isOn()),
		collapsedSections: collapsibleSections ? collapsibleSections.get() : [],
	});

	// Restore once. boot already set mode+palette from the session (flash-free), so setMode here
	// only re-fires if they differ; then layer the preset + the saved working state on top.
	const s = session.load();
	if (s) {
		try {
			if (s.mode && (s.mode !== MV.current.version || s.effect !== MV.current.effect)) {
				MV.setMode(s.mode, s.effect || MV.current.effect);
			}
			if (s.presetId && store.list().some((r) => r.id === s.presetId)) {
				store.setActive(s.presetId, { switchMode: false }); // syncs mixer UI + intensity via viz:preset
			}
			// overlay the saved working state (incl. unsaved edits) on top of the preset's mixer
			if (s.mixer && Object.keys(s.mixer).length) {
				A.mixer = s.mixer;
				if (s.characterId) A.characterId = s.characterId;
				A.intensity = s.intensity ?? A.intensity ?? 1;
				refreshMixer(A);
				if (intensity) intensity.value = A.intensity;
				if (intensityVal) intensityVal.textContent = (A.intensity ?? 1).toFixed(2);
				setDirty(!!s.dirty);
			}
			if (s.shockCfg) A.shockCfg = s.shockCfg;
			if (s.hueCfg) A.hueCfg = s.hueCfg;
			// Only restore the working driver copy if it matches the current driver schema. On an A1
			// upgrade the saved copy is stale, so the freshly-activated (re-baked) record's drivers stand.
			if (s.driversSchema === PRESET_SCHEMA) {
				if (s.drivers) A.drivers = s.drivers;
				if (s.channelDrivers) A.channelDrivers = s.channelDrivers;
			}
			if (s.jumpMode !== undefined) A.jumpMode = s.jumpMode;
			if (s.jumpPalette !== undefined) A.jumpPalette = s.jumpPalette;
			refreshPresetAdvanced();
			A.reactive = !!s.reactive;
			if (reactiveToggle) reactiveToggle.checked = !!s.reactive;
			if (MV.director && typeof s.directorEnabled === "boolean") {
				MV.director.enabled = s.directorEnabled;
				if (directorToggle) directorToggle.checked = s.directorEnabled;
			}
			if (panel) panel.classList.toggle("collapsed", !!s.panelCollapsed);
			if (overlay) overlay.classList.toggle("hidden", !s.overlayVisible);
			if (uiFollow && typeof s.uiFollowPalette === "boolean") uiFollow.setOn(s.uiFollowPalette); // F4 (palette already restored above)
			if (collapsibleSections && Array.isArray(s.collapsedSections)) collapsibleSections.set(s.collapsedSections); // F6
		} catch (e) {
			console.warn("[matrix-music-viz] session restore failed:", e);
		}
	} else {
		// Fresh launch (no saved session): the app's first-launch defaults — react to music + director on.
		A.reactive = true;
		if (reactiveToggle) reactiveToggle.checked = true;
		if (MV.director) {
			MV.director.enabled = true;
			if (directorToggle) directorToggle.checked = true;
		}
	}

	// Debounced save on any state change. setDirty (mixer/intensity/random) calls scheduleSessionSave
	// directly; here we add the selection/UI triggers.
	let t = null;
	scheduleSessionSave = () => {
		if (t) clearTimeout(t);
		t = setTimeout(() => session.save(snapshot()), 300);
	};
	window.addEventListener("viz:mode", scheduleSessionSave);
	window.addEventListener("viz:preset", scheduleSessionSave);
	window.addEventListener("viz:presets-changed", scheduleSessionSave);
	reactiveToggle?.addEventListener("change", scheduleSessionSave);
	directorToggle?.addEventListener("change", scheduleSessionSave);
	if (window.MutationObserver) {
		const mo = new MutationObserver(scheduleSessionSave); // panel collapse / overlay toggle via any path
		if (panel) mo.observe(panel, { attributes: true, attributeFilter: ["class"] });
		if (overlay) mo.observe(overlay, { attributes: true, attributeFilter: ["class"] });
	}
	scheduleSessionSave(); // persist the restored/initial baseline
}
