// matrix-music-viz — DEV / REFERENCE embedded-host harness (NOT part of the app itself).
//
// Active ONLY when the URL contains ?embed-mock. It installs `window.matrixVizHost` — the exact
// contract a real host (e.g. Resonance) implements (see embed.js) — backed by a demo track's own
// Web Audio analysis, so matrix-music-viz can be exercised in embedded "pure viz" mode without a host.
// It doubles as the reference the Resonance integration plan points at.
//
// A CLASSIC script (no imports) on purpose: it must run BEFORE app/boot.js's ES modules, which is
// when embed.js reads window.matrixVizHost. index.html loads it right before the boot module.
(function () {
	if (typeof location === "undefined" || location.search.indexOf("embed-mock") < 0) return; // standalone unless requested

	const TRACKS = [
		{ src: "music/06-komiku-action-techno.mp3", title: "Action Techno", artist: "Komiku" },
		{ src: "music/07-holiznacc0-night-driving.mp3", title: "Night Driving", artist: "HoliznaCC0" },
		{ src: "music/01-bryan-teoh-starcourt-mall.mp3", title: "Soundtrack From the Starcourt Mall", artist: "Bryan Teoh" },
	];
	let idx = 0;

	const audio = new Audio();
	audio.crossOrigin = "anonymous";
	audio.src = TRACKS[idx].src;

	// Block shape mirrors Resonance's readLatestAudioBlock(): 1024-frame stereo, 512 FFT bins/channel.
	const FRAMES = 1024;
	const BINS = FRAMES / 2;
	let ctx = null,
		anL = null,
		anR = null,
		freqTmp = null,
		magL = null,
		magR = null,
		timeL = null,
		timeR = null,
		pcm = null,
		ready = false,
		gen = 0;

	function ensureGraph() {
		if (ready) return;
		const C = window.AudioContext || window.webkitAudioContext;
		ctx = new C();
		const src = ctx.createMediaElementSource(audio);
		src.connect(ctx.destination); // the "host" plays the audio
		const splitter = ctx.createChannelSplitter(2);
		src.connect(splitter);
		anL = ctx.createAnalyser();
		anR = ctx.createAnalyser();
		anL.fftSize = FRAMES;
		anR.fftSize = FRAMES;
		anL.smoothingTimeConstant = 0;
		anR.smoothingTimeConstant = 0;
		anL.minDecibels = -100;
		anR.minDecibels = -100;
		anL.maxDecibels = -10;
		anR.maxDecibels = -10;
		splitter.connect(anL, 0);
		splitter.connect(anR, 1);
		freqTmp = new Float32Array(BINS);
		magL = new Float32Array(BINS);
		magR = new Float32Array(BINS);
		timeL = new Float32Array(FRAMES);
		timeR = new Float32Array(FRAMES);
		pcm = new Float32Array(FRAMES * 2);
		ready = true;
	}

	const trackCbs = [];
	function fireTrackChange() {
		const np = { title: TRACKS[idx].title, artist: TRACKS[idx].artist };
		for (let i = 0; i < trackCbs.length; i++) {
			try {
				trackCbs[i](np);
			} catch (e) {}
		}
	}

	function toLinear(an, out) {
		an.getFloatFrequencyData(freqTmp);
		for (let i = 0; i < BINS; i++) out[i] = freqTmp[i] <= -100 ? 0 : Math.pow(10, freqTmp[i] / 20);
	}

	// The contract (reused buffers each call — a "latest value" mirror, zero per-frame alloc).
	window.matrixVizHost = {
		readAudio() {
			if (!ready || ctx.state !== "running") return null;
			toLinear(anL, magL);
			toLinear(anR, magR);
			anL.getFloatTimeDomainData(timeL);
			anR.getFloatTimeDomainData(timeR);
			for (let i = 0; i < FRAMES; i++) {
				pcm[i * 2] = timeL[i];
				pcm[i * 2 + 1] = timeR[i];
			}
			gen++;
			return { pcm: pcm, fftMag: [magL, magR], frames: FRAMES, channels: 2, sampleRate: ctx.sampleRate, generation: gen };
		},
		getNowPlaying() {
			return { title: TRACKS[idx].title, artist: TRACKS[idx].artist };
		},
		onTrackChange(cb) {
			trackCbs.push(cb);
			return function () {
				const i = trackCbs.indexOf(cb);
				if (i >= 0) trackCbs.splice(i, 1);
			};
		},
		getPlaybackState() {
			return { playing: ready && !audio.paused, positionMs: audio.currentTime * 1000, durationMs: (audio.duration || 0) * 1000 };
		},

		// --- harness controls (NOT part of the contract; for the demo page / tests) ---
		start() {
			ensureGraph();
			if (ctx.state === "suspended") ctx.resume();
			return audio.play();
		},
		next() {
			idx = (idx + 1) % TRACKS.length;
			audio.src = TRACKS[idx].src;
			const p = audio.play();
			fireTrackChange();
			return p;
		},
	};

	// Real-browser convenience: the first user gesture starts playback (autoplay policy).
	window.addEventListener("click", () => window.matrixVizHost.start(), { once: true });
	console.log("[matrix-music-viz] embed-mock host installed — running in embedded pure-viz mode.");
})();
