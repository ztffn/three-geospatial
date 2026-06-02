// Phase A refactor — slope-to-normal reconstruction for the ocean surface.
// Converts the summed cascade derivatives (already weighted by cascade scale and
// sampled at cascade-specific UVs in the entrypoint) into a unit surface normal.
// Kept as a pure math function so the texture sampling stays visible in the
// entrypoint and bindings remain simple.

export const normalsWGSL = `

    fn cascadeNormalFromDerivatives(summed: vec4<f32>) -> vec3<f32> {
        var derivatives: vec4<f32> = normalize(summed);
        var slope: vec2<f32> = vec2<f32>(
            derivatives.x / (1.0 + derivatives.z),
            derivatives.y / (1.0 + derivatives.w)
        );
        return normalize(vec3<f32>(-slope.x, 1.0, -slope.y));
    }

    fn flipNormalToCamera(n: vec3<f32>, viewDir: vec3<f32>) -> vec3<f32> {
        if (dot(n, -viewDir) < 0.0) {
            return -n;
        }
        return n;
    }

`;
