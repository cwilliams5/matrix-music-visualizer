# Reference embedded host

`embed-mock.js` is a **reference implementation of the host bridge** that Matrix
Music Visualizer's embedded adapter consumes (`window.matrixVizHost`). It backs
the contract with a demo track's own Web Audio analysis, so you can run the
visualizer in embedded **pure-visualizer** mode without a real host — and it's the
template to follow when wiring the viz into an actual music player.

## Try it

Serve the repo and open the standalone page with the `?embed-mock` flag:

```bash
python serve.py           # from the repo root
# then open:
# http://localhost:8099/?embed-mock
```

Click once to start audio. In embedded mode the visualizer:

- takes audio from `host.readAudio()` (raw PCM + FFT) and runs its own analysis on it,
- shows the now-playing title (from `host.getNowPlaying()` / `host.onTrackChange()`),
- **hides its own transport bar + playlist** and unbinds the playback shortcuts —
  the host owns playback.

Without `?embed-mock` the same page runs standalone (its own player + Web Audio),
and this file is never loaded.

## The contract

`embed-mock.js` implements exactly the interface documented at the top of
[`../app/embed.js`](../app/embed.js) — a pull-based `readAudio()` plus
`getNowPlaying()` / `onTrackChange()` and an optional `getPlaybackState()`. See the
**Embedding** section of the top-level [`../README.md`](../README.md) for the full
shape and how a real host maps onto it.
