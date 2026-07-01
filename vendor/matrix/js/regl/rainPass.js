import { loadImage, loadText, makePassFBO, makeDoubleBuffer, makePass } from "./utils.js";
import { A } from "../reactive.js"; // MATRIX-VIZ: reactive knob bridge

const extractEntries = (src, keys) => Object.fromEntries(Array.from(Object.entries(src)).filter(([key]) => keys.includes(key)));

const rippleTypes = {
	box: 0,
	circle: 1,
};

// These compute buffers are used to compute the properties of cells in the grid.
// They take turns being the source and destination of a "compute" shader.
// The half float data type is crucial! It lets us store almost any real number,
// whereas the default type limits us to integers between 0 and 255.

// These double buffers are smaller than the screen, because their pixels correspond
// with cells in the grid, and the cells' glyphs are much larger than a pixel.
const makeComputeDoubleBuffer = (regl, height, width, seed) =>
	makeDoubleBuffer(regl, {
		width,
		height,
		wrapT: "clamp",
		type: "half float",
		data: seed ? seed(width, height) : Array(width * height * 4).fill(0)
	});

const numVerticesPerQuad = 2 * 3;
const tlVert = [0, 0];
const trVert = [0, 1];
const blVert = [1, 0];
const brVert = [1, 1];
const quadVertices = [tlVert, trVert, brVert, tlVert, brVert, blVert];

export default ({ regl, config, lkg, spectrumTex, titleMaskTex }) => {
	const { mat2, mat4, vec2, vec3 } = glMatrix;

	// The volumetric mode multiplies the number of columns
	// to reach the desired density, and then overlaps them
	const volumetric = config.volumetric;
	const density = volumetric && config.effect !== "none" ? config.density : 1;
	// MATRIX-VIZ: overscan the volumetric grid so the reactive camera can pan/strafe/tilt
	// without revealing the field's edges (the empty void above/beside the rain). The grid
	// grows AND the vertex positions scale by the same factor (see rainPass.vert), so
	// on-screen density + glyph size are unchanged — there's just extra rain in the margins.
	const overscan = volumetric ? 1.6 : 1.0;
	const [numRows, numColumns] = [Math.ceil(config.numColumns * overscan), Math.floor(config.numColumns * density * overscan)];

	// The volumetric mode requires us to create a grid of quads,
	// rather than a single quad for our geometry
	const [numQuadRows, numQuadColumns] = volumetric ? [numRows, numColumns] : [1, 1];
	const numQuads = numQuadRows * numQuadColumns;
	const quadSize = [1 / numQuadColumns, 1 / numQuadRows];

	// Various effect-related values
	const rippleType = config.rippleTypeName in rippleTypes ? rippleTypes[config.rippleTypeName] : -1;
	const slantVec = [Math.cos(config.slant), Math.sin(config.slant)];
	const slantScale = 1 / (Math.abs(Math.sin(2 * config.slant)) * (Math.sqrt(2) - 1) + 1);
	const showDebugView = config.effect === "none";

	const glyphTransform = mat2.fromScaling(mat2.create(), vec2.fromValues(config.glyphFlip ? -1 : 1, 1));
	mat2.rotate(glyphTransform, glyphTransform, (config.glyphRotation * Math.PI) / 180);

	const commonUniforms = {
		...extractEntries(config, ["glyphHeightToWidth", "glyphSequenceLength", "glyphTextureGridSize"]),
		animationSpeed: () => A.knobs.animationSpeed ?? config.animationSpeed, // MATRIX-VIZ reactive
		numColumns,
		numRows,
		showDebugView,
	};

	const introDoubleBuffer = makeComputeDoubleBuffer(regl, 1, numColumns);
	const rainPassIntro = loadText("shaders/glsl/rainPass.intro.frag.glsl");
	const introUniforms = {
		...commonUniforms,
		...extractEntries(config, ["skipIntro"]),
		fallSpeed: () => A.knobs.fallSpeed ?? config.fallSpeed, // MATRIX-VIZ reactive
	};
	const intro = regl({
		frag: regl.prop("frag"),
		uniforms: {
			...introUniforms,
			previousIntroState: introDoubleBuffer.back,
		},

		framebuffer: introDoubleBuffer.front,
	});

	const raindropDoubleBuffer = makeComputeDoubleBuffer(regl, numRows, numColumns);
	const rainPassRaindrop = loadText("shaders/glsl/rainPass.raindrop.frag.glsl");
	const raindropUniforms = {
		...commonUniforms,
		...extractEntries(config, ["loops", "skipIntro"]),
		brightnessDecay: () => A.knobs.brightnessDecay ?? config.brightnessDecay, // MATRIX-VIZ reactive
		fallSpeed: () => A.knobs.fallSpeed ?? config.fallSpeed, // MATRIX-VIZ reactive
		raindropLength: () => A.knobs.raindropLength ?? config.raindropLength, // MATRIX-VIZ reactive
	};
	const raindrop = regl({
		frag: regl.prop("frag"),
		uniforms: {
			...raindropUniforms,
			introState: introDoubleBuffer.front,
			previousRaindropState: raindropDoubleBuffer.back,
			uSpectrum: spectrumTex, // MATRIX-VIZ: 1D FFT spectrum for Spectrum Rain
			// MATRIX-VIZ (plan-transitions): Glyph "Drop" title — burn into the sim, then fall as rain.
			uTitleMask: titleMaskTex,
			uTitleDrop: () => A.title.drop,
			uTitleReleaseT: () => A.title.releaseT,
			uTitleReleasePhase: () => A.title.releasePhase,
			uTitleHoldLevel: () => A.title.holdLevel,
			uTitleGHTW: config.glyphHeightToWidth || 1, // grid-row -> on-screen-Y scale (e.g. operator 1.35)
		},

		framebuffer: raindropDoubleBuffer.front,
	});

	// MATRIX-VIZ: seed the symbol buffer with random glyphs + ages so a freshly REBUILT pipeline
	// starts populated instead of showing glyph 0 ('*') until it slowly cycles in. Upstream relied
	// on the symbol shader's `tick <= 1` first-frame reset, but our single persistent context keeps
	// `tick` incrementing across mode-switch rebuilds, so that reset never fires after a switch.
	// (First page load still hits the shader reset too — same random distribution, no regression.)
	const symbolDoubleBuffer = makeComputeDoubleBuffer(regl, numRows, numColumns, (w, h) => {
		const glyphs = config.glyphSequenceLength || 1;
		const data = new Array(w * h * 4);
		for (let i = 0; i < data.length; i += 4) {
			data[i] = Math.floor(Math.random() * glyphs); // R: symbol
			data[i + 1] = Math.random(); // G: age
			data[i + 2] = 0;
			data[i + 3] = 0;
		}
		return data;
	});
	const rainPassSymbol = loadText("shaders/glsl/rainPass.symbol.frag.glsl");
	const symbolUniforms = {
		...commonUniforms,
		...extractEntries(config, ["cycleFrameSkip", "loops"]),
		cycleSpeed: () => A.knobs.cycleSpeed ?? config.cycleSpeed, // MATRIX-VIZ reactive
	};
	const symbol = regl({
		frag: regl.prop("frag"),
		uniforms: {
			...symbolUniforms,
			raindropState: raindropDoubleBuffer.front,
			previousSymbolState: symbolDoubleBuffer.back,
		},

		framebuffer: symbolDoubleBuffer.front,
	});

	const effectDoubleBuffer = makeComputeDoubleBuffer(regl, numRows, numColumns);
	const rainPassEffect = loadText("shaders/glsl/rainPass.effect.frag.glsl");
	const effectUniforms = {
		...commonUniforms,
		...extractEntries(config, ["hasThunder", "rippleScale", "rippleSpeed", "rippleThickness", "loops"]),
		rippleType,
	};
	const effect = regl({
		frag: regl.prop("frag"),
		uniforms: {
			...effectUniforms,
			raindropState: raindropDoubleBuffer.front,
			previousEffectState: effectDoubleBuffer.back,
		},

		framebuffer: effectDoubleBuffer.front,
	});

	const quadPositions = Array(numQuadRows)
		.fill()
		.map((_, y) =>
			Array(numQuadColumns)
				.fill()
				.map((_, x) => Array(numVerticesPerQuad).fill([x, y]))
		);

	// We render the code into an FBO using MSDFs: https://github.com/Chlumsky/msdfgen
	const glyphMSDF = loadImage(regl, config.glyphMSDFURL);
	const glintMSDF = loadImage(regl, config.glintMSDFURL);
	const baseTexture = loadImage(regl, config.baseTextureURL, true);
	const glintTexture = loadImage(regl, config.glintTextureURL, true);
	const rainPassVert = loadText("shaders/glsl/rainPass.vert.glsl");
	const rainPassFrag = loadText("shaders/glsl/rainPass.frag.glsl");
	const output = makePassFBO(regl, config.useHalfFloat);
	const renderUniforms = {
		...commonUniforms,
		...extractEntries(config, [
			// vertex
			"forwardSpeed",
			"glyphVerticalSpacing",
			// fragment
			"glintBrightness",
			"glintContrast",
			"hasBaseTexture",
			"hasGlintTexture",
			"brightnessThreshold",
			"brightnessOverride",
			"isolateCursor",
			"isolateGlint",
			"glyphEdgeCrop",
			"isPolar",
		]),
		baseBrightness: () => A.knobs.baseBrightness ?? config.baseBrightness, // MATRIX-VIZ reactive
		baseContrast: () => A.knobs.baseContrast ?? config.baseContrast, // MATRIX-VIZ reactive
		glyphTransform,
		density,
		numQuadColumns,
		numQuadRows,
		quadSize,
		slantScale,
		slantVec,
		volumetric,
		overscan, // MATRIX-VIZ
	};
	const render = regl({
		blend: {
			enable: true,
			func: {
				src: "one",
				dst: "one",
			},
		},
		vert: regl.prop("vert"),
		frag: regl.prop("frag"),

		uniforms: {
			...renderUniforms,

			raindropState: raindropDoubleBuffer.front,
			symbolState: symbolDoubleBuffer.front,
			effectState: effectDoubleBuffer.front,
			glyphMSDF: glyphMSDF.texture,
			glintMSDF: glintMSDF.texture,
			baseTexture: baseTexture.texture,
			glintTexture: glintTexture.texture,

			msdfPxRange: 4.0,
			glyphMSDFSize: () => [glyphMSDF.width(), glyphMSDF.height()],
			glintMSDFSize: () => [glintMSDF.width(), glintMSDF.height()],

			// MATRIX-VIZ (plan-transitions): the Glyph song-title mask + its envelope amount. Boosts the
			// brightness of glyphs inside the title shape (sampled at vUV — screen space in 2D, field space
			// in 3D), burning the title into the rain. uTitleAmount = 0 outside a title (no-op).
			uTitleMask: titleMaskTex,
			uTitleAmount: () => A.title.amount,
			uResolution: () => [output.width || 1, output.height || 1], // render-target size for screen-space title sampling

			camera: regl.prop("camera"),
			transform: regl.prop("transform"),
			screenSize: regl.prop("screenSize"),
		},

		viewport: regl.prop("viewport"),

		attributes: {
			aPosition: quadPositions,
			aCorner: Array(numQuads).fill(quadVertices),
		},
		count: numQuads * numVerticesPerQuad,

		framebuffer: output,
	});

	// Camera and transform math for the volumetric mode
	const screenSize = [1, 1];
	const transform = mat4.create();
	if (volumetric && config.isometric) {
		mat4.rotateX(transform, transform, (Math.PI * 1) / 8);
		mat4.rotateY(transform, transform, (Math.PI * 1) / 4);
		mat4.translate(transform, transform, vec3.fromValues(0, 0, -1));
		mat4.scale(transform, transform, vec3.fromValues(1, 1, 2));
	} else if (lkg.enabled) {
		mat4.translate(transform, transform, vec3.fromValues(0, 0, -1.1));
		mat4.scale(transform, transform, vec3.fromValues(1, 1, 1));
		mat4.scale(transform, transform, vec3.fromValues(0.15, 0.15, 0.15));
	} else {
		mat4.translate(transform, transform, vec3.fromValues(0, 0, -1));
	}
	const camera = mat4.create();
	const baseTransform = mat4.clone(transform); // MATRIX-VIZ: preserved base for the camera ride
	const camVec = vec3.create(); // MATRIX-VIZ: reused translate scratch (avoid a per-frame vec3 alloc)
	// MATRIX-VIZ: reused draw-call prop objects so the per-frame execute loop doesn't allocate a
	// fresh options object per pass each frame. regl reads these synchronously at draw time (it
	// doesn't retain them); transform/screenSize/camera are already reused references, so this is
	// the standard regl batching pattern — no behavior change.
	const passProps = { frag: null };
	const clearProps = { depth: 1, color: [0, 0, 0, 1], framebuffer: output };
	const renderProps = { camera: null, viewport: null, transform, screenSize, vert: null, frag: null };

	const vantagePoints = [];

	return makePass(
		{
			primary: output,
		},
		Promise.all([
			glyphMSDF.loaded,
			glintMSDF.loaded,
			baseTexture.loaded,
			glintTexture.loaded,
			rainPassIntro.loaded,
			rainPassRaindrop.loaded,
			rainPassSymbol.loaded,
			rainPassVert.loaded,
			rainPassFrag.loaded,
		]),
		(w, h) => {
			output.resize(w, h);
			const aspectRatio = w / h;

			const [numTileColumns, numTileRows] = [lkg.tileX, lkg.tileY];
			const numVantagePoints = numTileRows * numTileColumns;
			const tileWidth = Math.floor(w / numTileColumns);
			const tileHeight = Math.floor(h / numTileRows);
			vantagePoints.length = 0;
			for (let row = 0; row < numTileRows; row++) {
				for (let column = 0; column < numTileColumns; column++) {
					const index = column + row * numTileColumns;
					const camera = mat4.create();

					if (volumetric && config.isometric) {
						if (aspectRatio > 1) {
							mat4.ortho(camera, -1.5 * aspectRatio, 1.5 * aspectRatio, -1.5, 1.5, -1000, 1000);
						} else {
							mat4.ortho(camera, -1.5, 1.5, -1.5 / aspectRatio, 1.5 / aspectRatio, -1000, 1000);
						}
					} else if (lkg.enabled) {
						mat4.perspective(camera, (Math.PI / 180) * lkg.fov, lkg.quiltAspect, 0.0001, 1000);

						const distanceToTarget = -1; // TODO: Get from somewhere else
						let vantagePointAngle = (Math.PI / 180) * lkg.viewCone * (index / (numVantagePoints - 1) - 0.5);
						if (isNaN(vantagePointAngle)) {
							vantagePointAngle = 0;
						}
						const xOffset = distanceToTarget * Math.tan(vantagePointAngle);

						mat4.translate(camera, camera, vec3.fromValues(xOffset, 0, 0));

						camera[8] = -xOffset / (distanceToTarget * Math.tan((Math.PI / 180) * 0.5 * lkg.fov) * lkg.quiltAspect); // Is this right??
					} else {
						mat4.perspective(camera, (Math.PI / 180) * 90, aspectRatio, 0.0001, 1000);
					}

					const viewport = {
						x: column * tileWidth,
						y: row * tileHeight,
						width: tileWidth,
						height: tileHeight,
					};
					vantagePoints.push({ camera, viewport });
				}
			}
			[screenSize[0], screenSize[1]] = aspectRatio > 1 ? [1, aspectRatio] : [1 / aspectRatio, 1];
		},
		(shouldRender) => {
			// MATRIX-VIZ: reuse passProps across the four compute passes (set frag, draw, repeat) —
			// regl reads it synchronously, so one object replaces four per-frame literals.
			passProps.frag = rainPassIntro.text();
			intro(passProps);
			passProps.frag = rainPassRaindrop.text();
			raindrop(passProps);
			passProps.frag = rainPassSymbol.text();
			symbol(passProps);
			passProps.frag = rainPassEffect.text();
			effect(passProps);

			if (shouldRender) {
				regl.clear(clearProps); // MATRIX-VIZ: hoisted (was a fresh object + [0,0,0,1] each frame)

				// MATRIX-VIZ: audio-reactive camera SHAKE + ROLL for plain volumetric modes.
				// Copy the preserved base transform and add only small x/y shake + z-roll. The
				// "dive speed" reacts via the animationSpeed knob (see deep-space preset) instead
				// of a z-dolly, which previously pushed the glyph field behind the near plane and
				// produced a black screen.
				if (volumetric && !config.isometric && !lkg.enabled) {
					mat4.copy(transform, baseTransform);
					if (A.reactive) {
						const cs = A.shader;
						const tx = (cs.cameraStrafe || 0) + (cs.cameraShakeX || 0); // side-to-side
						const ty = (cs.cameraBoom || 0) + (cs.cameraShakeY || 0); // up/down
						const tz = Math.min(0, cs.cameraDolly || 0); // backward only (forward clips near plane)
						vec3.set(camVec, tx, ty, tz);
						mat4.translate(transform, transform, camVec);
						if (cs.cameraPitch) mat4.rotateX(transform, transform, cs.cameraPitch); // tilt
						if (cs.cameraYaw) mat4.rotateY(transform, transform, cs.cameraYaw); // pan
						if (cs.cameraRoll) mat4.rotateZ(transform, transform, cs.cameraRoll); // roll
					}
				}

				// MATRIX-VIZ: reuse renderProps (transform/screenSize are the same mutated refs the old
				// spread passed; only camera/viewport vary per vantage point — 1 in non-holoplay).
				renderProps.vert = rainPassVert.text();
				renderProps.frag = rainPassFrag.text();
				for (const vantagePoint of vantagePoints) {
					renderProps.camera = vantagePoint.camera;
					renderProps.viewport = vantagePoint.viewport;
					render(renderProps);
				}
			}
		}
	);
};
