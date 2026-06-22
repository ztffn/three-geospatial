// The renderer-agnostic core (data model, PLY loader, sorter, glTF extension,
// tiles plugin) is shared across both the WebGL and WebGPU paths.
export {
  computeSplatBounds,
  shDegreeToCoefficientCount,
  validateGaussianSplatData
} from '../GaussianSplatData'
export type { GaussianSplatData } from '../GaussianSplatData'
export {
  CPUSplatSorter,
  SortTrigger
} from '../GaussianSplatSorter'
export type { GaussianSplatSorter } from '../GaussianSplatSorter'
export { GaussianSplatGeometry } from '../GaussianSplatGeometry'
export { GaussianSplatMesh } from '../GaussianSplatMesh'
export type {
  GaussianSplatMeshOptions,
  SplatMaterial
} from '../GaussianSplatMesh'
export { GaussianSplatsPlugin } from '../GaussianSplatsPlugin'
export type { GaussianSplatsPluginOptions } from '../GaussianSplatsPlugin'
export {
  KhrGaussianSplattingExtension,
  KHR_GAUSSIAN_SPLATTING,
  KHR_GAUSSIAN_SPLATTING_COMPRESSION_SPZ
} from '../KhrGaussianSplattingExtension'
export { PLYSplatLoader, parsePLYSplat } from '../PLYSplatLoader'

// WebGPU/TSL render path: the EWA projection runs in a full TSL `vertexNode`
// (see docs/splats-design-spec.md §11.1). Pass it to `GaussianSplatMesh` via the
// `createMaterial` option to render splats under the Three.js WebGPU renderer.
export { GaussianSplatNodeMaterial } from './GaussianSplatNodeMaterial'
