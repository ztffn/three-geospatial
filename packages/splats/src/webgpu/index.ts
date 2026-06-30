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
export type {
  GaussianSplatSorter,
  GpuGaussianSplatSorter
} from '../GaussianSplatSorter'
export { WorkerSplatSorter } from '../WorkerSplatSorter'
export { GaussianSplatGeometry } from '../GaussianSplatGeometry'
export { GaussianSplatMesh } from '../GaussianSplatMesh'
export type {
  GaussianSplatMeshOptions,
  SplatLodMeshOptions,
  SplatMaterial
} from '../GaussianSplatMesh'
export {
  SplatOctree,
  computeSplatImportance,
  octreeToFlat,
  octreeFromFlat
} from '../SplatOctree'
export type {
  SplatOctreeLeaf,
  SplatOctreeOptions,
  SplatOctreeData,
  SplatOctreeFlat
} from '../SplatOctree'
export { SplatLodSelector } from '../SplatLodSelector'
export type { SplatLodParams, SplatLodResult } from '../SplatLodSelector'
export { WorkerSplatLodSelector } from '../WorkerSplatLodSelector'
export { GaussianSplatsPlugin } from '../GaussianSplatsPlugin'
export type { GaussianSplatsPluginOptions } from '../GaussianSplatsPlugin'
export {
  KhrGaussianSplattingExtension,
  KHR_GAUSSIAN_SPLATTING,
  KHR_GAUSSIAN_SPLATTING_COMPRESSION_SPZ
} from '../KhrGaussianSplattingExtension'
export { PLYSplatLoader, parsePLYSplat } from '../PLYSplatLoader'
export { loadSpzSplatData } from '../SpzSplatLoader'
export type { SpzSplatLoadOptions } from '../SpzSplatLoader'

// WebGPU/TSL render path: the EWA projection runs in a full TSL `vertexNode`
// (see docs/splats-design-spec.md §11.1). Pass it to `GaussianSplatMesh` via the
// `createMaterial` option to render splats under the Three.js WebGPU renderer.
export { GaussianSplatNodeMaterial } from './GaussianSplatNodeMaterial'

// GPU-resident radix sort (PlayCanvas multipass port). `GpuSplatSorter` drops
// into `GaussianSplatMesh` via the `sorter` option to sort multi-million-splat
// clouds entirely on the GPU — no CPU worker, no per-sort index upload.
export { GpuSplatSorter } from './GpuSplatSorter'
export { WebGpuRadixSort } from './WebGpuRadixSort'
