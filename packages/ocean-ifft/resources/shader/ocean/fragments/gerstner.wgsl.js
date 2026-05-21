// Phase B feature — Gerstner wave overlay for the ocean vertex shader.
// Adds up to 3 hero waves on top of the FFT displacement. Each wave is
// parameterized by direction (xz unit vec), wavelength, and amplitude, packed
// into a single vec4 to keep the uniform binding count low. Deep-water
// dispersion (omega = sqrt(g*k)) and shared steepness control across all
// waves. Returns the summed displacement vec3 (dx, dy, dz) for the entrypoint
// to add to its FFT result.

export const gerstnerWGSL = `

    fn gerstnerSingle(
        worldXZ: vec2<f32>,
        t: f32,
        dirX: f32, dirZ: f32, wavelength: f32, amplitude: f32,
        steepness: f32,
        phase: f32
    ) -> vec3<f32> {
        let dir = normalize(vec2<f32>(dirX, dirZ));
        let k = 6.2831853 / max(wavelength, 0.001);
        let g = 9.81;
        let omega = sqrt(g * k);
        let theta = k * dot(dir, worldXZ) - omega * t + phase;
        let qa = steepness * amplitude;
        let c = cos(theta);
        let s = sin(theta);
        return vec3<f32>(qa * dir.x * c, amplitude * s, qa * dir.y * c);
    }

    fn gerstnerSum(
        worldXZ: vec2<f32>,
        t: f32,
        wave0: vec4<f32>,
        wave1: vec4<f32>,
        wave2: vec4<f32>,
        gerstnerSteepness: f32,
        gerstnerStrength: f32
    ) -> vec3<f32> {
        var sum = vec3<f32>(0.0);
        // Skip zero-amplitude waves so disabling slots is just amplitude=0.
        if (wave0.w > 0.0) { sum += gerstnerSingle(worldXZ, t, wave0.x, wave0.y, wave0.z, wave0.w, gerstnerSteepness, 0.0); }
        if (wave1.w > 0.0) { sum += gerstnerSingle(worldXZ, t, wave1.x, wave1.y, wave1.z, wave1.w, gerstnerSteepness, 2.1); }
        if (wave2.w > 0.0) { sum += gerstnerSingle(worldXZ, t, wave2.x, wave2.y, wave2.z, wave2.w, gerstnerSteepness, 4.2); }
        return sum * gerstnerStrength;
    }

`;
