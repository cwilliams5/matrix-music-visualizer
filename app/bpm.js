// matrix-music-viz — tempo (BPM) estimator.
// Collects inter-onset intervals from detected beats, then scores candidate tempos
// 60..200 BPM by how well each interval lands on an integer multiple of the beat
// period (so syncopation and missed beats still vote). The /m weighting prefers the
// fundamental over its multiples; a mild prior nudges toward common mid-tempos.

export class BpmEstimator {
	constructor() {
		this.intervals = [];
		this.lastT = null;
		this.bpm = 0;
		this.confidence = 0;
	}

	addBeat(t) {
		if (this.lastT != null) {
			const d = t - this.lastT;
			if (d > 0.25 && d < 2.0) {
				this.intervals.push(d);
				if (this.intervals.length > 48) this.intervals.shift();
				this._estimate();
			}
		}
		this.lastT = t;
	}

	_estimate() {
		const ints = this.intervals;
		if (ints.length < 4) return;
		let best = 0;
		let bestScore = 0;
		for (let bpm = 60; bpm <= 200; bpm++) {
			const P = 60 / bpm;
			let score = 0;
			for (let i = 0; i < ints.length; i++) {
				const d = ints[i];
				const m = Math.round(d / P);
				if (m < 1 || m > 4) continue;
				const err = Math.abs(d - m * P) / P;
				score += (Math.exp(-(err * err) / (2 * 0.04)) / m) * (1 + (ints.length - i) * 0.01); // recency bias
			}
			score *= 1 + 0.3 * Math.exp(-Math.pow((bpm - 120) / 60, 2)); // gentle mid-tempo prior
			if (score > bestScore) {
				bestScore = score;
				best = bpm;
			}
		}
		this.confidence = Math.min(1, bestScore / ints.length);
		if (this.bpm === 0) this.bpm = best;
		else if (Math.abs(best - this.bpm) > 18) this.bpm = best; // tempo change -> jump
		else this.bpm += (best - this.bpm) * 0.2; // else smooth
	}
}
