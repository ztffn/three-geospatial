// Phase A refactor — direct lighting terms for the ocean surface.
// Computes fresnel reflectance and the sun's specular highlight as a vec2 so
// the entrypoint stays terse. Specular intensity multiplier kept here.

export const lightingWGSL = `

    fn oceanLighting(normalOcean: vec3<f32>, viewDir: vec3<f32>, sunDir: vec3<f32>) -> vec2<f32> {
        var fresnel = fresnelSchlick(0.02, normalOcean, -viewDir, 5.0);
        var specular = specularLight2(normalOcean, sunDir, viewDir, 8.0) * 1.3;
        return vec2<f32>(fresnel, specular);
    }

`;
