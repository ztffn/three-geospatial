// wave-kernels.ts — Portable WGSL value-kernels for the WaterPro IFFT wave
// simulation. The originals in resources/shader/IFFT/*.js take storage buffers
// as ptr<storage,...> FUNCTION PARAMETERS — an extension Chrome's Tint permits
// but core WGSL forbids and Firefox's Naga rejects ("pointer of space Storage
// can't be passed into functions"), which killed the whole wave sim on
// Firefox. Every kernel here is a pure by-value function (values in, one value
// out; only legal texture handles as resource params); the storage element
// loads/stores live in the TSL wrapper Fns in wave-cascade.ts /
// wave-simulation.ts, so the generated module accesses buffers at module
// scope — plain core WGSL. Math is verbatim from the originals (same
// Tessendorf/JONSWAP port); Chrome output is bit-identical.

import { code, wgslFn } from 'three/tsl'

// Complex multiply, shared by the time-evolution and IFFT kernels (the
// originals duplicated it per shader as multiplyComplex/complexMult — one
// definition here since several kernels can land in the same module).
const complexMult = code(/* wgsl */ `
	fn complexMult(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
		return vec2<f32>(a.x * b.x - a.y * b.y, a.y * b.x + a.x * b.y);
	}
`)

// ── Butterfly (FFT twiddle/permutation table) ───────────────────────────────
// One vec4 per (stage, row). The original wrote to
// idx = u32(posY) * u32(logN) + u32(posX), but posX/posY are derived from the
// 1D index by (mod, div) logN, so idx == index — the wrapper stores the return
// value at instanceIndex.
export const butterflyValueWGSL = wgslFn(/* wgsl */ `
    fn butterflyValue(index: u32, N: f32) -> vec4<f32> {

        var logN = log2(N);
        var posX = f32(index) % logN;
        var posY = floor(f32(index) / logN);

        const PI: f32 = 3.1415926;

        var k: f32 = (posY * N/pow(2, posX + 1)) % N;
        var twiddle: vec2<f32> = vec2<f32>(cos(2 * PI * k / N), sin(2 * PI * k / N));

        var butterflyspan = pow(2, f32(posX));
        var butterflywing: i32 = select(0, 1, posY % pow(2, posX + 1) < pow(2, posX));
        var uY = u32(posY);

        var result: vec4<f32>;
        if(u32(posX) == 0){
            if(butterflywing == 1){
                result = vec4f( twiddle, reverseBits(uY, N), reverseBits(uY + 1, N) );
            }
            else{
                result = vec4f( twiddle, reverseBits(uY - 1, N), reverseBits(uY, N) );
            }
        }
        else{
            if(butterflywing == 1){
                result = vec4f( twiddle, posY, posY + butterflyspan);
            }
            else{
                result = vec4f( twiddle, posY - butterflyspan, posY);
            }
        }
        return result;
    }

    fn reverseBits(index: u32, N: f32) -> f32 {
        var bitReversedIndex: u32 = 0;
        var numBits: u32 = u32(log2(N));

        for (var i: u32 = 0; i < numBits; i = i + 1) {
            bitReversedIndex = bitReversedIndex | (((index >> i) & 1) << (numBits - i - 1));
        }
        return f32(bitReversedIndex);
    }
`)

// ── Initial spectrum (JONSWAP/TMA + directional spread) ─────────────────────
// Helpers shared by the spectrum and wave-data kernels below (both land in the
// same compute module — the shared code node is emitted once).
const spectrumHelpers = code(/* wgsl */ `
    const PI: f32 = 3.141592653589793;
    const G: f32 = 9.81;

    fn JonswapAlpha(g: f32, fetch: f32, windSpeed: f32) -> f32 {
        return 0.076 * pow(g * fetch / pow(windSpeed, 2), -0.22);
    }

    fn JonswapPeakFrequency(g: f32, fetch: f32, windSpeed: f32) -> f32 {
        return 22 * pow(windSpeed * fetch / pow(g, 2), -0.33);
    }

    fn gaussianRandom1(seed: vec2<f32>) -> f32 {
        var nrnd0: f32 = random(seed);
        var nrnd1: f32 = random(seed + 0.1);
        return sqrt(-2 * log(max(0.001, nrnd0))) * cos(2 * PI * nrnd1);
    }

    fn gaussianRandom2(seed: vec2<f32>) -> f32 {
        var nrnd0: f32 = random(seed);
        var nrnd1: f32 = random(seed + 0.1);
        return sqrt(-2 * log(max(0.001, nrnd0))) * sin(2 * PI * nrnd1);
    }

    fn random(par: vec2<f32>) -> f32 {
        return fract(sin(dot(par, vec2<f32>(12.9898, 78.233))) * 43758.5453);
    }

    fn frequency(k: f32, g: f32, depth: f32) -> f32 {
	    return sqrt(g * k * tanh(min(k * depth, 20.0)));
    }

    fn frequencyDerivative(k: f32, g: f32, depth: f32) -> f32 {
	    let th = tanh(min(k * depth, 20.0));
	    let ch = cosh(k * depth);
	    return g * (depth * k / ch / ch + th) / frequency(k, g, depth) / 2.0;
    }

    fn normalisationFactor(s: f32) -> f32 {
	    let s2 = s * s;
	    let s3 = s2 * s;
	    let s4 = s3 * s;
	    if (s < 5.0) {
		    return -0.000564 * s4 + 0.00776 * s3 - 0.044 * s2 + 0.192 * s + 0.163;
        }
	    return -4.80e-08 * s4 + 1.07e-05 * s3 - 9.53e-04 * s2 + 5.90e-02 * s + 3.93e-01;
    }

    fn cosine2s(theta: f32, s: f32) -> f32 {
	    return normalisationFactor(s) * pow(abs(cos(0.5 * theta)), 2.0 * s);
    }

    fn spreadPower(omega: f32, peakOmega: f32) -> f32 {
	    if (omega > peakOmega) {
		    return 9.77 * pow(abs(omega / peakOmega), -2.5);
	    }
	    return 6.97 * pow(abs(omega / peakOmega), 5.0);
    }

    fn TMACorrection(omega: f32, g: f32, depth: f32) -> f32 {
        let omegaH = omega * sqrt(depth / g);
        if (omegaH <= 1.0) {
            return 0.5 * omegaH * omegaH;
        }
        if (omegaH < 2.0) {
            return 1.0 - 0.5 * (2.0 - omegaH) * (2.0 - omegaH);
        }
        return 1.0;
    }

    fn directionSpectrum(theta: f32, w: f32, wp: f32, swell: f32, angle: f32, spreadBlend: f32) -> f32 {
        let s = spreadPower(w, wp) + 16.0 * tanh(min(w / wp, 20.0)) * swell * swell;
        return mix(2.0 / PI * cos(theta) * cos(theta), cosine2s(theta - angle, s), spreadBlend);
    }

    fn JONSWAP(w: f32, g: f32, depth: f32, wp: f32, scale: f32, alpha: f32, gamma: f32) -> f32 {
        var sigma: f32 = select(0.07, 0.09, w <= wp);
        var a = exp(-pow(w - wp, 2) / (2 * pow(sigma * wp, 2)));

        return scale * TMACorrection(w, g, depth) * alpha * pow(g, 2)
            * pow(1/w, 5)
            * exp(-1.25 * pow(wp / w, 4))
            * pow(abs(gamma), a);
    }

    fn shortWavesFade(kLength: f32, shortWavesFade: f32, fadeLimit: f32) -> f32
    {
        return (1 - fadeLimit) * exp(-pow(shortWavesFade * kLength, 2)) + fadeLimit;
    }
`)

// h0 amplitude for one k-cell: primary + optional secondary spectrum. Returns
// the spectrumBuffer texel (the original wrote it in place).
export const initialSpectrumValueWGSL = wgslFn(
  /* wgsl */ `
    fn initialSpectrumValue(
        index: u32,
        size: u32,
        waveLength: f32,
        boundaryLow: f32,
        boundaryHigh: f32,
        depth: f32,
        scaleHeight: f32,
        windSpeed: f32,
        windDirection: f32,
        fetch: f32,
        spreadBlend: f32,
        swell: f32,
        peakEnhancement: f32,
        shortWaveFade: f32,
        fadeLimit: f32,
        d_depth: f32,
        d_scaleHeight: f32,
        d_windSpeed: f32,
        d_windDirection: f32,
        d_fetch: f32,
        d_spreadBlend: f32,
        d_swell: f32,
        d_peakEnhancement: f32,
        d_shortWaveFade: f32,
        d_fadeLimit: f32,
    ) -> vec4<f32> {

        var posX = index % size;
        var posY = index / size;

        var xy = vec2<f32>(f32(posX), f32(posY));
        let deltaK = 2.0 * PI / waveLength;
        let nx = f32(posX) - f32(size) / 2.0;
        let nz = f32(posY) - f32(size) / 2.0;
        let k = vec2<f32>(nx, nz) * deltaK;
        let kLength = length(k);

        if(kLength >= boundaryLow && kLength <= boundaryHigh) {

            var kAngle: f32 = atan2(k.y, k.x);

            var alpha = JonswapAlpha(G, fetch, windSpeed);
            var w = frequency(kLength, G, depth);
            var wp = JonswapPeakFrequency(G, fetch, windSpeed);
            var dOmegadk = frequencyDerivative(kLength, G, depth);

            var spectrum: f32 = JONSWAP(w, G, depth, wp, scaleHeight, alpha, peakEnhancement) * directionSpectrum(kAngle, w, wp, swell, windDirection, spreadBlend) * shortWavesFade(kLength, shortWaveFade, fadeLimit);

		    if(d_scaleHeight > 0) {

                var d_alpha = JonswapAlpha(G, d_fetch, d_windSpeed);
                var d_wp = JonswapPeakFrequency(G, d_fetch, d_windSpeed);

			    spectrum = spectrum + JONSWAP(w, G, depth, d_wp, d_scaleHeight, d_alpha, d_peakEnhancement) * directionSpectrum(kAngle, w, d_wp, d_swell, d_windDirection, d_spreadBlend) * shortWavesFade(kLength, d_shortWaveFade, d_fadeLimit);
            }

            var er: f32 = gaussianRandom1(xy);
            var ei: f32 = gaussianRandom2(xy);

            return vec4<f32>( vec2<f32>( er, ei ) * sqrt(2 * spectrum * abs(dOmegadk)/kLength*deltaK*deltaK ), 0, 0 );
	    }
        return vec4<f32>(0.0);
    }
`,
  [spectrumHelpers]
)

// Wave-vector data for one k-cell (k.x, 1/|k|, k.y, ω) — the waveDataBuffer
// texel. Recomputes the cheap k/ω terms instead of sharing intermediates with
// the spectrum kernel (single-return functions; init-time only).
export const initialWaveDataValueWGSL = wgslFn(
  /* wgsl */ `
    fn initialWaveDataValue(
        index: u32,
        size: u32,
        waveLength: f32,
        boundaryLow: f32,
        boundaryHigh: f32,
        depth: f32,
    ) -> vec4<f32> {

        var posX = index % size;
        var posY = index / size;

        let deltaK = 2.0 * PI / waveLength;
        let nx = f32(posX) - f32(size) / 2.0;
        let nz = f32(posY) - f32(size) / 2.0;
        let k = vec2<f32>(nx, nz) * deltaK;
        let kLength = length(k);

        if(kLength >= boundaryLow && kLength <= boundaryHigh) {
            let w = frequency(kLength, G, depth);
            return vec4<f32>( k.x, 1.0 / kLength, k.y, w );
	    }
        return vec4<f32>( k.x, 1.0, k.y, 0.0 );
    }
`,
  [spectrumHelpers]
)

// ── Time evolution (h0 → h(t) displacement/derivative spectra) ──────────────
// The original wrote four vec2 buffers from one kernel; a value function
// returns one value, so it is split in two — each re-derives the cheap h/ih
// intermediates. Packing: xy/zw pairs match the original write order.

// .xy = DxDz texel, .zw = DyDxz texel.
export const timeSpectrumDisplacementWGSL = wgslFn(
  /* wgsl */ `
	fn timeSpectrumDisplacement(h0: vec4<f32>, wave: vec4<f32>, time: f32) -> vec4<f32> {

		var phase = wave.w * time;
		var exponent = vec2<f32>(cos(phase), sin(phase));

		var h = complexMult(h0.xy, exponent) + complexMult(h0.zw, vec2<f32>(exponent.x, -exponent.y));
		var ih = vec2<f32>(-h.y, h.x);

		var displacementX = ih * wave.x * wave.y;
		var displacementY = h;
		var displacementZ = ih * wave.z * wave.y;
		var displacementZ_dx = -h * wave.x * wave.z * wave.y;

		return vec4<f32>(
			displacementX.x - displacementZ.y, displacementX.y + displacementZ.x,
			displacementY.x - displacementZ_dx.y, displacementY.y + displacementZ_dx.x
		);
	}
`,
  [complexMult]
)

// .xy = DyxDyz texel, .zw = DxxDzz texel.
export const timeSpectrumDerivativesWGSL = wgslFn(
  /* wgsl */ `
	fn timeSpectrumDerivatives(h0: vec4<f32>, wave: vec4<f32>, time: f32) -> vec4<f32> {

		var phase = wave.w * time;
		var exponent = vec2<f32>(cos(phase), sin(phase));

		var h = complexMult(h0.xy, exponent) + complexMult(h0.zw, vec2<f32>(exponent.x, -exponent.y));
		var ih = vec2<f32>(-h.y, h.x);

		var displacementX_dx = -h * wave.x * wave.x * wave.y;
		var displacementY_dx = ih * wave.x;
		var displacementY_dz = ih * wave.z;
		var displacementZ_dz = -h * wave.z * wave.z * wave.y;

		return vec4<f32>(
			displacementY_dx.x - displacementY_dz.y, displacementY_dx.y + displacementY_dz.x,
			displacementX_dx.x - displacementZ_dz.y, displacementX_dx.y + displacementZ_dz.x
		);
	}
`,
  [complexMult]
)

// ── IFFT passes ─────────────────────────────────────────────────────────────

// 4-way channel select, replacing the originals' select() chains over the four
// displacement buffers (select evaluates both operands there too — reading all
// four channels per thread is the original behaviour, not a regression).
export const pickChannelWGSL = wgslFn(/* wgsl */ `
	fn pickChannel(a: vec2<f32>, b: vec2<f32>, c: vec2<f32>, d: vec2<f32>, sel: u32) -> vec2<f32> {
		var v = select(a, b, sel == 1u);
		v = select(v, c, sel == 2u);
		return select(v, d, sel == 3u);
	}
`)

// First IFFT stage: pack even + twiddle·odd into the pingpong buffer's zw
// (xy zeroed), conjugating the twiddle.
export const ifftInitValueWGSL = wgslFn(
  /* wgsl */ `
	fn ifftInitValue(data: vec4<f32>, even: vec2<f32>, odd: vec2<f32>) -> vec4<f32> {
		var H: vec2<f32> = even + complexMult( vec2<f32>( data.r, -data.g ), odd );
		return vec4<f32>( 0.0, 0.0, H );
	}
`,
  [complexMult]
)

// One horizontal/vertical butterfly stage: combine even/odd via the twiddle,
// writing into the half of the pingpong texel selected by `pingpong` and
// preserving the other half (`current` is the texel being overwritten).
export const ifftPassValueWGSL = wgslFn(
  /* wgsl */ `
	fn ifftPassValue(data: vec4<f32>, even4: vec4<f32>, odd4: vec4<f32>, current: vec4<f32>, pingpong: u32) -> vec4<f32> {

		let even = select(even4.xy, even4.zw, pingpong == 0 );
		let odd  = select(odd4.xy, odd4.zw, pingpong == 0 );

		let H: vec2<f32> = even + complexMult( data.rg, odd );

		return vec4<f32>(
			select( current.xy, H, pingpong == 0 ),
			select( H, current.zw, pingpong == 0 )
		);
	}
`,
  [complexMult]
)

// Sign-flip checkerboard applied after the last pass (inverse-FFT permute).
export const permuteValueWGSL = wgslFn(/* wgsl */ `
	fn permuteValue(input: vec2<f32>, pos: vec2<u32>) -> vec2<f32> {
		return input * ( 1.0 - 2.0 * f32( ( pos.x + pos.y ) % 2 ) );
	}
`)

// Conditional write helper: keep the old texel unless this dispatch's channel
// selector matches the buffer's channel (the originals wrote all four buffers
// through select() the same way). NB `target` is a reserved WGSL keyword.
export const selectWriteWGSL = wgslFn(/* wgsl */ `
	fn selectWrite(oldValue: vec2<f32>, newValue: vec2<f32>, sel: u32, channel: u32) -> vec2<f32> {
		return select( oldValue, newValue, sel == channel );
	}
`)

// ── Merge (turbulence accumulation for the jacobian/foam texture) ───────────
// Naga also refuses textureStore on texture handles received as function
// parameters ("Image store parameters … Not a global variable"), so unlike the
// original texturesMerger the three texture writes live in the TSL wrapper;
// this kernel only carries the turbulence/jacobian math and returns the
// updated turbulence (its .x is also the jacobian texel).
export const mergeValueWGSL = wgslFn(/* wgsl */ `
	fn mergeValue(
		y: vec2<f32>,
		w: vec2<f32>,
		turbulenceOld: f32,
		lambda: f32,
		deltaTime: f32,
	) -> f32 {

		//The determinant of the Jacobi matrix is a measure of the curvature of the differential surface.
		//The curvature is particularly high at the crests of the waves. At these points,
		//the higher energy density leads to foam formation.

		var jacobian = (1 + lambda * w.x) * (1 + lambda * w.y) - y.y * y.y * lambda * lambda;

		var turbulence = turbulenceOld + deltaTime * 0.5 / max(jacobian, 0.5);
		turbulence = min(jacobian, turbulence);

		return turbulence;
	}
`)
