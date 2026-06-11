// WaterPro shader program ports as Three.js TSL node factory functions.
// Faithful re-implementations of the decompiled AF/EF/PF/BF/_F classes:
//   - program 4 (water-color) → waterColorNode / buildWaterColumnDepth
//   - program 5 (surface-foam) → surfaceFoamNode
//   - program 6 (shoreline-foam) → shorelineFoamNode
//   - program 7 (wave-foam / turbulent-foam) → waveFoamNode
//   - foam compositor (AF.build) → combineFoamNode

export {
  waterColorNode,
  buildWaterColumnDepth,
  buildIsObjectInFront,
} from './nodes/water-color.js'
export type {
  WaterColorParams,
  WaterColumnDepthParams,
  WaterColorOutputs,
} from './nodes/water-color.js'

export { surfaceFoamNode } from './nodes/surface-foam.js'
export type { SurfaceFoamParams, SurfaceFoamOutputs } from './nodes/surface-foam.js'

export { shorelineFoamNode } from './nodes/shoreline-foam.js'
export type { ShorelineFoamParams, ShorelineFoamOutputs } from './nodes/shoreline-foam.js'

export { waveFoamNode } from './nodes/wave-foam.js'
export type { WaveFoamParams, WaveFoamOutputs } from './nodes/wave-foam.js'

export { fresnelDistanceNode } from './nodes/fresnel-distance.js'
export type {
  FresnelDistanceParams,
  FresnelDistanceOutputs,
} from './nodes/fresnel-distance.js'

export { subSurfaceScatteringNode } from './nodes/sub-surface-scattering.js'
export type {
  SubSurfaceScatteringParams,
  SubSurfaceScatteringOutputs,
} from './nodes/sub-surface-scattering.js'

export { sparkleNode } from './nodes/sparkle.js'
export type { SparkleParams, SparkleOutputs } from './nodes/sparkle.js'

export { turbulentFoamNode } from './nodes/turbulent-foam.js'
export type {
  TurbulentFoamParams,
  TurbulentFoamOutputs,
  WaveNormalSampler,
} from './nodes/turbulent-foam.js'

export { combineFoamNode } from './nodes/combine-foam.js'
export type {
  CombineFoamParams,
  CombineFoamOutputs,
  CombineFoamSurface,
  CombineFoamWave,
  CombineFoamShoreline,
  CombineFoamWake,
  CombineFoamSceneInputs,
} from './nodes/combine-foam.js'

// Wave simulation (ports of WaterPro SF cascade simulation + samplers).
export { WaveSimulation } from './waves/wave-simulation.js'
export type { WaveSimulationParams } from './waves/wave-simulation.js'
export { WaveCascade } from './waves/wave-cascade.js'
export type { WaveCascadeParams } from './waves/wave-cascade.js'
export {
  sampleWaveDisplacement,
  sampleWaveNormal,
  sampleWaveSurface,
} from './waves/wave-sampler.js'
export type {
  DisplacementSample,
  NormalSample,
  SampleOpts,
} from './waves/wave-sampler.js'
export {
  DEFAULT_CASCADES,
  DEFAULT_RESOLUTION,
  makePrimarySpectrum,
  makeSecondarySpectrum,
} from './waves/wave-defaults.js'
export type {
  CascadeConfig,
  SpectrumParams,
  DualSpectrumParams,
} from './waves/wave-defaults.js'

// Gerstner overlay (port of WaterPro CPU setup + evaluateGerstnerCPU).
export { GerstnerOverlay, DEFAULT_GERSTNER_WAVES } from './waves/gerstner.js'
export type {
  GerstnerWaveSpec,
  GerstnerOverlayParams,
  GerstnerEvalOutputs,
} from './waves/gerstner.js'

// Water-only scene presets (atmosphere / caustics / oceanFloor / postProcessing
// / fresnel.underwater / ssr fields stripped — those belong elsewhere).
export {
  WATERPRO_PRESETS,
  WATERPRO_PRESET_NAMES,
  applyWaterproPreset,
} from './presets.js'
export type {
  WaterproPresetName,
  WaterproPresetWaterFields,
  WaterproPresetUniformBag,
} from './presets.js'

// Underwater post effect (absorption fog + procedural Voronoi caustics).
export {
  underwaterPostNode,
  createUnderwaterUniforms,
} from './nodes/underwater.js'
export type {
  UnderwaterUniforms,
  UnderwaterPostParams,
} from './nodes/underwater.js'
