// Phase A refactor — shared WGSL helpers for the ocean fragment shader.
// Pure math utilities: saturate, fresnel, specular models, HDR tone, sky color,
// anisotropic texture sample, and the bilinear fallback path.
// All callers concatenate this string into the wgslFn compilation unit; do not
// import this file outside of fragmentStageWGSL.js.

export const helpersWGSL = `

    fn saturate(value: f32) -> f32 {
        return max(0.0, min(value, 1.0));
    }

    fn diffuseLight(N: vec3<f32>, L: vec3<f32>, strength: f32, e: f32) -> f32 {
        return pow(dot(N, L) * strength + (1.0 - strength), e);
    }

    fn specularLight(N: vec3<f32>, L: vec3<f32>, V: vec3<f32>, e: f32) -> f32 {
        var R = reflect(N, L);
        var nrm: f32 = (e + 8.0) / (3.1415 * 8.0);
        return pow(max(dot(R, V), 0.0), e) * nrm;
    }

    fn specularLight2(N: vec3<f32>, L: vec3<f32>, V: vec3<f32>, e: f32) -> f32 {
        var half_vector = normalize(V - L);
        return pow(max(dot(N, half_vector), 0.0), e);
    }

    fn fresnelSchlick(F: f32, N: vec3<f32>, V: vec3<f32>, exp_: f32) -> f32 {
        return F + (1.0 - F) * pow(saturate(1.0 - dot(N, V)), exp_);
    }

    fn HDR(color: vec3<f32>, e: f32) -> vec3<f32> {
        return vec3<f32>(1.0) - exp(-color * e);
    }

    fn getSkyColor(rayDir: vec3<f32>) -> vec3<f32> {
        return mix(vec3<f32>(1.0), mix(SKYCOLOR, 0.2 * SKYCOLOR, rayDir.y), smoothstep(-0.5, 0.25, rayDir.y));
    }

    fn sumV(v: vec3<f32>) -> f32 {
        return v.x + v.y + v.z;
    }

    fn random(par: vec2<f32>) -> f32 {
        return fract(sin(dot(par, vec2<f32>(12.9898, 78.233))) * 43758.5453);
    }

    fn customTextureSample(t: texture_2d<f32>, s: sampler, uv: vec2<f32>) -> vec4<f32> {
        var textureSize: f32 = 512.0;
        var mip_bias: f32 = 0.0;
        var maxAnisotropy: f32 = 16.0;

        var dx = dpdx(uv * textureSize);
        var dy = dpdy(uv * textureSize);

        var Pmax = max(dot(dx, dx), dot(dy, dy));
        var Pmin = min(dot(dx, dx), dot(dy, dy));

        var roundedRatio = ceil(Pmax / Pmin);
        var clampedRatio = min(roundedRatio, pow(maxAnisotropy, 2.0));

        var mipmapLevel = min(0.5 * log2(Pmax / clampedRatio) + mip_bias, 7.0);

        return textureSampleLevel(t, s, uv, mipmapLevel);
    }

    fn findNearestTexelsAndInterpolate(t: texture_2d<f32>, position: vec2<f32>, size: f32) -> vec4<f32> {
        var weights: vec2<f32> = abs(fract(position));

        var texCoord0 = floor(position) % size;
        var texCoord1 = vec2<f32>(ceil(position.x), floor(position.y)) % size;
        var texCoord2 = vec2<f32>(floor(position.x), ceil(position.y)) % size;
        var texCoord3 = ceil(position) % size;

        var offset = size - 1.0;

        if (texCoord0.x < 0.0) { texCoord0.x = offset + texCoord0.x; }
        if (texCoord0.y < 0.0) { texCoord0.y = offset + texCoord0.y; }
        if (texCoord1.x < 0.0) { texCoord1.x = offset + texCoord1.x; }
        if (texCoord1.y < 0.0) { texCoord1.y = offset + texCoord1.y; }
        if (texCoord2.x < 0.0) { texCoord2.x = offset + texCoord2.x; }
        if (texCoord2.y < 0.0) { texCoord2.y = offset + texCoord2.y; }
        if (texCoord3.x < 0.0) { texCoord3.x = offset + texCoord3.x; }
        if (texCoord3.y < 0.0) { texCoord3.y = offset + texCoord3.y; }

        var lodlevel = 0;

        var texel0 = textureLoad(t, vec2<i32>(texCoord0), lodlevel);
        var texel1 = textureLoad(t, vec2<i32>(texCoord1), lodlevel);
        var texel2 = textureLoad(t, vec2<i32>(texCoord2), lodlevel);
        var texel3 = textureLoad(t, vec2<i32>(texCoord3), lodlevel);

        var interp1 = mix(texel0, texel1, weights.x);
        var interp2 = mix(texel2, texel3, weights.x);
        return mix(interp1, interp2, weights.y);
    }

`;
