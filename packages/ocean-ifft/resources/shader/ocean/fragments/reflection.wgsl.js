// Phase A refactor — cubemap reflection direction for the ocean surface.
// Preserves the original swizzle (y,x,z) and z-negate trick from the legacy
// shader so the captured CubeCamera environment lines up with the surface
// orientation. Phase C may replace this with SSR but the call stays.

export const reflectionWGSL = `

    fn envReflectionDir(normalOcean: vec3<f32>, viewDir: vec3<f32>) -> vec3<f32> {
        var halfVec = normalize(-viewDir + normalOcean);
        var R = vec3<f32>(halfVec.y, halfVec.x, halfVec.z);
        R.z = -R.z;
        return R;
    }

`;
