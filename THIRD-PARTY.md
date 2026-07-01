# Third-party components & licenses

Matrix Music Visualizer's own source (everything under `app/` and `examples/`,
plus `index.html` and `serve.py`) is MIT-licensed — see [`LICENSE`](LICENSE). It
bundles the following third-party components:

## Rezmason/matrix — MIT

The digital-rain renderer under `vendor/matrix/` is a **vendored, modified** copy
of [Rezmason/matrix](https://github.com/Rezmason/matrix) (MIT). The full upstream
license is preserved verbatim at [`vendor/matrix/LICENSE`](vendor/matrix/LICENSE).
Our modifications (turning the renderer audio-reactive and embeddable) are
catalogued in [`MODIFICATIONS.md`](MODIFICATIONS.md) and marked in-source with
`// MATRIX-VIZ` comments. This includes the glyph **MSDF font atlases** shipped
under `vendor/matrix/assets/`, which are part of the Rezmason/matrix project.

## regl — MIT

`vendor/matrix/lib/regl.min.js` is [regl](https://github.com/regl-project/regl),
a WebGL wrapper (MIT), included as part of the vendored Rezmason/matrix tree.

## Demo music — CC0 1.0 (public domain)

The tracks in `music/` are released under **Creative Commons Zero 1.0** (a
public-domain dedication) by their composers:

- **Kevin MacLeod** — *Blippy Trance*, *Alien Spaceship Atmosphere*, *Bass Meant Jazz*
- **Alexander Nakarada** — *Blood Eagle*
- **Bryan Teoh** — *Soundtrack From the Starcourt Mall*
- **Komiku** — *Action Techno*
- **HoliznaCC0** — *Night Driving*

Sourced from FreePD.com and the Free Music Archive (via the preserved
[SoundSafari/CC0-1.0-Music](https://github.com/SoundSafari/CC0-1.0-Music) mirror).
Per-track provenance is in [`music/CREDITS.md`](music/CREDITS.md). CC0 requires no
attribution; these credits are provided as a courtesy.
