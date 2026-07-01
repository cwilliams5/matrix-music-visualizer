// matrix-music-viz — unified fullscreen / immersive mode.
//
// ONE mode, two entry points: the `F` key (boot.js) and a double-click bound to the STAGE only (here);
// the right-click "Fullscreen" item is the third. All target document.documentElement, so it is a
// single coherent mode (rain + UI), not the old split (F = whole page, double-click = canvas-only).
//
// While fullscreen, the chrome auto-hides for an immersive view:
//  - on enter, the chrome (sidebar + now-playing bar + hamburger + debug overlay) is shown;
//  - ANY mouse movement reveals it and (re)arms a ~3s idle timer;
//  - while the pointer is over the chrome it never hides (you're using it);
//  - over the stage, after ~3s of stillness the chrome AND the mouse cursor hide — so at rest the only
//    thing left is the FPS counter (if it's on).
// The FPS HUD is EXEMPT from the auto-hide and remembers its own fullscreen on/off (default OFF — it is
// never force-enabled for someone who's never turned it on; but if you enable it in fullscreen it
// returns next time). The `?` cheat-sheet is independent and can be summoned at any time.

const IDLE_MS = 3000;
const FPS_PREF_KEY = "matrixviz.fullscreenFps.v1"; // remembered FPS-HUD state for fullscreen (separate from windowed)
const CHROME_SEL = "#panel-toggle, #player, #playlist, #panel:not(.collapsed)"; // "is the pointer over the chrome?"

export function initFullscreen() {
	const stage = document.getElementById("stage");
	const fpsHud = document.getElementById("fps-hud");
	const body = document.body;
	let hideTimer = 0;
	let windowedFpsHidden = true; // FPS-HUD state captured on enter, restored on exit (keeps windowed independent)

	const readFpsPref = () => {
		try {
			return localStorage.getItem(FPS_PREF_KEY) === "1";
		} catch (e) {
			return false;
		}
	};
	const writeFpsPref = (on) => {
		try {
			localStorage.setItem(FPS_PREF_KEY, on ? "1" : "0");
		} catch (e) {}
	};

	const showChrome = () => body.classList.remove("chrome-hidden");
	const hideChrome = () => body.classList.add("chrome-hidden");
	const armIdle = (overChrome) => {
		clearTimeout(hideTimer);
		if (!overChrome) hideTimer = setTimeout(hideChrome, IDLE_MS);
	};

	// Double-click the STAGE (the rain) toggles fullscreen. The panel/player/playlist are a separate DOM
	// subtree, so their double-clicks never reach #stage — fixing the old window-level handler that fired
	// while you were clicking around the controls. (That vendored handler was removed in regl/main.js.)
	stage?.addEventListener("dblclick", () => {
		if (document.fullscreenElement) document.exitFullscreen?.();
		else document.documentElement.requestFullscreen?.();
	});

	// Reveal on movement; re-arm the idle-hide unless the pointer is over the chrome.
	window.addEventListener("mousemove", (e) => {
		if (!document.fullscreenElement) return; // auto-hide is a fullscreen-only behavior
		showChrome();
		const overChrome = !!(e.target.closest && e.target.closest(CHROME_SEL));
		armIdle(overChrome);
	});

	document.addEventListener("fullscreenchange", () => {
		if (document.fullscreenElement) {
			windowedFpsHidden = !fpsHud || fpsHud.classList.contains("hidden");
			if (fpsHud) fpsHud.classList.toggle("hidden", !readFpsPref()); // remembered fullscreen FPS (default off)
			showChrome();
			armIdle(false); // begin the idle countdown
		} else {
			clearTimeout(hideTimer);
			showChrome();
			if (fpsHud) fpsHud.classList.toggle("hidden", windowedFpsHidden); // restore the windowed FPS state
		}
	});

	// boot.js owns the ` keypress (it flips #fps-hud.hidden) and registers its keydown FIRST, so by the
	// time this fires the class is already flipped — persist it as the fullscreen FPS preference.
	window.addEventListener("keydown", (e) => {
		if (e.key !== "`" || !document.fullscreenElement || !fpsHud) return;
		if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
		writeFpsPref(!fpsHud.classList.contains("hidden"));
	});
}
