// Phase A refactor — water color composition for the ocean surface.
// Blends refraction (deep sea base) with reflection (cubemap) by fresnel, adds
// the wave-crest tint with distance attenuation, and applies the cascade-fade
// + distance fog that the original shader used to hide mip thrashing.

export const colorWGSL = `

    fn composeWaterColor(
        reflectionColor: vec3<f32>,
        fresnel: f32,
        displacedHeight: f32,
        viewDist: f32
    ) -> vec3<f32> {
        var refractionColor = SEACOLOR;
        var waterColor = mix(refractionColor, reflectionColor, fresnel);
        var atten: f32 = max(1.0 - viewDist * viewDist * 0.001, 0.0);
        waterColor += WAVECOLOR * saturate(displacedHeight - 0.0) * 0.05 * atten;
        return waterColor;
    }

    fn applyCascadeFade(oceanColor: vec3<f32>, reflectionColor: vec3<f32>, cascadeScale0: f32) -> vec3<f32> {
        var atmosphericBackground = reflectionColor * 0.4 + SEACOLOR * 0.6;
        return mix(atmosphericBackground, oceanColor, cascadeScale0);
    }

    fn applyDistanceFog(oceanColor: vec3<f32>, reflectionColor: vec3<f32>, viewDist: f32) -> vec3<f32> {
        let fade = smoothstep(500.0, 4000.0, viewDist);
        var atmosphericFog = reflectionColor * 0.6 + SEACOLOR * 0.4;
        return mix(oceanColor, atmosphericFog, fade);
    }

`;
