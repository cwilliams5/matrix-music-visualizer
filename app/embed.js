// matrix-music-viz — embedded adapter.
//
// matrix-music-viz runs STANDALONE by default: its own <audio> player + Web Audio analysis.
// When a HOST APP embeds it, the host installs `window.matrixVizHost` BEFORE the app boots.
// Its presence flips matrix-music-viz into PURE-VISUALIZER mode:
//   - audio comes from host.readAudio() (PCM + FFT) instead of a MediaElementSource,
//   - now-playing (title/artist + track-change) comes from the host,
//   - the host OWNS PLAYBACK: matrix's transport bar + playlist are hidden and the
//     playback keys/shortcuts are not bound (the host's transport drives everything).
//
// The contract a host implements (a plain, app-agnostic object on window) — PULL-based,
// so matrix-music-viz keeps its own frame loop and just reads the freshest audio each frame:
//
//   window.matrixVizHost = {
//     // AUDIO — the latest output block. matrix runs its OWN analysis (bands/beat/stereo/
//     // spectrum) on this, so reactivity is identical standalone vs embedded.
//     readAudio(): {
//       pcm: Float32Array,        // interleaved, frames*channels
//       fftMag: Float32Array[],   // per-channel linear magnitude spectra (blockSize/2 each)
//       frames, channels, sampleRate, generation
//     } | null,
//     // NOW-PLAYING — feeds the glyph song-title splash + director track-change switch.
//     getNowPlaying(): { title: string, artist?: string } | null,
//     onTrackChange(cb): () => void,             // returns an unsubscribe fn
//     // OPTIONAL — for the "playing" flag / readouts. matrix does NOT drive transport here.
//     getPlaybackState?(): { playing: boolean, positionMs?, durationMs? },
//   }
//
// matrix-music-viz declares back (the host may read this — e.g. to hide its own now-playing bar):
//   window.matrixViz.capabilities = { ownsPlayback: <true standalone, false embedded> }

const HOST = (typeof window !== "undefined" && window.matrixVizHost) || null;

export function isEmbedded() {
	return !!HOST;
}
export function host() {
	return HOST;
}

// The embedding-contract version matrix-music-viz implements. A host may read this (and declare its own
// `window.matrixVizHost.version`) so the API can evolve without silently breaking consumers.
export const CONTRACT_VERSION = 1;

// Defensive facade over the raw host bridge. A misbehaving host (a method that throws, or is
// missing) must degrade the viz to CALM, not spam the console every frame — so each call is
// wrapped to return null on throw and warn exactly ONCE per method. Consumers (audio-engine,
// app-init) use `hostBridge`; they never touch window.matrixVizHost directly.
const _warned = {};
function guarded(name, fn) {
	try {
		return fn();
	} catch (e) {
		if (!_warned[name]) {
			_warned[name] = true;
			console.warn(`[matrix-music-viz] host.${name}() threw — degrading gracefully (further errors suppressed):`, e);
		}
		return null;
	}
}

export const hostBridge = HOST
	? {
			readAudio: () => guarded("readAudio", () => (HOST.readAudio ? HOST.readAudio() : null)),
			getNowPlaying: () => guarded("getNowPlaying", () => (HOST.getNowPlaying ? HOST.getNowPlaying() : null)),
			getPlaybackState: () => guarded("getPlaybackState", () => (HOST.getPlaybackState ? HOST.getPlaybackState() : null)),
			onTrackChange: (cb) => {
				if (!HOST.onTrackChange) return () => {};
				const unsub = guarded("onTrackChange", () => HOST.onTrackChange(cb));
				return typeof unsub === "function" ? unsub : () => {};
			},
		}
	: null;

if (typeof window !== "undefined") {
	// The declaration a host reads: the contract version + that (when embedded) matrix does NOT own playback.
	window.matrixViz = window.matrixViz || {};
	window.matrixViz.capabilities = Object.assign({}, window.matrixViz.capabilities, { version: CONTRACT_VERSION, ownsPlayback: !HOST });
	// Tag the document so CSS hides the player chrome before first paint.
	if (document.documentElement) document.documentElement.classList.toggle("matrixviz-embedded", !!HOST);
}
