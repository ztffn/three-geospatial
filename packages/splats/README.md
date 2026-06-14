# @takram/three-geospatial-splats

3D Gaussian Splat rendering for Three.js and React Three Fiber, designed to
integrate with the `3d-tiles-renderer` streaming/LOD pipeline.

> **Status: Phase 1 (WebGL).** The renderer-agnostic core (data model, PLY
> loader, depth sorter, glTF `KHR_gaussian_splatting` extension, tiles plugin)
> and the WebGL `GaussianSplatMaterial` are implemented. The WebGPU TSL material
> and SPZ decompression are not yet implemented — see
> [`docs/splats-design-spec.md`](../../docs/splats-design-spec.md).

## What it does

- Parses binary 3D Gaussian Splatting `.ply` files (`parsePLYSplat` /
  `PLYSplatLoader`).
- Builds GPU data textures and precomputes per-splat 3D covariance
  (`GaussianSplatGeometry`).
- Renders splats via EWA elliptical projection with pre-multiplied alpha
  compositing (`GaussianSplatMaterial`), sorting back-to-front on the CPU
  (`CPUSplatSorter`) with a CesiumJS-style ~0.5° re-sort threshold
  (`SortTrigger`).
- Loads splat tiles through `3d-tiles-renderer`
  (`KhrGaussianSplattingExtension` + `GaussianSplatsPlugin`).

## Usage

### Standalone (React Three Fiber)

```tsx
import { Canvas } from '@react-three/fiber'
import { GaussianSplats } from '@takram/three-geospatial-splats/r3f'

<Canvas>
  <GaussianSplats url="/scene.ply" />
</Canvas>
```

### Tiled splats via 3d-tiles-renderer

```tsx
import { GLTFExtensionsPlugin } from '3d-tiles-renderer/plugins'
import { TilesPlugin, TilesRenderer } from '3d-tiles-renderer/r3f'
import {
  GaussianSplatsPlugin,
  KhrGaussianSplattingExtension
} from '@takram/three-geospatial-splats'

<TilesRenderer url={tilesetUrl}>
  <TilesPlugin
    plugin={GLTFExtensionsPlugin}
    args={{
      plugins: [parser => new KhrGaussianSplattingExtension(parser)]
    }}
  />
  <TilesPlugin plugin={GaussianSplatsPlugin} args={{ renderOrder: 2 }} />
</TilesRenderer>
```

`GaussianSplatsPlugin.update(renderer, camera)` must be called once per frame
to keep the splats sorted (the R3F integration drives this for you).

## Verification

`pnpm exec vitest run --config packages/splats/vite.config.ts` covers the PLY
parser and the depth sorter. Visual rendering must be verified in a browser via
the `splats/Gaussian Splats` Storybook story.
