# @takram/three-geospatial-splats

3D Gaussian Splatting for Three.js — **SPZ and PLY loaders** plus **WebGL and
WebGPU renderers**, with a fully GPU-driven WebGPU pipeline (compute projection,
GPU radix sort, octree LOD) that scales to multi-million-splat clouds.

MIT licensed. See [Attribution](#attribution-and-licenses) for the upstream work
this builds on.

## Features

- **Loaders** — SPZ (`loadSpzSplatData`, via the [`spz-js`](https://www.npmjs.com/package/spz-js) library)
  and binary PLY (`PLYSplatLoader` / `parsePLYSplat`). Both decode spherical
  harmonics (degrees 1–3) and apply the RDF→RUB coordinate flip.
- **WebGL renderer** (`GaussianSplatMaterial`) — EWA elliptical projection in the
  vertex shader, premultiplied-alpha compositing, CPU/Worker depth sort.
- **WebGPU renderer** (`GaussianSplatNodeMaterial`, TSL node material) — the
  performance path. Per-splat projection + view-dependent SH colour run in a
  compute pre-pass; ordering and culling are GPU-driven:
  - **GPU radix sort** (`GpuSplatSorter` / `WebGpuRadixSort`) — sorts the cloud
    back-to-front entirely on the GPU; no CPU worker, no per-frame index upload.
  - **Octree LOD + budget** (`SplatOctree` / `SplatLodSelector`) — a spatial
    octree with importance-decimated LOD levels, distance-banded selection,
    a global splat budget, frustum culling, and a cross-fade across LOD changes.
    Runs off the main thread (`WorkerSplatLodSelector`).
- **3D Tiles** — streams tiled splats through
  [`3d-tiles-renderer`](https://github.com/NASA-AMMOS/3DTilesRendererJS)
  (`KhrGaussianSplattingExtension` + `GaussianSplatsPlugin`).
- **React Three Fiber** wrapper (`@takram/three-geospatial-splats/r3f`).

For how the pipeline works and the design decisions behind it, see
[`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Install

```bash
npm install @takram/three-geospatial-splats three
```

Peer dependencies: `three` (>=0.170), and for the respective entry points
`@react-three/fiber` + `react` (r3f) and `3d-tiles-renderer` (tiles). The WebGPU
path requires `three`'s `WebGPURenderer`.

## Entry points

| Import | Contents |
| --- | --- |
| `@takram/three-geospatial-splats` | Loaders, data model, geometry, WebGL material, mesh, CPU/Worker sorters, 3D Tiles integration. |
| `@takram/three-geospatial-splats/webgpu` | The above **plus** the WebGPU node material, GPU radix sort, and octree-LOD pipeline. |
| `@takram/three-geospatial-splats/r3f` | The `<GaussianSplats>` React Three Fiber component. |

## Quickstart — WebGPU (recommended)

```ts
import { WebGPURenderer } from 'three/webgpu'
import {
  GaussianSplatMesh,
  GaussianSplatNodeMaterial,
  GpuSplatSorter,
  loadSpzSplatData
} from '@takram/three-geospatial-splats/webgpu'

const buffer = await (await fetch('/scene.spz')).arrayBuffer()
const data = await loadSpzSplatData(buffer)

const mesh = new GaussianSplatMesh(data, {
  // WebGPU TSL node material (projection + SH colour run in a compute pre-pass).
  createMaterial: geometry => new GaussianSplatNodeMaterial(geometry),
  // GPU radix sort — orders the cloud on the GPU each time the camera moves.
  sorter: new GpuSplatSorter(),
  // Optional octree LOD: render at most `budget` splats/frame, chosen by distance.
  // Omit to draw the whole cloud (sorted, no LOD).
  lod: { budget: 1_000_000 }
})
scene.add(mesh)

// Once per frame, before rendering:
mesh.update(renderer, camera)
```

**Large clouds (>~2M splats):** `WebGPURenderer` requests the WebGPU spec-minimum
device limits, which are too small for multi-million-splat buffers/textures. Pass
`requiredLimits` set to the adapter's maxima when constructing the renderer — see
[`ARCHITECTURE.md` § Device limits](./ARCHITECTURE.md#device-limits).

## Quickstart — WebGL

```ts
import {
  GaussianSplatMesh,
  WorkerSplatSorter,
  loadSpzSplatData
} from '@takram/three-geospatial-splats'

const data = await loadSpzSplatData(await (await fetch('/scene.spz')).arrayBuffer())
const mesh = new GaussianSplatMesh(data, { sorter: new WorkerSplatSorter() })
scene.add(mesh)
// per frame:
mesh.update(renderer, camera)
```

The default material is the WebGL `GaussianSplatMaterial`; the default sorter is
the synchronous `CPUSplatSorter` (fine up to a few hundred thousand splats — use
`WorkerSplatSorter` above that).

## React Three Fiber

The `<GaussianSplats>` component is the simple path: it loads a **`.ply`** URL with
`PLYSplatLoader` and renders with the **default WebGL** material + CPU sort. It drives
`update` for you each frame.

```tsx
import { Canvas } from '@react-three/fiber'
import { GaussianSplats } from '@takram/three-geospatial-splats/r3f'

;<Canvas>
  <GaussianSplats url="/scene.ply" /> {/* or: data={preParsedData} */}
</Canvas>
```

To render an **SPZ** file through the component, decode it yourself and pass the
result as `data` (the `url` prop is PLY-only):

```tsx
const data = await loadSpzSplatData(await (await fetch('/scene.spz')).arrayBuffer())
;<GaussianSplats data={data} />
```

There is **no R3F wrapper for the WebGPU path** (node material, GPU sort, octree LOD).
For that, construct `GaussianSplatMesh` directly as in the WebGPU quickstart above and
call `mesh.update(renderer, camera)` from your own `useFrame`.

## Tiled splats via 3d-tiles-renderer

```tsx
import { GLTFExtensionsPlugin } from '3d-tiles-renderer/plugins'
import { TilesPlugin, TilesRenderer } from '3d-tiles-renderer/r3f'
import {
  GaussianSplatsPlugin,
  KhrGaussianSplattingExtension
} from '@takram/three-geospatial-splats'

;<TilesRenderer url={tilesetUrl}>
  <TilesPlugin
    plugin={GLTFExtensionsPlugin}
    args={{ plugins: [parser => new KhrGaussianSplattingExtension(parser)] }}
  />
  <TilesPlugin plugin={GaussianSplatsPlugin} args={{ renderOrder: 2 }} />
</TilesRenderer>
```

`GaussianSplatsPlugin.update(renderer, camera)` must run once per frame (the R3F
integration does this for you).

## Verification

```bash
# Unit tests (PLY parser + depth sorter)
pnpm exec vitest run --config packages/splats/vite.config.ts
```

Rendering is verified visually in the `splats/Gaussian Splats — Node Material`
WebGPU Storybook story (`pnpm exec nx storybook-webgpu`, port 4400).

## Attribution and licenses

MIT. This package ports or references the following (all MIT or permissive):

- **GPU radix sort** — ported from [PlayCanvas Engine](https://github.com/playcanvas/engine)'s
  portable multipass compute radix sort, which itself follows
  [kishimisu/WebGPU-Radix-Sort](https://github.com/kishimisu/WebGPU-Radix-Sort).
- **Octree LOD, budget balancing, and frustum culling** — ported from PlayCanvas
  Engine's unified gsplat pipeline.
- **SPZ decoding** — via the [`spz-js`](https://www.npmjs.com/package/spz-js)
  library, a JavaScript port of [Niantic's `spz`](https://github.com/nianticlabs/spz).
- **Spherical-harmonics evaluation** — follows the INRIA 3DGS reference and
  [mkkellogg/GaussianSplats3D](https://github.com/mkkellogg/GaussianSplats3D).
