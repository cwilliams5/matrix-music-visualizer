precision mediump float;
#define PI 3.14159265359

uniform sampler2D tex;
uniform sampler2D bloomTex;
uniform sampler2D paletteTex;
uniform float ditherMagnitude;
uniform float time;
uniform vec3 backgroundColor, cursorColor, glintColor;
uniform float cursorIntensity, glintIntensity;
// MATRIX-VIZ: spectral color rotation + bass zoom warp + wind sway + shockwave warp
uniform float uReactive, uHueShift, uColorBleed, uBass, uBassWarp;
uniform float uWindSway, uPulseWarp, uShockPhase, uShockStrength;
uniform vec2 uShockOrigin;
varying vec2 vUV;

vec3 hueRotate(vec3 color, float angle) {
	const vec3 k = vec3(0.57735026919);
	float c = cos(angle), s = sin(angle);
	return color * c + cross(k, color) * s + k * dot(k, color) * (1.0 - c);
}

highp float rand( const in vec2 uv, const in float t ) {
	const highp float a = 12.9898, b = 78.233, c = 43758.5453;
	highp float dt = dot( uv.xy, vec2( a,b ) ), sn = mod( dt, PI );
	return fract(sin(sn) * c + t);
}

vec4 getBrightness(vec2 uv) {
	vec4 primary = texture2D(tex, uv);
	vec4 bloom = texture2D(bloomTex, uv);
	return primary + bloom;
}

void main() {
	// MATRIX-VIZ: subtle bass zoom-warp around screen center
	vec2 uv = vUV;
	if (uReactive > 0.5 && uBassWarp > 0.001) {
		uv = (uv - 0.5) * (1.0 - uBassWarp * 0.12) + 0.5;
	}
	// MATRIX-VIZ: 2D wind sway — vertical sine displaces columns horizontally
	if (uReactive > 0.5 && uWindSway > 0.001) {
		uv.x += sin(uv.y * 7.0 + time * 1.3) * uWindSway * 0.025;
	}
	// MATRIX-VIZ: pulse-wave warp — the expanding beat shockwave physically ripples the rain
	if (uReactive > 0.5 && uPulseWarp > 0.001 && uShockStrength > 0.001) {
		vec2 sd = uv - uShockOrigin;
		float sdist = length(sd);
		float ringDist = sdist - uShockPhase;
		float disp = exp(-ringDist * ringDist * 80.0) * uShockStrength * uPulseWarp * 0.05;
		uv += (sdist > 0.0001 ? sd / sdist : vec2(0.0)) * disp;
	}

	vec4 brightness = getBrightness(uv);

	// Dither: subtract a random value from the brightness
	brightness -= rand( gl_FragCoord.xy, time ) * ditherMagnitude / 3.0;

	// Map the brightness to a position in the palette texture
	vec3 color = texture2D( paletteTex, vec2(brightness.r, 0.0)).rgb
		+ min(cursorColor * cursorIntensity * brightness.g, vec3(1.0))
		+ min(glintColor * glintIntensity * brightness.b, vec3(1.0))
		+ backgroundColor;

	// MATRIX-VIZ: spectral hue rotation + chroma bleed
	if (uReactive > 0.5) {
		if (abs(uHueShift) > 0.001) color = hueRotate(color, uHueShift * 6.2831853);
		if (uColorBleed > 0.001) {
			float l = dot(color, vec3(0.299, 0.587, 0.114));
			color = mix(vec3(l), color, 1.0 + uColorBleed * 1.5);
		}
	}

	gl_FragColor = vec4(color, 1.0);
}
