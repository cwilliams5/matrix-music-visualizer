// matrix-music-viz — audio analysis engine.
// Each frame it extracts a unified feature set into A.features:
//   level/rms, 5 log-spaced bands (bass..treble), spectral centroid (brightness),
//   spectral flux (onset energy), stereo balance/width, a 64-bin spectrum, plus short/long
//   energy envelopes for the director. Adaptive gain control (per-feature peak followers)
//   normalizes everything to ~0..1 so quiet ambient and wall-of-sound both react well.
//
// TWO SOURCES, one analysis (see embed.js):
//   - Standalone: a Web Audio graph on the <audio> element (`attach`, mode 'analyser').
//   - Embedded:   raw PCM + FFT pulled from the host bridge (`attachHost`, mode 'host').
// `_acquire*` fills this.mag / timeData / timeL/R from the active source; the shared analysis
// in `sample()` is byte-identical either way, so reactivity matches across both modes.
//
// Beat/BPM detection (beat-detector.js) consumes A.features.flux + A.features.bass,
// so the two stay decoupled — app-init registers engine.sample BEFORE beat.process.

import { A } from "../vendor/matrix/js/reactive.js";
import { isEmbedded, hostBridge } from "./embed.js";

const FFT_SIZE = 2048; // 1024 freq bins; ~21ms window -> good time resolution for beats (standalone)

// Log-ish band edges in Hz. Tuned for music: isolate kick/sub, then up the spectrum.
const BANDS = [
	["bass", 20, 150],
	["lowMid", 150, 500],
	["mid", 500, 2000],
	["highMid", 2000, 6000],
	["treble", 6000, 16000],
];

// Peak-follower AGC: peak jumps up instantly, decays slowly toward a floor, so the
// normalized value reflects "how loud relative to the recent loudest". Frame-rate
// independent via exp(-dt/tau).
class Follower {
	constructor(tau = 3.0, floor = 1e-4) {
		this.peak = floor;
		this.tau = tau;
		this.floor = floor;
	}
	norm(v, dt) {
		if (v > this.peak) this.peak = v;
		else {
			const k = Math.exp(-dt / this.tau);
			this.peak = this.peak * k + this.floor * (1 - k);
		}
		const p = this.peak > this.floor ? this.peak : this.floor;
		const r = v / p;
		return r < 0 ? 0 : r > 1 ? 1 : r;
	}
}

// Asymmetric envelope: fast attack, slower release -> punchy but not jittery.
function envFollow(prev, target, dt, attack, release) {
	const tau = target > prev ? attack : release;
	const k = 1 - Math.exp(-dt / tau);
	return prev + (target - prev) * k;
}

export const engine = {
	ctx: null,
	analyser: null,
	source: null,
	gain: null,
	attached: false,
	sampleRate: 44100,
	_volume: 0.85,

	mode: "analyser", // 'analyser' (standalone Web Audio) | 'host' (embedded host bridge)
	host: null, // the matrixVizHost bridge, in embedded mode

	freqDb: null, // Float32Array dB spectrum (analyser mode)
	mag: null, // linear magnitude spectrum (both modes)
	prevMag: null, // previous magnitude (for flux)
	timeData: null, // mono time-domain samples (for RMS)
	timeL: null,
	timeR: null, // per-channel time-domain (for stereo balance/width)
	bandBins: [], // [ [name, startBin, endBin], ... ]
	_cfgBins: 0, // bin count the band/spectrum ranges were built for
	_cfgSr: 0, // sample rate they were built for
	_tdN: 0, // valid sample count in timeData (RMS window)
	_lrN: 0, // valid sample count in timeL/timeR (stereo window)

	followers: {},
	smooth: { level: 0, bass: 0, lowMid: 0, mid: 0, highMid: 0, treble: 0, centroid: 0, flux: 0, energy: 0, energySlow: 0, balance: 0, stereoWidth: 0 },

	// ---- standalone: Web Audio graph on the <audio> element ----
	attach(audioEl) {
		if (this.attached) return;
		const Ctx = window.AudioContext || window.webkitAudioContext;
		this.ctx = new Ctx();
		this.sampleRate = this.ctx.sampleRate;

		this.analyser = this.ctx.createAnalyser();
		this.analyser.fftSize = FFT_SIZE;
		this.analyser.smoothingTimeConstant = 0; // we do our own smoothing
		this.analyser.minDecibels = -100;
		this.analyser.maxDecibels = -10;

		this.gain = this.ctx.createGain();
		this.gain.gain.value = this._volume;

		// MediaElementSource can be created only ONCE per element.
		this.source = this.ctx.createMediaElementSource(audioEl);
		this.source.connect(this.analyser);
		this.analyser.connect(this.gain);
		this.gain.connect(this.ctx.destination);
		audioEl.volume = 1; // engine owns volume via gain now

		// Stereo tap: split L/R off the source for balance + width (the main analyser is
		// mono-downmixed). This is the one audio axis Milkdrop-style mono analysis leaves
		// on the table — perfect for side-to-side motion.
		this.splitter = this.ctx.createChannelSplitter(2);
		this.source.connect(this.splitter);
		this.analyserL = this.ctx.createAnalyser();
		this.analyserR = this.ctx.createAnalyser();
		this.analyserL.fftSize = 1024;
		this.analyserR.fftSize = 1024;
		this.splitter.connect(this.analyserL, 0);
		this.splitter.connect(this.analyserR, 1);
		this.timeL = new Float32Array(1024);
		this.timeR = new Float32Array(1024);

		const binCount = this.analyser.frequencyBinCount; // FFT_SIZE/2
		this.freqDb = new Float32Array(binCount);
		this.timeData = new Float32Array(FFT_SIZE);

		this._setupBins(binCount, this.sampleRate);
		this._setupFollowers();
		this.mode = "analyser";
		this._tdN = FFT_SIZE;
		this._lrN = 1024;
		this.attached = true;
	},

	// ---- embedded: pull PCM + FFT from the host bridge (no Web Audio) ----
	attachHost(host) {
		if (this.attached) return;
		this.host = host;
		// Buffers sized for the largest block we expect; the bin layout is (re)configured on
		// the first frame from the block's own bin count + sample rate (host-defined).
		const MAXB = 4096;
		this.timeData = new Float32Array(MAXB);
		this.timeL = new Float32Array(MAXB);
		this.timeR = new Float32Array(MAXB);
		this._setupFollowers();
		this.mode = "host";
		this.attached = true;
	},

	// (re)build the Hz->bin band + spectrum ranges for a given FFT bin count + sample rate.
	// Idempotent; realloc's mag/prevMag only when the bin count changes.
	_setupBins(binCount, sampleRate) {
		this.sampleRate = sampleRate;
		this.nyquist = sampleRate / 2;
		const binWidth = sampleRate / (binCount * 2); // FFT size = binCount*2
		if (!this.mag || this.mag.length !== binCount) {
			this.mag = new Float32Array(binCount);
			this.prevMag = new Float32Array(binCount);
		}
		this.bandBins = BANDS.map(([name, lo, hi]) => [name, Math.max(1, Math.round(lo / binWidth)), Math.min(binCount - 1, Math.round(hi / binWidth))]);

		// log-spaced spectrum bins (for Spectrum Rain: columns mapped to frequencies)
		const SBINS = A.spectrum.length;
		const fMin = 30;
		const fMax = Math.min(16000, sampleRate / 2);
		this.specBinRanges = [];
		for (let j = 0; j < SBINS; j++) {
			const lo = fMin * Math.pow(fMax / fMin, j / SBINS);
			const hi = fMin * Math.pow(fMax / fMin, (j + 1) / SBINS);
			this.specBinRanges.push([Math.max(1, Math.round(lo / binWidth)), Math.min(binCount - 1, Math.round(hi / binWidth))]);
		}
		this._cfgBins = binCount;
		this._cfgSr = sampleRate;
	},

	_setupFollowers() {
		this.followers = {
			level: new Follower(4.0),
			bass: new Follower(3.0),
			lowMid: new Follower(3.0),
			mid: new Follower(3.0),
			highMid: new Follower(3.5),
			treble: new Follower(3.5),
			flux: new Follower(1.5),
		};
		this.specSmooth = new Float32Array(A.spectrum.length);
		this.specPeak = 1e-3;
	},

	ensureRunning() {
		if (this.ctx && this.ctx.state === "suspended") this.ctx.resume();
	},

	setVolume(v) {
		this._volume = v;
		if (this.gain) this.gain.gain.value = v;
	},

	// Fill this.mag (linear) + timeData/timeL/timeR from the Web Audio analysers. Always fresh.
	_acquireAnalyser() {
		const an = this.analyser;
		an.getFloatFrequencyData(this.freqDb);
		an.getFloatTimeDomainData(this.timeData);
		const mag = this.mag,
			db = this.freqDb;
		for (let i = 0; i < mag.length; i++) mag[i] = db[i] <= -100 ? 0 : Math.pow(10, db[i] / 20);
		this.analyserL.getFloatTimeDomainData(this.timeL);
		this.analyserR.getFloatTimeDomainData(this.timeR);
		this._tdN = this.timeData.length;
		this._lrN = this.timeL.length;
		return true;
	},

	// Fill this.mag (mono, linear) + timeData/timeL/timeR from the host's latest block.
	// Returns false if no block is available yet (startup) so the caller decays toward calm.
	_acquireHost() {
		const h = this.host;
		const block = h && h.readAudio && h.readAudio();
		if (!block || !block.fftMag || !block.fftMag.length || !block.fftMag[0]) return false;
		const bins = block.fftMag[0].length;
		const sr = block.sampleRate || this.sampleRate || 44100;
		if (bins !== this._cfgBins || sr !== this._cfgSr) this._setupBins(bins, sr);
		// mono magnitude = mean across the provided channels
		const mag = this.mag,
			ch = block.fftMag,
			nch = ch.length;
		for (let i = 0; i < bins; i++) {
			let s = 0;
			for (let c = 0; c < nch; c++) s += ch[c][i] || 0;
			mag[i] = s / nch;
		}
		// interleaved PCM -> mono timeData + per-channel L/R
		const pcm = block.pcm,
			pch = block.channels || 1;
		const frames = block.frames || (pcm ? Math.floor(pcm.length / pch) : 0);
		const td = this.timeData,
			tl = this.timeL,
			tr = this.timeR;
		const n = Math.min(frames, td.length);
		if (pcm) {
			for (let i = 0; i < n; i++) {
				const b = i * pch;
				const l = pcm[b] || 0;
				const r = pch > 1 ? pcm[b + 1] || 0 : l;
				td[i] = (l + r) * 0.5;
				tl[i] = l;
				tr[i] = r;
			}
		}
		this._tdN = n;
		this._lrN = n;
		return n > 0;
	},

	sample(t, dt) {
		const f = A.features;
		let playing;
		if (this.mode === "host") {
			const st = this.host && this.host.getPlaybackState && this.host.getPlaybackState();
			playing = st ? !!st.playing : true; // no state fn -> assume live (silence reads calm anyway)
		} else {
			playing = !!(this.source && !engine._paused);
		}
		f.playing = playing ? 1 : 0;

		const notReady = !this.attached || (this.mode === "analyser" && (!this.ctx || this.ctx.state !== "running"));
		const acquired = !notReady && (this.mode === "host" ? this._acquireHost() : this._acquireAnalyser());
		if (!acquired) {
			// decay everything toward calm when not analysing
			this._decayAll(dt);
			return;
		}

		// ---- shared analysis (identical for both sources) ----
		// spectral flux: half-wave-rectified magnitude increase vs the previous frame
		const mag = this.mag,
			prev = this.prevMag;
		let flux = 0;
		for (let i = 2; i < mag.length; i++) {
			const d = mag[i] - prev[i];
			if (d > 0) flux += d;
		}
		prev.set(mag);

		// RMS / level from time domain
		const td = this.timeData,
			tdN = this._tdN || td.length;
		let sumSq = 0;
		for (let i = 0; i < tdN; i++) sumSq += td[i] * td[i];
		const rms = Math.sqrt(sumSq / Math.max(1, tdN));
		f.rms = rms;
		const levelN = this.followers.level.norm(rms, dt);

		// bands
		const bandVals = this._bandVals || (this._bandVals = {});
		for (const [name, s, e] of this.bandBins) {
			let acc = 0;
			for (let i = s; i <= e; i++) acc += mag[i] * mag[i];
			const energy = Math.sqrt(acc / Math.max(1, e - s + 1));
			bandVals[name] = this.followers[name].norm(energy, dt);
		}

		// spectral centroid (brightness) -> 0..1 perceptual via log mapping
		let num = 0,
			den = 0;
		const binWidth = this.sampleRate / (mag.length * 2);
		for (let i = 1; i < mag.length; i++) {
			num += i * binWidth * mag[i];
			den += mag[i];
		}
		const centroidHz = den > 1e-6 ? num / den : 0;
		const centroidN = centroidHz > 55 ? Math.min(1, Math.log2(centroidHz / 55) / Math.log2(this.nyquist / 55)) : 0;

		const fluxN = this.followers.flux.norm(flux, dt);

		// stereo balance + width from per-channel time-domain RMS
		const tl = this.timeL,
			tr = this.timeR,
			lrN = this._lrN || tl.length;
		let sL = 0,
			sR = 0,
			sD = 0;
		for (let i = 0; i < lrN; i++) {
			const l = tl[i];
			const r = tr[i];
			sL += l * l;
			sR += r * r;
			const d = l - r;
			sD += d * d;
		}
		const rmsL = Math.sqrt(sL / Math.max(1, lrN));
		const rmsR = Math.sqrt(sR / Math.max(1, lrN));
		const rmsD = Math.sqrt(sD / Math.max(1, lrN));
		const balanceRaw = (rmsR - rmsL) / (rmsR + rmsL + 1e-4); // -1 (L) .. +1 (R)
		const widthRaw = Math.min(1, rmsD / (rmsL + rmsR + 1e-4));

		// smoothing (punchy attack, gentle release)
		const sm = this.smooth;
		sm.level = envFollow(sm.level, levelN, dt, 0.02, 0.15);
		sm.bass = envFollow(sm.bass, bandVals.bass, dt, 0.012, 0.1);
		sm.lowMid = envFollow(sm.lowMid, bandVals.lowMid, dt, 0.02, 0.12);
		sm.mid = envFollow(sm.mid, bandVals.mid, dt, 0.02, 0.12);
		sm.highMid = envFollow(sm.highMid, bandVals.highMid, dt, 0.02, 0.1);
		sm.treble = envFollow(sm.treble, bandVals.treble, dt, 0.015, 0.09);
		sm.centroid = envFollow(sm.centroid, centroidN, dt, 0.06, 0.2);
		sm.flux = envFollow(sm.flux, fluxN, dt, 0.005, 0.08);
		sm.energy = envFollow(sm.energy, levelN, dt, 0.08, 0.4);
		sm.energySlow = envFollow(sm.energySlow, levelN, dt, 1.5, 3.5);
		sm.balance = envFollow(sm.balance, balanceRaw, dt, 0.05, 0.2);
		sm.stereoWidth = envFollow(sm.stereoWidth, widthRaw, dt, 0.05, 0.25);

		// spectrum for Spectrum Rain: per-bin energy, smoothed, normalized by a decaying peak
		{
			const spec = A.spectrum;
			const ranges = this.specBinRanges;
			const ssm = this.specSmooth;
			let specMax = 1e-3;
			for (let j = 0; j < spec.length; j++) {
				const s0 = ranges[j][0];
				const e0 = ranges[j][1];
				let acc = 0;
				for (let i = s0; i <= e0; i++) acc += mag[i] * mag[i];
				const e = Math.sqrt(acc / Math.max(1, e0 - s0 + 1));
				ssm[j] = envFollow(ssm[j], e, dt, 0.02, 0.12);
				if (ssm[j] > specMax) specMax = ssm[j];
			}
			this.specPeak = Math.max(specMax, this.specPeak * Math.exp(-dt / 4));
			const inv = 1 / this.specPeak;
			for (let j = 0; j < spec.length; j++) spec[j] = Math.min(1, ssm[j] * inv);
		}

		f.balance = sm.balance;
		f.stereoWidth = sm.stereoWidth;
		f.level = sm.level;
		f.bass = sm.bass;
		f.lowMid = sm.lowMid;
		f.mid = sm.mid;
		f.highMid = sm.highMid;
		f.treble = sm.treble;
		f.centroid = sm.centroid;
		f.flux = sm.flux;
		f.energy = sm.energy;
		f.energySlow = sm.energySlow;
	},

	_decayAll(dt) {
		const sm = this.smooth;
		const k = 1 - Math.exp(-dt / 0.25);
		for (const key in sm) sm[key] += (0 - sm[key]) * k;
		const f = A.features;
		f.level = sm.level;
		f.bass = sm.bass;
		f.lowMid = sm.lowMid;
		f.mid = sm.mid;
		f.highMid = sm.highMid;
		f.treble = sm.treble;
		f.centroid = sm.centroid;
		f.flux = sm.flux;
		f.energy = sm.energy;
		f.energySlow = sm.energySlow;
		f.balance = sm.balance;
		f.stereoWidth = sm.stereoWidth;
		if (this.specSmooth) {
			for (let j = 0; j < this.specSmooth.length; j++) {
				this.specSmooth[j] *= 1 - k;
				A.spectrum[j] *= 1 - k;
			}
		}
	},
};

export function initEngine(player, MV) {
	// Embedded: analysis is driven by the host bridge; matrix owns no audio graph.
	if (isEmbedded()) {
		engine.attachHost(hostBridge);
		MV.onFrame((t, dt) => engine.sample(t, dt));
		return engine;
	}
	// Standalone: analyse the app's own <audio> element.
	engine.attach(player.audio);
	player.onPlay = () => engine.ensureRunning();
	player.volumeHandler = (v) => engine.setVolume(v);
	// keep paused state in sync for the playing flag
	player.audio.addEventListener("pause", () => (engine._paused = true));
	player.audio.addEventListener("playing", () => (engine._paused = false));
	engine._paused = player.audio.paused;
	// apply current slider volume through the gain now that we own it
	engine.setVolume(player._volume ?? 0.85);
	MV.onFrame((t, dt) => engine.sample(t, dt));
	return engine;
}
