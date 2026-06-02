// Phase A refactor — ocean fragment shader constants.
// Static color palette used by the surface fragment composition.
// Kept as a single WGSL block so it can be inlined into the fragmentStageWGSL
// compilation unit without affecting binding layout.
// Tweak these to retune the base water palette; runtime tints are uniforms.

export const constantsWGSL = `

    const SKYCOLOR: vec3<f32> = vec3<f32>(0.196, 0.588, 0.785);
    const SEACOLOR: vec3<f32> = vec3<f32>(0.004, 0.016, 0.047);
    const WAVECOLOR: vec3<f32> = vec3<f32>(0.14, 0.25, 0.18);

`;
