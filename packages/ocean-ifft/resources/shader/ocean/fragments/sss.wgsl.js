// Phase A feature — subsurface scattering for the ocean surface.
// Adds back-scatter on wave crests facing the sun: light passes through the
// translucent crest toward the camera and reads as a green-cyan glow.
// Reference: Sea of Thieves / FrostBite wave-back scattering talks.
// Pure fragment add — no extra texture samples.

export const sssWGSL = `

    fn oceanSSS(
        viewDir: vec3<f32>,
        normalOcean: vec3<f32>,
        sunDir: vec3<f32>,
        waveHeight: f32,
        sssColor: vec3<f32>,
        sssStrength: f32
    ) -> vec3<f32> {
        // Camera looking toward the sun — gated by a sharp falloff so SSS only
        // fires in the glare zone, not as an all-over green tint.
        let back = saturate(dot(viewDir, -sunDir));
        let backFall = pow(back, 8.0);

        // Crest tip facing up — full where the wave is locally flat, fading on
        // the steep faces so SSS reads as transmission through the thin tip.
        let normalUp = saturate(normalOcean.y);

        // Crest thickness proxy — ramps slowly so only the genuinely tall crests
        // glow. ifftResolution-independent: tuned for the ~5-15m wave heights
        // this FFT produces.
        let heightTerm = saturate(waveHeight * 0.05);

        let sss = backFall * normalUp * heightTerm;
        return sssColor * sss * sssStrength;
    }

`;
