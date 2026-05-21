// Phase A refactor — ocean surface fragment shader entrypoint.
// Assembles the modular WGSL fragments (constants, helpers, normals, foam,
// lighting, reflection, color, sss, sparkle) into one wgslFn compilation unit.
// Adds noise + sss + sparkle uniforms compared to the pre-refactor signature.
// The entrypoint orchestrates texture sampling and composes the final color;
// pure math lives in fragments/*.wgsl.js.

import { wgslFn } from "three/tsl";
import { constantsWGSL } from "./fragments/_constants.wgsl.js";
import { helpersWGSL } from "./fragments/_helpers.wgsl.js";
import { normalsWGSL } from "./fragments/normals.wgsl.js";
import { foamWGSL } from "./fragments/foam.wgsl.js";
import { lightingWGSL } from "./fragments/lighting.wgsl.js";
import { reflectionWGSL } from "./fragments/reflection.wgsl.js";
import { colorWGSL } from "./fragments/color.wgsl.js";
import { sssWGSL } from "./fragments/sss.wgsl.js";
import { sparkleWGSL } from "./fragments/sparkle.wgsl.js";
import { foamSurfaceWGSL } from "./fragments/foam-surface.wgsl.js";

const entrypointWGSL = `

    fn WGSLColor(
        cameraPosition: vec3<f32>,
        position: vec3<f32>,
        oceanSize: f32,
        minLodRadius: f32,
        numLayers: f32,
        gridResolution: f32,
        vindex: i32,
        width: f32,
        lod: f32,
        time: f32,
        derivatives0: texture_2d<f32>,
        derivatives1: texture_2d<f32>,
        derivatives2: texture_2d<f32>,
        jacobian0: texture_2d<f32>,
        jacobian1: texture_2d<f32>,
        jacobian2: texture_2d<f32>,
        ifft_sampler0: sampler,
        ifft_sampler1: sampler,
        ifft_sampler2: sampler,
        waveLengths: vec4<f32>,
        ifftResolution: f32,
        foamStrength: f32,
        foamThreshold: f32,
        vMorphedPosition: vec3<f32>,
        vDisplacedPosition: vec3<f32>,
        vCascadeScales: vec4<f32>,
        envTexture: texture_cube<f32>,
        envTexture_sampler: sampler,
        sunPosition: vec3<f32>,
        noise: texture_2d<f32>,
        noise_sampler: sampler,
        sssColor: vec3<f32>,
        sssStrength: f32,
        sparkleIntensity: f32,
        sparkleSize: f32,
        foamTextureScale: f32,
        foamSpeed: f32,
        foamMix: f32,
    ) -> vec4<f32> {

        var vViewVector = vDisplacedPosition - cameraPosition;
        var vViewDist = length(vViewVector);
        var viewDir = normalize(vViewVector);

        var Normal_0 = textureSample(derivatives0, ifft_sampler0, vMorphedPosition.xz / waveLengths.x) * vCascadeScales.x;
        var Normal_1 = textureSample(derivatives1, ifft_sampler1, vMorphedPosition.xz / waveLengths.y) * vCascadeScales.y;
        var Normal_2 = textureSample(derivatives2, ifft_sampler2, vMorphedPosition.xz / waveLengths.z) * vCascadeScales.z;
        var normalOcean = cascadeNormalFromDerivatives(Normal_0 + Normal_1 + Normal_2);
        normalOcean = flipNormalToCamera(normalOcean, viewDir);

        var jacobi0 = textureSample(jacobian0, ifft_sampler0, vMorphedPosition.xz / waveLengths.x).x;
        var jacobi1 = textureSample(jacobian1, ifft_sampler1, vMorphedPosition.xz / waveLengths.y).x;
        var jacobi2 = textureSample(jacobian2, ifft_sampler2, vMorphedPosition.xz / waveLengths.z).x;
        var foam_mix_factor = jacobianToFoam(jacobi0 + jacobi1 + jacobi2, foamStrength, foamThreshold);

        var sunDir = normalize(sunPosition);
        var lit = oceanLighting(normalOcean, viewDir, sunDir);
        var fresnel = lit.x;
        var specular = lit.y;

        var R = envReflectionDir(normalOcean, viewDir);
        var reflectionColor = textureSample(envTexture, envTexture_sampler, R).rgb;

        var waterColor = composeWaterColor(reflectionColor, fresnel, vDisplacedPosition.y, vViewDist);
        var oceanColor = waterColor;

        oceanColor += normalize(vec3<f32>(5.0, 4.5, 4.0)) * specular;

        oceanColor += oceanSSS(viewDir, normalOcean, sunDir, vDisplacedPosition.y, sssColor, sssStrength);

        var noiseSample = textureSample(noise, noise_sampler, vMorphedPosition.xz * 0.05).r;
        var sparkle = oceanSparkle(normalOcean, viewDir, sunDir, noiseSample, sparkleIntensity, sparkleSize);
        oceanColor += vec3<f32>(sparkle);

        var foamNoise = oceanSurfaceFoamNoise(noise, noise_sampler, vMorphedPosition.xz, time, foamTextureScale, foamSpeed);
        var foamColor = oceanFoamColor(foamNoise, foamMix);
        oceanColor = mix(oceanColor, foamColor, foam_mix_factor);

        // Cascade-0 weight modulates how much detail survives at this LOD;
        // outside the LOD radius we blend toward an atmospheric background so
        // mip thrashing isn't visible.
        oceanColor = applyCascadeFade(oceanColor, reflectionColor, vCascadeScales.x);

        // Distance fog kept identical to pre-refactor.
        var finalColor = applyDistanceFog(oceanColor, reflectionColor, vViewDist);
        return vec4<f32>(finalColor, 1.0);
    }

`;

export const fragmentStageWGSL = wgslFn(
    [
        entrypointWGSL,
        constantsWGSL,
        helpersWGSL,
        normalsWGSL,
        foamWGSL,
        lightingWGSL,
        reflectionWGSL,
        colorWGSL,
        sssWGSL,
        sparkleWGSL,
        foamSurfaceWGSL,
    ].join("\n")
);
