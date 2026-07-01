// matrix-music-viz — debug / feature overlay + beat flash.
// Reads A.features each frame and drives the meter bars, BPM + centroid readouts, and
// a full-screen beat flash. Throttled DOM writes (~20Hz) — it's a diagnostic surface,
// toggled with the D key, hidden by default.

import { A } from "../vendor/matrix/js/reactive.js";

// MATRIX-VIZ perf: cached opacity strings (0.00..0.50) so the per-frame beat flash never
// allocates a string via toFixed. Indexed by an integer hundredths bucket.
const FLASH_STR = Array.from({ length: 51 }, (_, i) => (i / 100).toFixed(2));

export function initOverlay(MV) {
	const meters = {
		bass: document.getElementById("m-bass"),
		lowMid: document.getElementById("m-lowMid"),
		mid: document.getElementById("m-mid"),
		highMid: document.getElementById("m-highMid"),
		treble: document.getElementById("m-treble"),
		level: document.getElementById("m-level"),
	};
	const bpmReadout = document.getElementById("bpm-readout");
	const centroidReadout = document.getElementById("centroid-readout");
	const flash = document.getElementById("beat-flash");
	const overlay = document.getElementById("overlay");

	let acc = 0;
	let lastBpm = -1;
	let lastFlash = -1;

	MV.onFrame((t, dt) => {
		const f = A.features;

		// beat flash runs every frame; bucket to hundredths + cached strings, write only on change
		if (flash) {
			const op = A.reactive ? Math.min(50, (f.beatPulse * 42) | 0) : 0;
			if (op !== lastFlash) {
				lastFlash = op;
				flash.style.opacity = FLASH_STR[op];
			}
		}

		// meters + readouts throttled
		acc += dt;
		if (acc < 0.05) return; // ~20 Hz
		acc = 0;
		if (overlay && overlay.classList.contains("hidden")) return; // skip when not shown

		for (const key in meters) {
			const el = meters[key];
			if (el) el.style.height = (f[key] * 100).toFixed(0) + "%";
		}
		const bpm = Math.round(f.bpm);
		if (bpm !== lastBpm && bpmReadout) {
			bpmReadout.textContent = bpm > 0 ? bpm : "–";
			lastBpm = bpm;
		}
		if (centroidReadout) centroidReadout.textContent = f.centroid.toFixed(2);
	});
}
