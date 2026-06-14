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
export { GaussianSplatsPlugin } from '../GaussianSplatsPlugin'
export type { GaussianSplatsPluginOptions } from '../GaussianSplatsPlugin'
export {
  KhrGaussianSplattingExtension,
  KHR_GAUSSIAN_SPLATTING,
  KHR_GAUSSIAN_SPLATTING_COMPRESSION_SPZ
} from '../KhrGaussianSplattingExtension'
export { PLYSplatLoader, parsePLYSplat } from '../PLYSplatLoader'

// NOTE: The WebGPU TSL node material (GaussianSplatNode) is not yet implemented.
// It requires the EWA projection to run in a TSL `vertexNode`/`positionNode`,
// which must be prototyped and verified in a real WebGPU context before being
// shipped (see docs/splats-design-spec.md, "Open Questions and Risks" #1). The
// WebGL `GaussianSplatMaterial` from the main entry point is the working path.
