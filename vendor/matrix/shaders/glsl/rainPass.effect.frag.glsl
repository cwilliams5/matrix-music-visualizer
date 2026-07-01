precision highp float;

// These effects are used to spice up the non-canon versions of the code rain.
// The shader writes them to the channels of a data texture:
// 		R: multiplied effects— magnify the cell's brightness
// 		G: added effects— offset the cell's brightness
// 		B: unused
// 		A: unused

#define SQRT_2 1.4142135623730951
#define SQRT_5 2.23606797749979

uniform sampler2D previousEffectState;
uniform float numColumns, numRows;
uniform float time, tick;
uniform float animationSpeed;

uniform bool hasThunder, loops;
uniform float glyphHeightToWidth;
uniform int rippleType;
uniform float rippleScale, rippleSpeed, rippleThickness;

// MATRIX-VIZ: audio-reactive new physics (beat shockwaves + bass pulse glow)
uniform float uReactive, uBeatPulse, uPulse, uShockPhase, uShockStrength;
uniform vec2 uShockOrigin;

// Helper functions for generating randomness, borrowed from elsewhere

vec2 randomVec2( const in vec2 uv ) {
	return fract(vec2(sin(uv.x * 591.32 + uv.y * 154.077), cos(uv.x * 391.32 + uv.y * 49.077)));
}

float wobble(float x) {
	return x + 0.3 * sin(SQRT_2 * x) + 0.2 * sin(SQRT_5 * x);
}

float getThunder(float simTime, vec2 screenPos) {
	if (!hasThunder) {
		return 0.;
	}

	float thunderTime = simTime * 0.5;
	float thunder = 1. - fract(wobble(thunderTime));
	if (loops) {
		thunder = 1. - fract(thunderTime + 0.3);
	}

	thunder = log(thunder * 1.5) * 4.;
	thunder = clamp(thunder, 0., 1.) * 10. * pow(screenPos.y, 2.);
	return thunder;
}

float getRipple(float simTime, vec2 screenPos) {
	if (rippleType == -1) {
		return 0.;
	}

	float rippleTime = (simTime * 0.5 + sin(simTime) * 0.2) * rippleSpeed + 1.; // TODO: clarify
	if (loops) {
		rippleTime = (simTime * 0.5) * rippleSpeed + 1.;
	}

	vec2 offset = randomVec2(vec2(floor(rippleTime), 0.)) - 0.5;
	if (loops) {
		offset = vec2(0.);
	}
	vec2 ripplePos = screenPos * 2. - 1. + offset;
	float rippleDistance;
	if (rippleType == 0) {
		vec2 boxDistance = abs(ripplePos) * vec2(1., glyphHeightToWidth);
		rippleDistance = max(boxDistance.x, boxDistance.y);
	} else if (rippleType == 1) {
		rippleDistance = length(ripplePos);
	}

	float rippleValue = fract(rippleTime) * rippleScale - rippleDistance;

	if (rippleValue > 0. && rippleValue < rippleThickness) {
		return 0.75;
	}

	return 0.;
}

// MATRIX-VIZ: a single expanding ring of light per beat, radiating from a point.
float getBeatShock(vec2 screenPos) {
	if (uShockStrength <= 0.001) return 0.;
	vec2 d = screenPos - uShockOrigin;
	d.y /= max(glyphHeightToWidth, 0.001);
	float dist = length(d);
	float ring = 1.0 - smoothstep(0.0, 0.07, abs(dist - uShockPhase));
	return ring * uShockStrength;
}

// MATRIX-VIZ: soft radial glow from center that swells on bass/beat.
float getBassGlow(vec2 screenPos) {
	if (uPulse <= 0.001) return 0.;
	float dist = length(screenPos - vec2(0.5));
	return uPulse * (0.55 * exp(-dist * 2.5) + 0.12);
}

// Main function

vec4 computeResult(float simTime, bool isFirstFrame, vec2 glyphPos, vec2 screenPos, vec4 previous) {

	float multipliedEffects = 1. + getThunder(simTime, screenPos);
	float addedEffects = getRipple(simTime, screenPos); // Round or square ripples across the grid

	// MATRIX-VIZ: layer in audio-reactive physics (gated by uReactive + per-channel strength)
	multipliedEffects += uReactive * uPulse * 0.45;
	addedEffects += uReactive * (getBeatShock(screenPos) * 0.9 + getBassGlow(screenPos));

	vec4 result = vec4(multipliedEffects, addedEffects, 0., 0.);
	return result;
}

void main()	{
	float simTime = time * animationSpeed;
	bool isFirstFrame = tick <= 1.;
	vec2 glyphPos = gl_FragCoord.xy;
	vec2 screenPos = glyphPos / vec2(numColumns, numRows);
	vec4 previous = texture2D( previousEffectState, screenPos );
	gl_FragColor = computeResult(simTime, isFirstFrame, glyphPos, screenPos, previous);
}
