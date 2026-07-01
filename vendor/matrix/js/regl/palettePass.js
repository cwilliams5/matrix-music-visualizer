import colorToRGB from "../colorToRGB.js";
import { loadText, make1DTexture, makePassFBO, makePass } from "./utils.js";
import { A } from "../reactive.js"; // MATRIX-VIZ: reactive knob bridge

// Maps the brightness of the rendered rain and bloom to colors
// in a 1D gradient palette texture generated from the passed-in color sequence

// This shader introduces noise into the renders, to avoid banding

export const PALETTE_SIZE = 2048;

// Convert an HSL/RGB gradient (entries = [{color, at}]) into a flat array of `size` RGB triples
// (0..1), capping the ends and interpolating between stops. Shared by makePalette (-> a texture)
// and bakePaletteRGBA (-> a Uint8 buffer the transition morph uploads in place).
const bakePaletteColors = (entries, size) => {
	const paletteColors = Array(size);
	const sortedEntries = entries
		.slice()
		.sort((e1, e2) => e1.at - e2.at)
		.map((entry) => ({
			rgb: colorToRGB(entry.color),
			arrayIndex: Math.floor(Math.max(Math.min(1, entry.at), 0) * (size - 1)),
		}));
	sortedEntries.unshift({ rgb: sortedEntries[0].rgb, arrayIndex: 0 });
	sortedEntries.push({ rgb: sortedEntries[sortedEntries.length - 1].rgb, arrayIndex: size - 1 });
	sortedEntries.forEach((entry, index) => {
		paletteColors[entry.arrayIndex] = entry.rgb.slice();
		if (index + 1 < sortedEntries.length) {
			const nextEntry = sortedEntries[index + 1];
			const diff = nextEntry.arrayIndex - entry.arrayIndex;
			for (let i = 0; i < diff; i++) {
				const ratio = i / diff;
				paletteColors[entry.arrayIndex + i] = [entry.rgb[0] * (1 - ratio) + nextEntry.rgb[0] * ratio, entry.rgb[1] * (1 - ratio) + nextEntry.rgb[1] * ratio, entry.rgb[2] * (1 - ratio) + nextEntry.rgb[2] * ratio];
			}
		}
	});
	for (let i = 0; i < size; i++) if (!paletteColors[i]) paletteColors[i] = [0, 0, 0];
	return paletteColors;
};

const makePalette = (regl, entries) => make1DTexture(regl, bakePaletteColors(entries, PALETTE_SIZE).map((rgb) => [...rgb, 1]));

// MATRIX-VIZ (plan-transitions): bake a palette to a flat RGBA Uint8 buffer (the same gradient the
// pass would texture), for the in-place gradient morph. The transition lerps two of these per frame.
export function bakePaletteRGBA(entries, size = PALETTE_SIZE) {
	const cols = bakePaletteColors(entries, size);
	const out = new Uint8Array(size * 4);
	for (let i = 0; i < size; i++) {
		const c = cols[i];
		out[i * 4] = Math.floor(c[0] * 255);
		out[i * 4 + 1] = Math.floor(c[1] * 255);
		out[i * 4 + 2] = Math.floor(c[2] * 255);
		out[i * 4 + 3] = 255;
	}
	return out;
}

// The rendered texture's values are mapped to colors in a palette texture.
// A little noise is introduced, to hide the banding that appears
// in subtle gradients. The noise is also time-driven, so its grain
// won't persist across subsequent frames. This is a safe trick
// in screen space.

export default ({ regl, config }, inputs) => {
	const output = makePassFBO(regl, config.useHalfFloat);
	const paletteTex = makePalette(regl, config.palette);
	const { backgroundColor, cursorColor, glintColor, cursorIntensity, glintIntensity, ditherMagnitude } = config;

	const palettePassFrag = loadText("shaders/glsl/palettePass.frag.glsl");

	const render = regl({
		frag: regl.prop("frag"),

		uniforms: {
			backgroundColor: colorToRGB(backgroundColor),
			cursorColor: colorToRGB(cursorColor),
			glintColor: colorToRGB(glintColor),
			cursorIntensity: () => A.knobs.cursorIntensity ?? config.cursorIntensity, // MATRIX-VIZ reactive
			glintIntensity: () => A.knobs.glintIntensity ?? config.glintIntensity, // MATRIX-VIZ reactive
			hueShift: () => A.shader.hueShift, // MATRIX-VIZ: palette hue rotation (shader-side)
			colorBleed: () => A.shader.colorBleed, // MATRIX-VIZ: band-driven chroma bleed
			ditherMagnitude,
			tex: inputs.primary,
			bloomTex: inputs.bloom,
			paletteTex,
		},
		framebuffer: output,
	});

	// MATRIX-VIZ (plan-transitions): track the last uploaded morph generation so we only re-upload
	// the gradient when it actually changed (the morph bumps gen each frame; otherwise no upload).
	let lastMorphGen = -1;

	return makePass(
		{
			primary: output,
		},
		palettePassFrag.loaded,
		(w, h) => output.resize(w, h),
		(shouldRender) => {
			if (shouldRender) {
				// MATRIX-VIZ: a same-mode ramp->ramp palette morph re-colors THIS pass's gradient in place
				// each frame (A.paletteMorph holds the blended PALETTE_SIZE-wide RGBA buffer + a gen counter).
				const pm = A.paletteMorph;
				if (pm && pm.active && pm.gen !== lastMorphGen) {
					lastMorphGen = pm.gen;
					paletteTex({ width: pm.size, height: 1, format: "rgba", mag: "linear", min: "linear", data: pm.data });
				}
				render({ frag: palettePassFrag.text() });
			}
		}
	);
};
