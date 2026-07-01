// matrix-music-viz — beat / onset detection + envelopes.
// Reads A.features.flux (spectral-flux onset signal) and A.features.bass (kick energy),
// both written by audio-engine.js earlier in the frame. Produces:
//   features.beat      1 on the frame a musical beat fires (else 0)
//   features.beatPulse decaying 0..1 envelope after each beat (punchy)
//   features.beatBass  decaying 0..1 envelope after each bass/kick beat
//   features.onset     decaying 0..1 envelope after any spectral onset
//   features.bpm       estimated tempo
//   features.beatPhase predicted 0..1 position within the current beat
//
// Strategy: bass-energy beats drive the pulse for bass-heavy music; when the bass is
// sparse (jazz, classical, a-cappella) prominent spectral onsets fall back in as beats,
// so every kind of track keeps a sense of pulse.

import { A } from "../vendor/matrix/js/reactive.js";
import { BpmEstimator } from "./bpm.js";

export const beat = {
	fluxHist: new Float32Array(48),
	fluxHead: 0,
	fluxFill: 0,
	bassHist: new Float32Array(64),
	bassHead: 0,
	bassFill: 0,
	prevFlux: 0,
	lastOnsetT: -1,
	lastBeatT: -1,
	lastBassBeatT: -1,
	onsetEnv: 0,
	pulseEnv: 0,
	bassEnv: 0,
	bpm: new BpmEstimator(),

	_avg(buf, fill) {
		let s = 0;
		const n = fill;
		for (let i = 0; i < n; i++) s += buf[i];
		return n > 0 ? s / n : 0;
	},

	process(t, dt) {
		const f = A.features;
		const flux = f.flux;
		const bass = f.bass;

		// --- spectral-flux onset (adaptive threshold) ---
		const fluxMean = this._avg(this.fluxHist, this.fluxFill);
		const onsetThr = fluxMean * 1.55 + 0.025;
		let onset = 0;
		if (flux > onsetThr && flux >= this.prevFlux && t - this.lastOnsetT > 0.09) {
			onset = 1;
			this.lastOnsetT = t;
		}
		this.fluxHist[this.fluxHead] = flux;
		this.fluxHead = (this.fluxHead + 1) % this.fluxHist.length;
		if (this.fluxFill < this.fluxHist.length) this.fluxFill++;
		this.prevFlux = flux;

		// --- bass/kick beat (energy vs local average) ---
		const bassMean = this._avg(this.bassHist, this.bassFill);
		let bassBeat = 0;
		if (bass > bassMean * 1.35 && bass > 0.22 && t - this.lastBassBeatT > 0.17) {
			bassBeat = 1;
			this.lastBassBeatT = t;
		}
		this.bassHist[this.bassHead] = bass;
		this.bassHead = (this.bassHead + 1) % this.bassHist.length;
		if (this.bassFill < this.bassHist.length) this.bassFill++;

		// --- unified musical beat ---
		let beatNow = 0;
		if (bassBeat) {
			beatNow = 1;
			this.lastBeatT = t;
			this.bpm.addBeat(t);
		} else if (onset && t - this.lastBassBeatT > 1.1 && flux > onsetThr * 1.15) {
			// bass-sparse passage: let strong onsets carry the pulse
			beatNow = 1;
			this.lastBeatT = t;
			this.bpm.addBeat(t);
		}

		// --- decaying envelopes ---
		this.onsetEnv *= Math.exp(-dt / 0.12);
		this.pulseEnv *= Math.exp(-dt / 0.18);
		this.bassEnv *= Math.exp(-dt / 0.22);
		if (onset) this.onsetEnv = 1;
		if (bassBeat) this.bassEnv = 1;
		if (beatNow) this.pulseEnv = Math.max(this.pulseEnv, bassBeat ? 1 : 0.6);

		f.beat = beatNow;
		f.onset = this.onsetEnv;
		f.beatPulse = this.pulseEnv;
		f.beatBass = this.bassEnv;
		f.bpm = this.bpm.bpm;

		// beat clock + counter (for falling beat-spawned drops)
		this.beatClock = (this.beatClock || 0) + dt;
		if (beatNow) {
			this.beatClock = 0;
			this.beatCount = (this.beatCount || 0) + 1;
		}
		f.beatClock = this.beatClock;
		f.beatCount = this.beatCount || 0;

		// --- predicted beat phase ---
		if (this.bpm.bpm > 0 && this.lastBeatT >= 0) {
			const period = 60 / this.bpm.bpm;
			let ph = (t - this.lastBeatT) / period;
			ph = ph - Math.floor(ph);
			f.beatPhase = ph;
		} else {
			f.beatPhase = 0;
		}
	},
};

export function initBeat(MV) {
	MV.onFrame((t, dt) => beat.process(t, dt));
	return beat;
}
