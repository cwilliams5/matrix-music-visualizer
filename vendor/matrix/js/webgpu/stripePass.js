import colorToRGB from "../colorToRGB.js";
import { structs } from "../../lib/gpu-buffer.js";
import { loadShader, make1DTexture, makeUniformBuffer, makeBindGroup, makeComputeTarget, makePass } from "./utils.js";

// Multiplies the rendered rain and bloom by a 1D gradient texture
// generated from the passed-in color sequence

// This shader introduces noise into the renders, to avoid banding

// MATRIX-VIZ: "trans"/"transPride" flag palette removed; "spectrum" (was "pride") is a
// smooth full-spectrum sweep (red -> violet) — 32 HSL stops linear-filtered into a rainbow.
const spectrumStripeColors = Array.from({ length: 32 }, (_, i) => ({
	space: "hsl",
	values: [(i / 31) * 0.82, 1.0, 0.55],
}));

// MATRIX-VIZ: generic banded default for "stripes" (was the pride-flag array, renamed).
const stripesDefaultColors = [
	{ space: "rgb", values: [0.89, 0.01, 0.01] },
	{ space: "rgb", values: [1.0, 0.55, 0.0] },
	{ space: "rgb", values: [1.0, 0.93, 0.0] },
	{ space: "rgb", values: [0.0, 0.5, 0.15] },
	{ space: "rgb", values: [0.0, 0.3, 1.0] },
	{ space: "rgb", values: [0.46, 0.03, 0.53] },
]
	.map((color) => Array(2).fill(color))
	.flat(1);

const numVerticesPerQuad = 2 * 3;

// The rendered texture's values are mapped to colors in a palette texture.
// A little noise is introduced, to hide the banding that appears
// in subtle gradients. The noise is also time-driven, so its grain
// won't persist across subsequent frames. This is a safe trick
// in screen space.

export default ({ config, device, timeBuffer }) => {
	// Expand and convert stripe colors into 1D texture data
	// MATRIX-VIZ: "spectrum" -> full spectrum; everything else (incl. "stripes") -> banded default.
	const stripeColors = "stripeColors" in config ? config.stripeColors : config.effect === "spectrum" ? spectrumStripeColors : stripesDefaultColors;
	const stripeTex = make1DTexture(
		device,
		stripeColors.map((color) => [...colorToRGB(color), 1])
	);

	const linearSampler = device.createSampler({
		magFilter: "linear",
		minFilter: "linear",
	});

	let computePipeline;
	let configBuffer;
	let tex;
	let bloomTex;
	let output;
	let screenSize;

	const assets = [loadShader(device, "shaders/wgsl/stripePass.wgsl")];

	const loaded = (async () => {
		const [stripeShader] = await Promise.all(assets);

		computePipeline = await device.createComputePipelineAsync({
			layout: "auto",
			compute: {
				module: stripeShader.module,
				entryPoint: "computeMain",
			},
		});

		const configUniforms = structs.from(stripeShader.code).Config;
		configBuffer = makeUniformBuffer(device, configUniforms, {
			ditherMagnitude: config.ditherMagnitude,
			backgroundColor: colorToRGB(config.backgroundColor),
			cursorColor: colorToRGB(config.cursorColor),
			glintColor: colorToRGB(config.glintColor),
			cursorIntensity: config.cursorIntensity,
			glintIntensity: config.glintIntensity,
		});
	})();

	const build = (size, inputs) => {
		output?.destroy();
		output = makeComputeTarget(device, size);
		screenSize = size;

		tex = inputs.primary;
		bloomTex = inputs.bloom;

		return {
			primary: output,
		};
	};

	const run = (encoder, shouldRender) => {
		if (!shouldRender) {
			return;
		}

		const computePass = encoder.beginComputePass();
		computePass.setPipeline(computePipeline);
		const computeBindGroup = makeBindGroup(device, computePipeline, 0, [
			configBuffer,
			timeBuffer,
			linearSampler,
			tex.createView(),
			bloomTex.createView(),
			stripeTex.createView(),
			output.createView(),
		]);
		computePass.setBindGroup(0, computeBindGroup);
		computePass.dispatchWorkgroups(Math.ceil(screenSize[0] / 32), screenSize[1], 1);
		computePass.end();
	};

	return makePass("Stripe", loaded, build, run);
};
