# Bundled demo music — licensing

Every track shipped in this folder is released under **Creative Commons Zero
(CC0 1.0 Universal)** — a public-domain dedication. CC0 waives all copyright and
related rights, so these files may be used, modified, and redistributed for any
purpose (including commercial) with **no attribution required**.

CC0 is compatible with this project's MIT license (it is, if anything, *more*
permissive than MIT — MIT still requires preserving its copyright notice, CC0
requires nothing). The credits below are provided as a courtesy and to record
provenance, not out of legal obligation.

## Sources

- Tracks 1–5 come from the **FreePD.com** public-domain (CC0) catalog. FreePD.com
  shut down in 2026 after 17 years.
- Tracks 6–7 come from **CC0 artists on the Free Music Archive** — Komiku and
  HoliznaCC0, both of whom release their entire catalogs under CC0.

All files were retrieved from the preserved mirror
**[SoundSafari/CC0-1.0-Music](https://github.com/SoundSafari/CC0-1.0-Music)**
(`freepd.com/` and `freemusicarchive.org/` folders). CC0 is irrevocable, so these
remain public domain regardless of any original site's status.

## Tracks

| # | Title | Composer | Reactive character |
|---|-------|----------|--------------------|
| 1 | Soundtrack From the Starcourt Mall | Bryan Teoh | synthwave — steady retro beat, analog bass |
| 2 | Blippy Trance | Kevin MacLeod | electronic trance — four-on-the-floor |
| 3 | Blood Eagle | Alexander Nakarada | cinematic epic — huge crescendos |
| 4 | Alien Spaceship Atmosphere | Kevin MacLeod | dark ambient — slow pads, few beats |
| 5 | Bass Meant Jazz | Kevin MacLeod | jazz — walking bass, brushed drums + brass |
| 6 | Action Techno | Komiku | chiptune techno — 8-bit arcade, driving beat |
| 7 | Night Driving | HoliznaCC0 | darksynth — cyberpunk night-drive, pulsing bass |

The set is deliberately diverse across the audio-reactive axes the visualizer
keys on (steady beats, transients, dynamic range, bass weight) — tracks 1, 2, 6
and 7 are the beat-heavy references (synthwave / trance / chiptune-techno /
darksynth); track 3 exercises dynamics/crescendos; track 4 is the calm/ambient
end; track 5 drives onset/transient response. Seven tracks span five composers.

## Adding your own

`playlist.json` is a plain manifest — `{ src, title, artist, genre }` per entry.
Drop a file in this folder and add a row. To stay shippable, keep bundled tracks
CC0 (or public domain). Users can always drag-and-drop their own files at runtime;
those never ship.
