// matrix-music-viz — player transport icons.
// Vendored from Lucide (https://lucide.dev), ISC-licensed — icon path data only, inlined so the
// icons inherit the UI theme via `currentColor` (no external request, no build step). Outline icons
// use stroke=currentColor; the primary/transport icons (play/pause/prev/next) are filled for weight.
// 24x24 viewBox. Replaces the old colour-emoji glyphs (🔀🔁🔊…) that ignored the theme.

const stroked = (inner) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const filled = (inner) => `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">${inner}</svg>`;

export const ICONS = {
	// mode toggles (outline) — shuffle / repeat-all / repeat-one
	shuffle: stroked('<path d="M2 18h1.4c1.3 0 2.5-.6 3.3-1.7l6.1-8.6c.7-1.1 2-1.7 3.3-1.7H22"/><path d="m18 2 4 4-4 4"/><path d="M2 6h1.9c1.5 0 2.9.9 3.6 2.2"/><path d="M22 18h-5.9c-1.3 0-2.6-.7-3.3-1.8l-.5-.8"/><path d="m18 14 4 4-4 4"/>'),
	repeat: stroked('<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>'),
	repeatOne: stroked('<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/><path d="M11 10h1v4"/>'),
	// transport (filled, for weight) — prev / play / pause / next
	prev: filled('<polygon points="19 20 9 12 19 4"/><rect x="4.6" y="4" width="2.6" height="16" rx="1"/>'),
	next: filled('<polygon points="5 4 15 12 5 20"/><rect x="16.8" y="4" width="2.6" height="16" rx="1"/>'),
	play: filled('<polygon points="6 3 20 12 6 21"/>'),
	pause: filled('<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>'),
	// volume (outline) — high / muted
	volume: stroked('<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>'),
	volumeMute: stroked('<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="22" x2="16" y1="9" y2="15"/><line x1="16" x2="22" y1="9" y2="15"/>'),
	// playlist drawer (outline)
	playlist: stroked('<path d="M21 15V6"/><path d="M18.5 18a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z"/><path d="M12 12H3"/><path d="M16 6H3"/><path d="M12 18H3"/>'),
};
