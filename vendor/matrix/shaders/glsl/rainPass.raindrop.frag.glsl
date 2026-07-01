precision highp float;

// This shader is the star of the show.
// It writes falling rain to the channels of a data texture:
// 		R: raindrop brightness
// 		G: whether the cell is a "cursor"
// 		B: whether the cell is "activated" — to animate the intro
// 		A: unused

// Listen.
// I understand if this shader looks confusing. Please don't be discouraged!
// It's just a handful of sine and fract functions. Try commenting parts out to learn
// how the different steps combine to produce the result. And feel free to reach out. -RM

#define PI 3.14159265359
#define SQRT_2 1.4142135623730951
#define SQRT_5 2.23606797749979

uniform sampler2D previousRaindropState, introState;
uniform float numColumns, numRows;
uniform float time, tick;
uniform float animationSpeed, fallSpeed;
uniform float uFallPhase; // MATRIX-VIZ: integrated fall phase (continuous under reactive speed changes)
uniform sampler2D uSpectrum; // MATRIX-VIZ: 1D FFT spectrum (Spectrum Rain)
uniform float uSpectrumAmount; // MATRIX-VIZ: 0 = off
uniform float uSpawnAmount, uBeatClock, uBeatSeed; // MATRIX-VIZ: beat-spawned drops
// MATRIX-VIZ (plan-transitions): Glyph "Hold and Rain" / "Fall" titles — burn a title into the SIM,
// then let it fall as rain. N concurrent SLOTS so a new title STACKS (never clobbers the in-flight one);
// each slot's mask is a horizontal band of the atlas (TITLE_N stacked). Per slot: drop 0=off/1=hold-and-
// rain/2=fall, releaseT (< 0 = hold; else seconds since release / the fall-through scroll offset),
// releasePhase (uFallPhase at release, so the fall matches the rain), holdLevel (quick form-in).
#define TITLE_N 8
uniform sampler2D uTitleMask;
uniform float uTitleDrop[TITLE_N];
uniform float uTitleReleaseT[TITLE_N];
uniform float uTitleReleasePhase[TITLE_N];
uniform float uTitleHoldLevel[TITLE_N];
uniform float uTitleGHTW; // grid-row -> on-screen-Y scale (glyphHeightToWidth; e.g. operator 1.35)

uniform bool loops, skipIntro;
uniform float brightnessDecay;
uniform float raindropLength;

// Helper functions for generating randomness, borrowed from elsewhere

highp float randomFloat( const in vec2 uv ) {
	const highp float a = 12.9898, b = 78.233, c = 43758.5453;
	highp float dt = dot( uv.xy, vec2( a,b ) ), sn = mod( dt, PI );
	return fract(sin(sn) * c);
}

vec2 randomVec2( const in vec2 uv ) {
	return fract(vec2(sin(uv.x * 591.32 + uv.y * 154.077), cos(uv.x * 391.32 + uv.y * 49.077)));
}

float wobble(float x) {
	return x + 0.3 * sin(SQRT_2 * x) + 0.2 * sin(SQRT_5 * x);
}

// This is the code rain's key underlying concept.
// It's why glyphs that share a column are lit simultaneously, and are brighter toward the bottom.
// It's also why those bright areas are truncated into raindrops.
float getRainBrightness(float simTime, vec2 glyphPos) {
	float columnTimeOffset = randomFloat(vec2(glyphPos.x, 0.)) * 1000.;
	float columnSpeedOffset = randomFloat(vec2(glyphPos.x + 0.1, 0.)) * 0.5 + 0.5;
	if (loops) {
		columnSpeedOffset = 0.5;
	}
	// MATRIX-VIZ: was `simTime * fallSpeed` — multiplying absolute time by a reactive speed
	// made the whole field jump (backward when speed dipped) and fill the screen. uFallPhase
	// is the integral of fallSpeed*animationSpeed over time, so motion is always smooth + forward.
	float columnTime = columnTimeOffset + uFallPhase * columnSpeedOffset;
	float rainTime = (glyphPos.y * 0.01 + columnTime) / raindropLength;
	if (!loops) {
		rainTime = wobble(rainTime);
	}
	return 1.0 - fract(rainTime);
}

// Main function

vec4 computeResult(float simTime, bool isFirstFrame, vec2 glyphPos, vec4 previous, vec4 intro) {
	float brightness = getRainBrightness(simTime, glyphPos);
	float brightnessBelow = getRainBrightness(simTime, glyphPos + vec2(0., -1.));

	float introProgress = intro.r - (1. - glyphPos.y / numRows);
	float introProgressBelow = intro.r - (1. - (glyphPos.y - 1.) / numRows);

	bool activated = bool(previous.b) || skipIntro || introProgress > 0.;
	bool activatedBelow = skipIntro || introProgressBelow > 0.;

	bool cursor = brightness > brightnessBelow || (activated && !activatedBelow);

	// Blend the glyph's brightness with its previous brightness, so it winks on and off organically
	if (!isFirstFrame) {
		float previousBrightness = previous.r;
		brightness = mix(previousBrightness, brightness, brightnessDecay);
	}

	// MATRIX-VIZ: Spectrum Rain — modulate each column by its frequency bin's energy
	// (left columns = bass, right = treble). Turns the rain into a frequency display.
	if (uSpectrumAmount > 0.001) {
		float spec = texture2D(uSpectrum, vec2((glyphPos.x + 0.5) / numColumns, 0.5)).r;
		// floor keeps faint rain everywhere; loud frequencies bloom bright on top
		brightness *= mix(1.0, 0.3 + spec * 3.0, uSpectrumAmount);
	}

	// MATRIX-VIZ: beat-spawned drops — on each beat fresh heads fall from the top in random
	// columns (a different set each beat via the beat-counter seed), with a short trail.
	if (uSpawnAmount > 0.001) {
		float colR = randomFloat(vec2(glyphPos.x + 0.5, floor(uBeatSeed)));
		if (colR < uSpawnAmount * 0.5) {
			float headY = (1.0 - uBeatClock * 1.3) * numRows; // top -> bottom over ~0.77s
			float above = glyphPos.y - headY; // >0 = the trail it fell through
			float head = exp(-above * above * 0.5);
			float trail = above > 0.0 ? exp(-above * 0.2) * 0.35 : 0.0;
			float life = max(0.0, 1.0 - uBeatClock * 0.85);
			brightness = max(brightness, (head + trail) * life);
		}
	}

	// MATRIX-VIZ (plan-transitions): the Glyph "Drop" title — inject the title into the rain SIM. During
	// hold, the masked cells are forced LIT (binary → pixel-font; the glyphs keep cycling, only the lit
	// STATE is held). On release the lit cells FALL exactly like the rain: sample the mask shifted up by
	// how far the rain has fallen since release (the uFallPhase delta × the column's own speed — the same
	// 100/numRows-per-phase rate a rain drop moves), and fade to nothing, so they become indistinguishable
	// rain. max() so the title sits on top of the rain without erasing it.
	{
		float colX = (glyphPos.x + 0.5) / numColumns;
		// on-screen Y of this grid row: the render scales the grid vertically by glyphHeightToWidth
		// (e.g. operator 1.35), so multiply here to keep the title screen-centered + screen-aligned.
		float displayY = ((glyphPos.y + 0.5) / numRows) * uTitleGHTW; // 0 = bottom, 1 = top
		float colSpeed = randomFloat(vec2(glyphPos.x + 0.1, 0.)) * 0.5 + 0.5; // the same per-column speed the rain uses
		for (int i = 0; i < TITLE_N; i++) {
			if (uTitleDrop[i] > 0.5) { // uniform branch (per-slot) — texture2D inside is WebGL1-safe
				float rt = uTitleReleaseT[i];
				float localV;
				float contrib;
				if (uTitleDrop[i] > 1.5) {
					// fall-through (rigid, uniform speed): the scroll offset is rt; exact shape preserved.
					localV = 1.0 - (displayY + rt);
					contrib = 1.0;
				} else if (rt < 0.0) {
					// hold: lit in place (glyphs keep cycling), with a quick form-in
					localV = 1.0 - displayY;
					contrib = uTitleHoldLevel[i];
				} else {
					// fall as rain: scroll up by how far the rain fell since release (per-column), fade in
					float fallen = (uFallPhase - uTitleReleasePhase[i]) * (100.0 / numRows) * colSpeed * uTitleGHTW;
					localV = 1.0 - (displayY + fallen);
					contrib = clamp(1.0 - rt * 0.7, 0.0, 1.0);
				}
				float inRange = step(0.0, localV) * step(localV, 1.0);
				float atlasV = (float(i) + clamp(localV, 0.0, 1.0)) / float(TITLE_N); // this slot's band of the atlas
				float m = step(0.5, texture2D(uTitleMask, vec2(colX, atlasV)).r);
				brightness = max(brightness, m * contrib * inRange);
			}
		}
	}

	vec4 result = vec4(brightness, cursor, activated, introProgress);
	return result;
}

void main()	{
	float simTime = time * animationSpeed;
	bool isFirstFrame = tick <= 1.;
	vec2 glyphPos = gl_FragCoord.xy;
	vec2 screenPos = glyphPos / vec2(numColumns, numRows);
	vec4 previous = texture2D( previousRaindropState, screenPos );
	vec4 intro = texture2D( introState, vec2(screenPos.x, 0.) );
	gl_FragColor = computeResult(simTime, isFirstFrame, glyphPos, previous, intro);
}
