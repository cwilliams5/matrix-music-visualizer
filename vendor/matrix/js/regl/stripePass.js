import colorToRGB from "../colorToRGB.js";
import { loadText, make1DTexture, makePassFBO, makePass } from "./utils.js";

// Multiplies the rendered rain and bloom by a 1D gradient texture
// generated from the passed-in color sequence

// This shader introduces noise into the renders, to avoid banding

// MATRIX-VIZ: the "trans"/"transPride" flag palette was removed. "spectrum" (was "pride")
// is now a smooth full-spectrum sweep (red -> violet) — 32 HSL stops that make1DTexture's
// linear filtering renders as a continuous rainbow.
const spectrumStripeColors = Array.from({ length: 32 }, (_, i) => ({
	space: "hsl",
	values: [(i / 31) * 0.82, 1.0, 0.55],
}));

// MATRIX-VIZ: the generic banded default for the "stripes" effect (was the pride-flag
// array, renamed — no longer surfaced as a named flag). Distinct from the smooth spectrum.
const stripesDefaultColors = [
	{ space: "rgb", values: [0.89, 0.01, 0.01] },
	{ space: "rgb", values: [1.0, 0.55, 0.0] },
	{ space: "rgb", values: [1.0, 0.93, 0.0] },
	{ space: "rgb", values: [0.0, 0.5, 0.15] },
	{ space: "rgb", values: [0.0, 0.3, 1.0] },
	{ space: "rgb", values: [0.46, 0.03, 0.53] },
]
	.map((color) => Array(2).fill(color))
	.flat();

export default ({ regl, config }, inputs) => {
	const output = makePassFBO(regl, config.useHalfFloat);

	const { backgroundColor, cursorColor, glintColor, cursorIntensity, glintIntensity, ditherMagnitude } = config;

	// Expand and convert stripe colors into 1D texture data
	// MATRIX-VIZ: "spectrum" -> full spectrum; everything else (incl. "stripes") -> banded default.
	const stripeColors = "stripeColors" in config ? config.stripeColors : config.effect === "spectrum" ? spectrumStripeColors : stripesDefaultColors;
	const stripeTex = make1DTexture(
		regl,
		stripeColors.map((color) => [...colorToRGB(color), 1])
	);

	const stripePassFrag = loadText("shaders/glsl/stripePass.frag.glsl");

	const render = regl({
		frag: regl.prop("frag"),

		uniforms: {
			backgroundColor: colorToRGB(backgroundColor),
			cursorColor: colorToRGB(cursorColor),
			glintColor: colorToRGB(glintColor),
			cursorIntensity,
			glintIntensity,
			ditherMagnitude,
			tex: inputs.primary,
			bloomTex: inputs.bloom,
			stripeTex,
		},
		framebuffer: output,
	});

	return makePass(
		{
			primary: output,
		},
		stripePassFrag.loaded,
		(w, h) => output.resize(w, h),
		(shouldRender) => {
			if (shouldRender) {
				render({ frag: stripePassFrag.text() });
			}
		}
	);
};
