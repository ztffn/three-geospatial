# Architecture

How `@takram/three-geospatial-splats` renders 3D Gaussian splats, and the design
decisions behind the WebGPU pipeline. Read alongside [`README.md`](./README.md).

## Data model

`GaussianSplatData` (the loaders' output, consumed by `GaussianSplatGeometry`):

| Field | Type | Notes |
| --- | --- | --- |
| `count` | number | Splat count. |
| `positions` | Float32Array | `count * 3`, splat-local space. |
| `scales` | Float32Array | `count * 3`, **log space** (apply `exp` before use). |
| `rotations` | Float32Array | `count * 4`, normalized quaternion, **WXYZ** order. |
| `colors` | Uint8Array | `count * 4` RGBA; alpha is opacity. RGB is the **DC term**. |
| `sh` | Float32Array? | View-dependent SH rest-coefficients (degrees 1–3), RGB-interleaved. |
| `shDegree` | 0\|1\|2\|3? | SH degree present. |

### Two conventions that bite

- **Coordinate flip (RDF→RUB).** SPZ/INRIA captures are right-down-forward; Three is
  right-up-back. `SpzSplatLoader` flips positions/rotations **and** flips the sign of
  each SH rest-coefficient per a fixed table (`SH_REST_FLIP_YZ`) — SH lobes must flip
  with the axes or view-dependent colour is mirrored.
- **Colour is in sRGB display space.** The 3DGS DC colour (`0.5 + SH_C0 * f_dc`) is an
  sRGB *display* value, not linear. The materials do all colour math (DC + SH, clamp)
  **in display space**, then convert sRGB→linear **once** at output so the renderer's
  linear→sRGB encode round-trips it. **Do not** set `colorSpace = sRGB` on the colour
  byte texture — that double-converts and crushes non-white toward black.

## Pipeline overview

Both render paths share the loaders, `GaussianSplatData`, `GaussianSplatGeometry`,
the sorters, and `GaussianSplatMesh`. They differ in the material and where work runs:

- **WebGL** (`GaussianSplatMaterial`): EWA projection in the vertex shader; depth sort
  on CPU/worker; per-frame index upload.
- **WebGPU** (`GaussianSplatNodeMaterial`): projection + SH colour in a compute
  pre-pass; ordering and culling are GPU/worker-driven. This is the path the rest of
  this document describes.

## Geometry → data textures

`GaussianSplatGeometry` uploads per-splat attributes into data textures (width 2048):

- `positionTexture` — RGBA32F: position.xyz + opacity.
- `covATexture` / `covBTexture` — RGBA32F: the 6 unique entries of the symmetric 3D
  covariance `Σ = M Mᵀ`, where `M = R · diag(exp(scale))` (rotation × exponentiated
  scales). Precomputed on the CPU at load.
- `colorTexture` — RGBA8 DC colour (raw bytes; see the sRGB note above).
- `shTexture` — RGBA8, one texel per SH coefficient, byte-quantized over a global
  `[min, max]` range (recovered in-shader via `shRangeMin` / `shRangeScale`). Width is
  padded to a multiple of 64 so each RGBA8 row is 256-byte-aligned (WebGPU
  `writeTexture` requirement).

The geometry is an `InstancedBufferGeometry`: one screen-aligned quad per splat, with
a per-vertex `quadOffset` (±2σ corners). `instanceCount` is set to the drawn count.

## Compute "prepare" pass

`GaussianSplatNodeMaterial.buildPrepare` runs one compute invocation per **active**
splat (`order[invocation]`, dispatched over the budget — not the whole cloud), and
writes a packed `splatStruct` per splat:

1. Load position/covariance/colour/SH texels.
2. EWA project: build the 2D screen covariance from `Σ` via the perspective Jacobian
   `J` and `W = transpose(mat3(modelView))`; eigen-decompose the 2×2 into major/minor
   ellipse axes (pixels), dilated by ~1px so sub-pixel splats stay visible.
3. NDC centre + depth (logarithmic when the renderer uses a log depth buffer, linear
   NDC otherwise).
4. Frustum-cull flag + a screen-space `lodSize` cull (collapse splats whose projected
   stddev is below a threshold → zero fragments).
5. View-dependent SH colour (DC + degrees 1–3 against the splat→camera direction),
   clamped, sRGB→linear.

Struct layout: `center` = vec4(ndc.xy, depth, validFlag); `axes` = vec4(major.xy,
minor.xy); `color` = vec4(linearRGB, opacity).

The vertex stage then does a single struct read + quad expand (collapsing culled
splats to a degenerate offscreen triangle). The fragment computes the Gaussian
falloff `exp(-quad·quad) · opacity`, multiplies the per-instance LOD fade, and emits
premultiplied-alpha "over".

**Prepare-on-active**: because the prepare reads `order[invocation]` and dispatches
over the active count, the projection cost tracks the *drawn* count (the LOD budget),
not the loaded count. Lowering the budget speeds up the whole frame, not just raster.

## GPU radix sort

`WebGpuRadixSort` is a raw-WebGPU port of PlayCanvas's portable multipass 4-bit radix
sort (histogram via workgroup atomics → hierarchical Blelloch scan → ranked scatter
with 256-bit bitmask + popcount; 8 passes for 32-bit keys; ping-pong buffers). It runs
on `renderer.backend.device`. `GpuSplatSorter` computes a per-splat key
(`key = ~bitcast<u32>(squaredDistance)` so an ascending sort yields farthest-first),
runs the sort, and writes the order **directly into the material's order storage
buffer** with `copyBufferToBuffer` — no CPU round-trip, no per-frame index upload.

Two non-obvious reasons it is raw WebGPU and multipass:

- **TSL cannot declare workgroup-shared atomic arrays** (`var<workgroup>
  array<atomic<u32>, N>`), which both the histogram and scatter kernels require. So the
  sort runs as raw WGSL on the shared device, not as TSL nodes.
- **PlayCanvas's OneSweep backend is NVIDIA-only** (it relies on forward-progress
  guarantees Apple GPUs do not provide). The portable multipass backend is the correct
  choice for Apple Silicon and is what PlayCanvas's `AUTO` selects there.

The sorted order bridges into the vertex via a `StorageInstancedBufferAttribute` (Three
creates it with `STORAGE | VERTEX | COPY_SRC | COPY_DST`, so `copyBufferToBuffer` into
it is valid). The vertex reads `order[instanceIndex] → splatId → prepared[splatId]`.

## Octree LOD

For multi-million-splat clouds, rasterizing every splat every frame is the dominant
cost (transparent overdraw). PlayCanvas bounds this with octree LOD; their LOD is a
**baked, offline** asset format. A flat SPZ/PLY has none, so this package builds the
equivalent **at load** and selects per frame:

- `SplatOctree` (load-time) — spatial subdivision into leaves (≤ `leafCapacity`); per
  leaf, splats are sorted by importance (`opacity × cbrt(scale volume)`) so LOD level
  `k` = the top `count / multiplier^k` (most important) splats.
- `SplatLodSelector` (per frame, three-free) — for each leaf: frustum-cull (plane–AABB
  test), pick a continuous LOD from camera distance via geometric bands
  (`lodBaseDistance · multiplier^i`), then **budget-balance** (coarsen the farthest
  leaves first until under the global splat budget). Gathers survivors, counting-sorts
  them back-to-front, and tags each with a **cross-fade**.
- `WorkerSplatLodSelector` (`SplatLodWorker.ts`) — runs the selector in a Web Worker
  (a Vite worker module). The octree is built once on the main thread, flattened
  (`octreeToFlat`), and shipped; the mesh awaits the async selection and uploads the
  order + fade on resolve. Keeps per-frame LOD/cull/sort off the render thread.

### Cross-fade (alpha, not dither)

When a leaf changes LOD level the "margin" splats (present at LOD `L` but not `L+1`)
fade out as the leaf nears the next band — so by the time it switches, they are already
~invisible (no pop). The fade scales coverage; it rides on the existing premultiplied
blend, so it is free. **Dither is the wrong tool here**: dither/`discard` fakes
transparency for *opaque* geometry, and `discard` defeats early-Z / tile hidden-surface
removal on Apple TBDR (measured 1–5 fps). This pipeline is already alpha-blended, so a
direct alpha fade is both cheaper and correct.

**Limitation:** the fade is stateless/distance-driven, so it is suppressed when the
*budget* (not distance) coarsens a leaf. A fade that is smooth even under a binding
budget needs persistent per-splat alpha + GPU stream-compaction + indirect draw
(PlayCanvas's work-buffer / interval-compaction stage), which is not yet ported.

## Device limits

`WebGPURenderer` requests the WebGPU **spec-minimum** device limits unless told
otherwise (128 MB storage-buffer binding, 256 MB max buffer, 8192 max 2D texture).
Multi-million-splat clouds exceed all three: the per-splat prepared struct buffer is
48 B/splat (192 MB at 4M, 400 MB at 8M), and the SH texture can exceed 8192 px. Pass
`requiredLimits` at renderer construction, set to the **adapter's** maxima:

```ts
const adapter = await navigator.gpu.requestAdapter()
const renderer = new WebGPURenderer({
  requiredLimits: {
    maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
    maxBufferSize: adapter.limits.maxBufferSize,
    maxTextureDimension2D: adapter.limits.maxTextureDimension2D
  }
})
```

(See `storybook-webgpu/src/components/WebGPUCanvas.tsx` for the reference.) Firefox's
WebGPU may not expose the hardware maxima; Chrome does.

## Blending and depth

- **Premultiplied "over"** (`CustomBlending`, `OneFactor` / `OneMinusSrcAlphaFactor`).
  Cheap on Apple TBDR; correct for sorted, back-to-front Gaussians.
- **`depthWrite` is off by default** (sort establishes order). The node material can opt
  in (`depthWrite: true`) so a deferred atmosphere/aerial-perspective post-pass treats
  splat pixels as scene geometry — without an `alphaTest` `discard`, which would tank
  TBDR. The cost is a faint depth fringe at quad corners.
- **`logarithmicDepthBuffer`** must match the renderer's setting so splats depth-test
  against a scene rendered with a log depth buffer.

## Known limitations / future work

- **Temporal cross-fade under budget** — see the cross-fade limitation above; needs the
  GPU work-buffer + interval-compaction stage (per-splat persistent alpha, stream
  compaction, indirect draw).
- **Octree build runs on the main thread at load** (~1–2 s for 8.3M splats). Could move
  to the worker.
- **Extraction note:** this package depends on `@takram/three-geospatial` (core) for a
  few utilities. A fully standalone open-source release would vendor or remove that
  dependency.
