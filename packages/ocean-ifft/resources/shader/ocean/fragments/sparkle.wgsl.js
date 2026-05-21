// Phase A feature — sun sparkle for the ocean surface.
// High-frequency specular shimmer from the sun, modulated by the simplex noise
// texture so the highlight breaks into discrete specks instead of one smooth lobe.
// Reference: Wakeling / Sea of Thieves sparkle term.
// Caller samples noise; this is pure math.

export const sparkleWGSL = `

    fn oceanSparkle(
        normalOcean: vec3<f32>,
        viewDir: vec3<f32>,
        sunDir: vec3<f32>,
        noiseSample: f32,
        sparkleIntensity: f32,
        sparkleSize: f32
    ) -> f32 {
        let reflectDir = reflect(-sunDir, normalOcean);
        let sunDot = saturate(dot(reflectDir, viewDir));
        let sharp = pow(sunDot, sparkleSize);
        let modulated = sharp * (0.5 + noiseSample);
        return modulated * sparkleIntensity;
    }

`;
