// Phase B feature — surface/turbulent foam overlay for the ocean.
// Modulates the existing jacobian foam mask with two animated octaves of the
// simplex-noise texture so foam reads as flowing texture instead of a flat
// white cutoff. Pure math; caller samples the noise texture inline so binding
// signatures stay simple.

export const foamSurfaceWGSL = `

    fn oceanSurfaceFoamNoise(
        n: texture_2d<f32>,
        s: sampler,
        worldXZ: vec2<f32>,
        t: f32,
        foamTextureScale: f32,
        foamSpeed: f32
    ) -> f32 {
        // Two octaves drifting on slightly different vectors so the texture
        // never repeats in lock-step. The slower coarse octave dominates; the
        // finer one adds break-up.
        let drift = vec2<f32>(t * foamSpeed, t * foamSpeed * 0.6);
        let uv1 = worldXZ * foamTextureScale + drift;
        let uv2 = worldXZ * foamTextureScale * 2.5 - drift * 0.7;
        let n1 = textureSample(n, s, uv1).r;
        let n2 = textureSample(n, s, uv2).r;
        return n1 * 0.6 + n2 * 0.4;
    }

    fn oceanFoamColor(noiseValue: f32, foamMix: f32) -> vec3<f32> {
        // foamMix = 0 → flat white. foamMix = 1 → noise pulls brightness down to
        // ~0.5 in dark spots, keeping highlights at white. Standard textured-foam
        // look without losing the strong-foam regions entirely.
        let brightness = mix(1.0, mix(0.5, 1.0, noiseValue), foamMix);
        return vec3<f32>(brightness);
    }

`;
