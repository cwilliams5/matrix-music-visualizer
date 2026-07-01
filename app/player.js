// matrix-music-viz — MP3 player + playlist.
// Owns the <audio> element, playlist UI, transport, seek, volume, drag-drop and
// the file picker. Audio analysis is layered on separately (audio-engine.js):
// the player just exposes the element + events; volume routing is delegated via
// `player.volumeHandler` so the engine can take it over with a GainNode.

import { ICONS } from "./icons.js";
import { isEmbedded } from "./embed.js";

const audio = document.getElementById("audio");

const els = {
	playBtn: document.getElementById("play-btn"),
	prevBtn: document.getElementById("prev-btn"),
	nextBtn: document.getElementById("next-btn"),
	seek: document.getElementById("seek"),
	timeCur: document.getElementById("time-cur"),
	timeDur: document.getElementById("time-dur"),
	volume: document.getElementById("volume"),
	title: document.getElementById("track-title"),
	sub: document.getElementById("track-sub"),
	playlist: document.getElementById("playlist"),
	items: document.getElementById("playlist-items"),
	playlistBtn: document.getElementById("playlist-btn"),
	playlistClose: document.getElementById("playlist-close"),
	addFiles: document.getElementById("add-files"),
	fileInput: document.getElementById("file-input"),
	shuffleToggle: document.getElementById("shuffle-toggle"),
	shuffleBtn: document.getElementById("shuffle-btn"),
	repeatBtn: document.getElementById("repeat-btn"),
	volIco: document.getElementById("vol-ico"),
	playlistCount: document.getElementById("playlist-count"),
	dropHint: document.getElementById("drop-hint"),
};

let dragIndex = -1; // playlist reorder: index being dragged (-1 = none / a file drag)
let dragY = 0; // last pointer Y during a reorder drag (drives the edge auto-scroll)
let autoScrollRAF = 0;

// ---- playlist reorder helpers: insertion-line indicator + edge auto-scroll (long lists) ----
// The drop target is computed from the pointer Y vs each row's midpoint (a real insertion point,
// not "drop onto row i"), drawn as a glowing line between rows. Auto-scroll keeps the list moving
// while the pointer is held in the top/bottom edge zone, so a long list stays reorderable.
function insertIndexAt(y) {
	const lis = els.items.querySelectorAll("li");
	for (let i = 0; i < lis.length; i++) {
		const r = lis[i].getBoundingClientRect();
		if (y < r.top + r.height / 2) return i;
	}
	return lis.length; // past the last row
}
function showDropMarker(idx) {
	const lis = els.items.querySelectorAll("li");
	for (const li of lis) li.classList.remove("drop-above", "drop-below");
	if (!lis.length) return;
	if (idx < lis.length) lis[idx].classList.add("drop-above");
	else lis[lis.length - 1].classList.add("drop-below");
}
function clearDropMarkers() {
	for (const li of els.items.querySelectorAll("li.drop-above, li.drop-below")) li.classList.remove("drop-above", "drop-below");
}
function startAutoScroll() {
	if (autoScrollRAF) return;
	const tick = () => {
		if (dragIndex < 0) {
			autoScrollRAF = 0;
			return;
		}
		const cont = els.items;
		const r = cont.getBoundingClientRect();
		const zone = 46; // edge band (px) where auto-scroll kicks in
		const maxV = 16; // max px/frame
		let dv = 0;
		if (dragY > 0) {
			if (dragY < r.top + zone) dv = -maxV * Math.min(1, (r.top + zone - dragY) / zone);
			else if (dragY > r.bottom - zone) dv = maxV * Math.min(1, (dragY - (r.bottom - zone)) / zone);
		}
		if (dv) {
			cont.scrollTop += dv;
			showDropMarker(insertIndexAt(dragY)); // dragover won't fire while the pointer is held still — refresh here
		}
		autoScrollRAF = requestAnimationFrame(tick);
	};
	autoScrollRAF = requestAnimationFrame(tick);
}
function stopAutoScroll() {
	if (autoScrollRAF) cancelAnimationFrame(autoScrollRAF);
	autoScrollRAF = 0;
	dragY = 0;
}

function fmtTime(s) {
	if (!isFinite(s) || s < 0) s = 0;
	const m = Math.floor(s / 60);
	const sec = Math.floor(s % 60);
	return `${m}:${sec.toString().padStart(2, "0")}`;
}

export const player = {
	audio,
	tracks: [],
	index: -1,
	shuffle: false,
	_shuffleBag: [], // true-shuffle bag (indices not yet played this cycle)
	repeat: "none", // "none" | "all" | "one"
	muted: false,
	_lastVol: 0.85,
	seeking: false,
	// Overridable: engine reassigns this to route volume through its GainNode.
	volumeHandler: (v) => {
		audio.volume = v;
	},
	// Event callbacks (set by app-init): onPlay() fires on first user-initiated play
	// (good place to resume the AudioContext), onTrackChange(track,index).
	onPlay: null,
	onTrackChange: null,
	startedOnce: false,

	isPlaying() {
		return !audio.paused && !audio.ended && audio.currentTime > 0;
	},

	load(list) {
		this.tracks = list.slice();
		this._shuffleBag = [];
		renderPlaylist();
	},

	addFiles(fileList) {
		for (const f of fileList) {
			if (!f.type.startsWith("audio") && !/\.(mp3|m4a|ogg|wav|flac|aac)$/i.test(f.name)) continue;
			this.tracks.push({
				src: URL.createObjectURL(f),
				title: f.name.replace(/\.[^.]+$/, ""),
				artist: "local file",
				genre: "dropped",
				_local: true,
			});
		}
		this._shuffleBag = [];
		renderPlaylist();
	},

	playIndex(i) {
		if (i < 0 || i >= this.tracks.length) return;
		this.index = i;
		const t = this.tracks[i];
		audio.src = t.src;
		els.title.textContent = t.title ?? t.src;
		els.sub.textContent = [t.artist, t.genre].filter(Boolean).join("  ·  ");
		renderPlaylist();
		this._kick();
		if (navigator.mediaSession && window.MediaMetadata) {
			navigator.mediaSession.metadata = new MediaMetadata({ title: t.title || "", artist: t.artist || "", album: t.genre || "" });
		}
		if (this.onTrackChange) this.onTrackChange(t, i);
	},

	_kick() {
		const p = audio.play();
		if (p && p.catch) p.catch((e) => console.warn("[player] play blocked:", e.message));
		this._fireFirstPlay();
	},

	_fireFirstPlay() {
		if (!this.startedOnce && this.onPlay) {
			this.startedOnce = true;
			this.onPlay();
		}
	},

	toggle() {
		if (this.index < 0 && this.tracks.length) return this.playIndex(0);
		if (audio.paused) {
			audio.play();
			this._fireFirstPlay();
		} else {
			audio.pause();
		}
	},

	next() {
		if (!this.tracks.length) return;
		let n;
		if (this.shuffle) {
			n = this.tracks.length === 1 ? 0 : this._nextShuffleIndex();
		} else {
			n = (this.index + 1) % this.tracks.length;
		}
		this.playIndex(n);
	},

	// true shuffle bag: every track plays once per cycle (no immediate repeats); reshuffle when empty
	_nextShuffleIndex() {
		if (!this._shuffleBag.length) {
			this._shuffleBag = this.tracks.map((_, i) => i).filter((i) => i !== this.index);
			for (let i = this._shuffleBag.length - 1; i > 0; i--) {
				const j = Math.floor(Math.random() * (i + 1));
				[this._shuffleBag[i], this._shuffleBag[j]] = [this._shuffleBag[j], this._shuffleBag[i]];
			}
		}
		return this._shuffleBag.pop();
	},

	prev() {
		if (!this.tracks.length) return;
		if (audio.currentTime > 3) {
			audio.currentTime = 0;
			return;
		}
		const n = (this.index - 1 + this.tracks.length) % this.tracks.length;
		this.playIndex(n);
	},

	setVolume(v) {
		if (v > 0) this.muted = false;
		this.volumeHandler(v);
		updateMuteIcon();
		savePlayerPrefs();
	},

	toggleMute() {
		if (this.muted) {
			this.muted = false;
			els.volume.value = this._lastVol;
			this.volumeHandler(this._lastVol);
		} else {
			this._lastVol = parseFloat(els.volume.value) || this._lastVol;
			this.muted = true;
			this.volumeHandler(0);
		}
		updateMuteIcon();
		savePlayerPrefs();
	},

	cycleRepeat() {
		this.repeat = this.repeat === "none" ? "all" : this.repeat === "all" ? "one" : "none";
		audio.loop = this.repeat === "one"; // repeat-one loops seamlessly; "ended" won't fire
		updateRepeatBtn();
		savePlayerPrefs();
	},

	setShuffle(on) {
		this.shuffle = on;
		this._shuffleBag = [];
		updateShuffleUI();
		savePlayerPrefs();
	},
};

function renderPlaylist() {
	els.items.innerHTML = "";
	if (els.playlistCount) els.playlistCount.textContent = player.tracks.length ? `${player.tracks.length} track${player.tracks.length === 1 ? "" : "s"}` : "";
	player.tracks.forEach((t, i) => {
		const li = document.createElement("li");
		if (i === player.index) li.classList.add("active");
		li.draggable = true;
		li.addEventListener("dragstart", (e) => {
			dragIndex = i;
			li.classList.add("dragging");
			if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
			startAutoScroll();
		});
		li.addEventListener("dragend", () => {
			dragIndex = -1;
			li.classList.remove("dragging");
			clearDropMarkers();
			stopAutoScroll();
		});
		const name = document.createElement("span");
		name.textContent = `${t.title}${t.artist ? " — " + t.artist : ""}`;
		const genre = document.createElement("span");
		genre.className = "pl-genre";
		genre.textContent = t.genre ?? "";
		li.appendChild(name);
		li.appendChild(genre);
		const rm = document.createElement("button");
		rm.className = "pl-rm";
		rm.textContent = "✕";
		rm.title = "Remove from playlist";
		rm.addEventListener("click", (e) => {
			e.stopPropagation();
			removeTrack(i);
		});
		li.appendChild(rm);
		li.addEventListener("click", () => player.playIndex(i));
		els.items.appendChild(li);
	});
}

// from = dragged row; insertBefore = the insertion-point index (0..length). Removing `from` shifts
// everything after it down one, so the landing slot is insertBefore-1 when dragging downward.
function reorder(from, insertBefore) {
	if (from < 0 || from >= player.tracks.length) return;
	let to = from < insertBefore ? insertBefore - 1 : insertBefore;
	to = Math.max(0, Math.min(to, player.tracks.length - 1));
	if (to === from) return;
	const playing = player.index >= 0 ? player.tracks[player.index] : null;
	player._shuffleBag = [];
	const [moved] = player.tracks.splice(from, 1);
	player.tracks.splice(to, 0, moved);
	if (playing) player.index = player.tracks.indexOf(playing); // identity-track the playing item across the move
	renderPlaylist();
}

function removeTrack(i) {
	if (i < 0 || i >= player.tracks.length) return;
	const wasCurrent = i === player.index;
	player.tracks.splice(i, 1);
	player._shuffleBag = [];
	if (i < player.index) player.index--;
	if (wasCurrent) {
		if (player.tracks.length === 0) {
			player.index = -1;
			audio.pause();
			els.title.textContent = "— no track —";
			els.sub.textContent = "load a track or drop a file";
		} else {
			player.index = Math.min(i, player.tracks.length - 1);
			player.playIndex(player.index); // play the track that slid into this slot
			return; // playIndex re-renders
		}
	}
	renderPlaylist();
}

function updateMuteIcon() {
	if (els.volIco) els.volIco.innerHTML = player.muted || parseFloat(els.volume.value) === 0 ? ICONS.volumeMute : ICONS.volume;
}
function updateRepeatBtn() {
	if (!els.repeatBtn) return;
	els.repeatBtn.innerHTML = player.repeat === "one" ? ICONS.repeatOne : ICONS.repeat;
	els.repeatBtn.classList.toggle("active", player.repeat !== "none"); // accent + dot when on (all/one)
	els.repeatBtn.title = `Repeat: ${player.repeat === "none" ? "off" : player.repeat} (off → all → one)`;
}
function updateShuffleUI() {
	if (els.shuffleBtn) {
		els.shuffleBtn.classList.toggle("active", player.shuffle); // accent + dot when on
		els.shuffleBtn.title = `Shuffle: ${player.shuffle ? "on" : "off"}`;
	}
	if (els.shuffleToggle) els.shuffleToggle.textContent = `shuffle: ${player.shuffle ? "on" : "off"}`;
}

// ---- persisted prefs (volume / mute / shuffle / repeat) — NOT tracks/position (musical state) ----
const PLAYER_LS = "matrixviz.player.v1";
let _saveT = null;
function savePlayerPrefs() {
	if (_saveT) clearTimeout(_saveT);
	_saveT = setTimeout(() => {
		try {
			localStorage.setItem(PLAYER_LS, JSON.stringify({ volume: parseFloat(els.volume.value), muted: player.muted, shuffle: player.shuffle, repeat: player.repeat }));
		} catch (e) {}
	}, 300);
}
function loadPlayerPrefs() {
	let o;
	try {
		o = JSON.parse(localStorage.getItem(PLAYER_LS));
	} catch (e) {}
	if (!o) return;
	if (typeof o.volume === "number") {
		els.volume.value = o.volume;
		player._lastVol = o.volume || 0.85;
	}
	if (typeof o.shuffle === "boolean") player.shuffle = o.shuffle;
	if (o.repeat === "all" || o.repeat === "one" || o.repeat === "none") {
		player.repeat = o.repeat;
		audio.loop = o.repeat === "one";
	}
	if (o.muted) player.muted = true;
	player.volumeHandler(player.muted ? 0 : parseFloat(els.volume.value));
	updateShuffleUI();
	updateRepeatBtn();
	updateMuteIcon();
}
// OS media keys / lockscreen / headset controls -> the same transport paths.
function setupMediaSession() {
	if (!navigator.mediaSession) return;
	const ms = navigator.mediaSession;
	ms.setActionHandler("play", () => player.toggle());
	ms.setActionHandler("pause", () => player.toggle());
	ms.setActionHandler("previoustrack", () => player.prev());
	ms.setActionHandler("nexttrack", () => player.next());
	try {
		ms.setActionHandler("seekto", (d) => {
			if (d.seekTime != null && audio.duration) audio.currentTime = d.seekTime;
		});
	} catch (e) {}
}

function wirePlayerUI() {
	// Inject the static SVG icons (play/pause + repeat + volume are swapped by their update fns).
	els.playlistBtn.innerHTML = ICONS.playlist;
	els.prevBtn.innerHTML = ICONS.prev;
	els.playBtn.innerHTML = ICONS.play;
	els.nextBtn.innerHTML = ICONS.next;
	if (els.shuffleBtn) els.shuffleBtn.innerHTML = ICONS.shuffle;

	els.playBtn.addEventListener("click", () => player.toggle());
	els.prevBtn.addEventListener("click", () => player.prev());
	els.nextBtn.addEventListener("click", () => player.next());

	audio.addEventListener("play", () => {
		els.playBtn.innerHTML = ICONS.pause;
	});
	audio.addEventListener("pause", () => {
		els.playBtn.innerHTML = ICONS.play;
	});
	audio.addEventListener("ended", () => {
		// repeat "one" loops via audio.loop (ended won't fire); "none" stops at the last track
		if (player.repeat === "none" && !player.shuffle && player.index >= player.tracks.length - 1) return;
		player.next();
	});
	audio.addEventListener("playing", () => (player._errStreak = 0));
	audio.addEventListener("error", () => {
		if (!audio.src) return;
		player._errStreak = (player._errStreak || 0) + 1;
		console.warn("[player] load/decode error, skipping:", audio.error && audio.error.message);
		if (player._errStreak > player.tracks.length) return; // all failing — stop to avoid an infinite skip loop
		player.next();
	});

	audio.addEventListener("loadedmetadata", () => {
		els.timeDur.textContent = fmtTime(audio.duration);
	});
	audio.addEventListener("timeupdate", () => {
		if (!player.seeking) {
			els.seek.value = audio.duration ? (audio.currentTime / audio.duration) * 1000 : 0;
		}
		els.timeCur.textContent = fmtTime(audio.currentTime);
	});

	els.seek.addEventListener("input", () => {
		player.seeking = true;
		els.timeCur.textContent = fmtTime((els.seek.value / 1000) * (audio.duration || 0));
	});
	els.seek.addEventListener("change", () => {
		if (audio.duration) audio.currentTime = (els.seek.value / 1000) * audio.duration;
		player.seeking = false;
	});

	els.volume.addEventListener("input", () => player.setVolume(parseFloat(els.volume.value)));
	player.setVolume(parseFloat(els.volume.value));

	// playlist drawer
	els.playlistBtn.addEventListener("click", () => els.playlist.classList.toggle("hidden"));
	els.playlistClose.addEventListener("click", () => els.playlist.classList.add("hidden"));
	els.addFiles.addEventListener("click", () => els.fileInput.click());
	els.fileInput.addEventListener("change", (e) => {
		player.addFiles(e.target.files);
	});

	// playlist reorder — one container-level handler draws the insertion line + tracks the pointer for
	// the edge auto-scroll; drop commits the move. (Per-row handlers only set/clear the drag.)
	els.items.addEventListener("dragover", (e) => {
		if (dragIndex < 0) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
		dragY = e.clientY;
		showDropMarker(insertIndexAt(e.clientY));
	});
	els.items.addEventListener("drop", (e) => {
		if (dragIndex < 0) return;
		e.preventDefault();
		e.stopPropagation(); // don't let the window file-drop catcher fire
		reorder(dragIndex, insertIndexAt(e.clientY));
		clearDropMarkers();
	});
	els.items.addEventListener("dragleave", (e) => {
		if (dragIndex >= 0 && !els.items.contains(e.relatedTarget)) clearDropMarkers(); // left the list, not just crossing rows
	});
	els.shuffleToggle.addEventListener("click", () => player.setShuffle(!player.shuffle));
	els.shuffleBtn?.addEventListener("click", () => player.setShuffle(!player.shuffle));
	els.repeatBtn?.addEventListener("click", () => player.cycleRepeat());
	els.volIco?.addEventListener("click", () => player.toggleMute());
	updateShuffleUI();
	updateRepeatBtn();
	updateMuteIcon();

	// mouse wheel: volume +/-5%, seek +/-5s ({passive:false} so preventDefault stops page scroll)
	els.volume.addEventListener(
		"wheel",
		(e) => {
			e.preventDefault();
			const v = Math.min(1, Math.max(0, parseFloat(els.volume.value) + (e.deltaY < 0 ? 0.05 : -0.05)));
			els.volume.value = v;
			player.setVolume(v);
		},
		{ passive: false }
	);
	els.seek.addEventListener(
		"wheel",
		(e) => {
			e.preventDefault();
			if (audio.duration) audio.currentTime = Math.min(audio.duration, Math.max(0, audio.currentTime + (e.deltaY < 0 ? 5 : -5)));
		},
		{ passive: false }
	);

	// drag and drop anywhere
	let dragDepth = 0;
	window.addEventListener("dragenter", (e) => {
		if (dragIndex >= 0) return; // internal playlist reorder, not a file drop
		e.preventDefault();
		dragDepth++;
		els.dropHint.classList.add("show");
	});
	window.addEventListener("dragover", (e) => e.preventDefault());
	window.addEventListener("dragleave", (e) => {
		dragDepth--;
		if (dragDepth <= 0) els.dropHint.classList.remove("show");
	});
	window.addEventListener("drop", (e) => {
		e.preventDefault();
		dragDepth = 0;
		els.dropHint.classList.remove("show");
		if (e.dataTransfer?.files?.length) {
			const start = player.tracks.length;
			player.addFiles(e.dataTransfer.files);
			if (player.index < 0) player.playIndex(start);
		}
	});

	// player keys (boot/app-init own the viz keys; these don't collide). Guard inputs.
	window.addEventListener("keydown", (e) => {
		if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
		switch (e.key) {
			case " ":
				e.preventDefault();
				player.toggle();
				break;
			case "ArrowLeft":
				if (audio.duration) {
					e.preventDefault();
					audio.currentTime = Math.max(0, audio.currentTime - 5);
				}
				break;
			case "ArrowRight":
				if (audio.duration) {
					e.preventDefault();
					audio.currentTime = Math.min(audio.duration, audio.currentTime + 5);
				}
				break;
			case "ArrowUp": {
				e.preventDefault();
				const v = Math.min(1, parseFloat(els.volume.value) + 0.05);
				els.volume.value = v;
				player.setVolume(v);
				break;
			}
			case "ArrowDown": {
				e.preventDefault();
				const v = Math.max(0, parseFloat(els.volume.value) - 0.05);
				els.volume.value = v;
				player.setVolume(v);
				break;
			}
			case "[":
				player.prev();
				break;
			case "]":
				player.next();
				break;
			case "m":
			case "M":
				player.toggleMute();
				break;
		}
	});

	setupMediaSession();
	loadPlayerPrefs();
}

export async function initPlayer() {
	// Embedded (pure viz): the host owns playback — don't wire transport UI / keys / media
	// session, and don't load the bundled demo playlist. matrix reads audio + now-playing from
	// the host bridge instead (see embed.js). player stays a bare object for MV.player refs.
	if (isEmbedded()) return player;
	wirePlayerUI();
	try {
		const list = await (await fetch("music/playlist.json")).json();
		player.load(list);
	} catch (e) {
		console.warn("[player] no bundled playlist:", e.message);
		els.sub.textContent = "drop an audio file to begin";
	}
	return player;
}
