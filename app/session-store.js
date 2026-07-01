// matrix-music-viz — session persistence.
// Snapshots the LIVE viz selection + working state (mode, palette, active preset, the working
// mixer/character/intensity INCLUDING unsaved edits, reactivity, director on/off, panel + overlay
// UI) so a page refresh restores everything EXCEPT musical state (loaded tracks + playback
// position, which live in the player's own prefs). Mirrors the preset/palette/director stores:
// pure persistence here; the snapshot/restore wiring lives in app-init.js where the live state is.

const LS_KEY = "matrixviz.session.v1";

export const session = {
	load() {
		try {
			const o = JSON.parse(localStorage.getItem(LS_KEY));
			return o && o.version === 1 ? o : null;
		} catch (e) {
			return null;
		}
	},
	save(data) {
		try {
			localStorage.setItem(LS_KEY, JSON.stringify({ version: 1, ...data }));
		} catch (e) {
			/* private mode / quota — non-fatal */
		}
	},
};
