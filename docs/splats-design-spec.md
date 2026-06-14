# Design Spec: `packages/splats` — `@takram/three-geospatial-splats`

> Status: Pre-implementation design. Do not implement until this spec is reviewed and approved.

---

## 0. Context

Render 3D Gaussian Splats (3DGS) within the three-geospatial monorepo, integrated with:
- The existing `3d-tiles-renderer` plugin architecture (tiles deliver splat content via `KHR_gaussian_splatting` glTF extension)
- The project's WebGPU TSL node material system
- The existing `GeometryPass` / MRT post-processing pipeline for depth compositing

### Key render-state decisions (derived from CesiumJS source analysis)
- `depthTest.enabled = true` — splats read the opaque depth buffer so meshes correctly occlude them
- `depthMask = false` — splats never write depth; correct sort order is handled by the sorter
- `blending = PRE_MULTIPLIED_ALPHA_BLEND`
- `cull.enabled = false` — screen-aligned quads have no meaningful backface
- Dedicated render pass AFTER opaque geometry (`renderOrder = 2`), BEFORE translucent

---

## 1. Package Scaffold

### 1.1 Directory Tree

```
packages/splats/
├── src/
│   ├── index.ts                         # Main entry
│   ├── r3f/
│   │   ├── index.ts
│   │   └── GaussianSplats.tsx           # R3F component
│   ├── webgpu/
│   │   ├── index.ts
│   │   └── GaussianSplatNode.ts         # TSL node material path
│   ├── GaussianSplatData.ts             # Buffer layouts and data model
│   ├── GaussianSplatGeometry.ts         # BufferGeometry subclass
│   ├── GaussianSplatMesh.ts             # Mesh subclass
│   ├── GaussianSplatMaterial.ts         # WebGL ShaderMaterial path
│   ├── GaussianSplatSorter.ts           # Sorter interface + JS fallback
│   ├── GaussianSplatSorterWASM.ts       # Optional WASM sort path
│   ├── KhrGaussianSplattingExtension.ts # GLTFLoader extension
│   ├── GaussianSplatsPlugin.ts          # 3d-tiles-renderer plugin
│   ├── PLYSplatLoader.ts                # Standalone .ply parser (Phase 1)
│   └── SPZLoader.ts                     # SPZ decompression wrapper
├── project.json
├── package.json
├── vite.config.ts
├── tsconfig.json
├── tsconfig.lib.json
└── tsconfig.spec.json
```

### 1.2 `package.json`

```json
{
  "name": "@takram/three-geospatial-splats",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": {
      "types": "./types/index.d.ts",
      "import": "./build/index.js",
      "require": "./build/index.cjs"
    },
    "./r3f": {
      "types": "./types/r3f/index.d.ts",
      "import": "./build/r3f.js",
      "require": "./build/r3f.cjs"
    },
    "./webgpu": {
      "types": "./types/webgpu/index.d.ts",
      "import": "./build/webgpu.js",
      "require": "./build/webgpu.cjs"
    }
  },
  "main": "./build/index.cjs",
  "module": "./build/index.js",
  "types": "./types/index.d.ts",
  "files": ["build", "src", "types", "package.json"],
  "dependencies": {
    "@takram/three-geospatial": "0.8.0",
    "tiny-invariant": "^1.3.3"
  },
  "peerDependencies": {
    "3d-tiles-renderer": ">=0.4.23",
    "@react-three/fiber": ">=9.0.4",
    "react": ">=19.0",
    "three": ">=0.170.0"
  },
  "peerDependenciesMeta": {
    "3d-tiles-renderer": { "optional": true },
    "@react-three/fiber": { "optional": true },
    "react": { "optional": true }
  },
  "publishConfig": { "access": "public" }
}
```

### 1.3 `vite.config.ts`

Clone `packages/effects/vite.config.ts`, changing:
- `cacheDir`: `'../../node_modules/.vite/packages/splats'`
- `lib.entry`: add `'build/webgpu': 'src/webgpu/index.ts'`
- `lib.name`: `'splats'`
- `external`: add `'3d-tiles-renderer'` and `/^3d-tiles-renderer\//`
- `test.name`: `'splats'`
- Output/types dirs updated to `packages/splats`

### 1.4 `project.json`

```json
{
  "name": "splats",
  "$schema": "../../node_modules/nx/schemas/project-schema.json",
  "sourceRoot": "packages/splats/src",
  "projectType": "library",
  "tags": ["type:lib"],
  "targets": {
    "build": { "dependsOn": ["typecheck"] }
  }
}
```

### 1.5 Root config additions

**`tsconfig.base.json`** — add path aliases:
```json
"@takram/three-geospatial-splats": ["./packages/splats/src/index.ts"],
"@takram/three-geospatial-splats/r3f": ["./packages/splats/src/r3f/index.ts"],
"@takram/three-geospatial-splats/webgpu": ["./packages/splats/src/webgpu/index.ts"]
```

**`nx.json`** — add `"splats"` to `release.projects`.

---

## 2. Data Model

### 2.1 `GaussianSplatData` — Buffer Layouts

Per-splat attributes from the `KHR_gaussian_splatting` glTF extension:

| Accessor | Type | Floats/splat | Notes |
|---|---|---|---|
| `POSITION` | VEC3/FLOAT | 3 | Center in local space |
| `_SCALE` | VEC3/FLOAT | 3 | Log-space (apply `exp()` before use) |
| `_ROTATION` | VEC4/FLOAT | 4 | Quaternion, WXYZ order, normalized |
| `COLOR_0` | VEC4/UBYTE normalized | 1 (packed) | RGBA; alpha = opacity |
| `_SH_0`…`_SH_14` | VEC3/FLOAT × 0–15 | 0–45 | Spherical harmonics (optional) |

**Footprint:**
- No SH: 14 floats = 56 bytes/splat
- Degree-3 SH: 59 floats = 236 bytes/splat

```typescript
interface GaussianSplatData {
  count: number
  positions: Float32Array   // count × 3
  scales: Float32Array      // count × 3, log-scale
  rotations: Float32Array   // count × 4, WXYZ normalized
  colors: Uint8Array        // count × 4, RGBA
  sh?: Float32Array         // count × (3 | 12 | 48)
  shDegree?: 0 | 1 | 2 | 3
}
```

### 2.2 `GaussianSplatGeometry extends BufferGeometry`

Unit quad base (4 verts, 6 indices) + per-splat instanced attributes:

```typescript
// Base quad corner offsets (non-instanced)
setAttribute('quadOffset', new BufferAttribute(
  new Float32Array([-1,-1, 1,-1, 1,1, -1,1]), 2
))
setIndex([0, 1, 2, 0, 2, 3])

// Per-splat (instanced)
setAttribute('splatPosition', new InstancedBufferAttribute(Float32Array, 3))
setAttribute('splatScale',    new InstancedBufferAttribute(Float32Array, 3))
setAttribute('splatRotation', new InstancedBufferAttribute(Float32Array, 4))
setAttribute('splatColor',    new InstancedBufferAttribute(Uint8Array, 4, /*normalized*/ true))
setAttribute('splatSH',       new InstancedBufferAttribute(Float32Array, shComponents)) // optional
```

### 2.3 `GaussianSplatMesh` — Why `InstancedBufferGeometry`, Not `Points`

`Points` is rejected: point sprites can't expand into arbitrarily oriented elliptical quads without a geometry shader. The vertex shader needs to output 4 distinct clip-space positions per splat (the covariance-projected quad corners), which requires instanced quads.

`InstancedMesh` with instanced buffer attributes is the correct approach. The `instanceMatrix` uniform is set to identity for all instances (position/orientation are encoded in custom attributes).

```typescript
class GaussianSplatMesh extends InstancedMesh {
  frustumCulled = false   // manual per-tile culling via tile visibility
  renderOrder = 2
  // material: GaussianSplatMaterial (WebGL) or GaussianSplatNodeMaterial (WebGPU)
}
```

---

## 3. Sort System

### 3.1 `GaussianSplatSorter` Interface

```typescript
interface GaussianSplatSorter {
  sort(
    positions: Float32Array,    // count × 3, splat positions in local space
    cameraPosition: Vector3,    // camera in mesh local space
    count: number
  ): Promise<Uint32Array> | Uint32Array  // sorted indices (draw order → splat index)

  dispose(): void
}
```

Three implementations, in order of priority:

| # | Implementation | Phase | Notes |
|---|---|---|---|
| 1 | `CPUSorter` | 1 | JS typed radix sort, main thread. Fine for ≤200k splats. |
| 2 | `WebWorkerSorter` | 2 | Same sort in Worker + transferable ArrayBuffers. Reference: existing worker pool in `storybook-webgpu/src/worker/`. |
| 3 | `WebGPUSorter` | 3 | Compute-shader radix sort via TSL `ComputeNode`. Reference: `ScreenSpaceShadowNode.ts`. |

### 3.2 Re-sort Threshold

Re-sort when camera moves more than 0.5° from last sort position (same threshold as CesiumJS):

```typescript
needsSort(currentPos: Vector3): boolean {
  return this.lastSortPosition.angleTo(currentPos) > Math.PI / 360
}
```

### 3.3 Sorted Indices → GPU

**WebGL**: Rewrite `geometry.index` buffer after each sort:
```typescript
geometry.index = new BufferAttribute(sortedIndices, 1)
geometry.index.needsUpdate = true
```

**WebGPU**: Write sorted indices to a `StorageBuffer`; read in vertex shader via `storage(indexBuffer, 'uint')`. Avoids CPU→GPU stall.

Do NOT reorder attribute data on the CPU — that would require O(n) copies per frame.

---

## 4. Material / Shader Design

### 4.1 `GaussianSplatMaterial` — WebGL Path (`ShaderMaterial`)

**Uniforms:**
```glsl
uniform sampler2D depthTexture;  // opaque depth from GeometryPass
uniform vec2 resolution;
uniform vec2 focal;              // (fx, fy) from camera intrinsics
```

**Vertex shader — 2D covariance projection (Zwicker 2002 / Keselman adaptation):**

```glsl
// 1. Build 3D covariance: Sigma = R * S^2 * R^T
mat3 R = quatToMat(splatRotation);       // from quaternion attribute
vec3 s = exp(splatScale);                // un-log the scale
mat3 S = mat3(s.x,0,0, 0,s.y,0, 0,0,s.z);
mat3 Sigma = R * S * transpose(S) * transpose(R);

// 2. Project to 2D: Sigma2D = J * W * Sigma * W^T * J^T
vec4 posView = modelViewMatrix * vec4(splatPosition, 1.0);
// (clamp posView.xy to avoid artifacts at frustum edges)
mat3 J = /* Jacobian of projective transform at posView */;
mat3 W = mat3(modelViewMatrix);
mat3 cov2D = transpose(W * J) * Sigma * (W * J);

// 3. Eigen-decompose cov2D upper-left 2×2 → v1, v2 (screen-space axes)
float a = cov2D[0][0], b = cov2D[0][1], c = cov2D[1][1];
// ... eigenvalue formula ...
vec2 v1 = normalize(vec2(b, lambda1-a)) * sqrt(lambda1);
vec2 v2 = normalize(vec2(b, lambda2-a)) * sqrt(lambda2);

// 4. Expand quad corner in screen space (3σ coverage)
vec2 clipPos = (projectionMatrix * posView).xy / (projectionMatrix * posView).w;
clipPos += quadOffset.x * v1 / (resolution * 0.5)
         + quadOffset.y * v2 / (resolution * 0.5);
gl_Position = vec4(clipPos, depth, 1.0);
```

**Fragment shader:**
```glsl
float r2 = dot(vUV, vUV);
if (r2 > 9.0) discard;                        // outside 3σ

// Read opaque depth and occlude
float opaqueDepth = texture2D(depthTexture, gl_FragCoord.xy / resolution).r;
if (gl_FragCoord.z > opaqueDepth) discard;

float alpha = vColor.a * exp(-0.5 * r2);
if (alpha < 1.0/255.0) discard;
gl_FragColor = vec4(vColor.rgb * alpha, alpha); // pre-multiplied
```

**Blend state:**
```typescript
blending = CustomBlending
blendSrc = OneFactor                 // pre-multiplied: src already has alpha baked in
blendDst = OneMinusSrcAlphaFactor
depthTest = true
depthWrite = false
transparent = true
side = DoubleSide
```

### 4.2 `GaussianSplatNodeMaterial` — WebGPU TSL Path

Extends `MeshBasicNodeMaterial` (no PBR lighting needed — splats carry their own radiance via SH).

```typescript
class GaussianSplatNodeMaterial extends MeshBasicNodeMaterial {
  static override get type() { return 'GaussianSplatNodeMaterial' }

  depthTextureNode: TextureNode | null = null

  constructor() {
    super()
    this.depthWrite = false
    this.depthTest = true
    this.transparent = true
    // same CustomBlending as WebGL path

    this.positionNode = this.buildPositionNode()    // covariance expansion in clip space
    this.outputNode   = this.buildOutputNode()      // alpha + depth occlude + pre-mult
  }
}
```

TSL helper functions mirror the GLSL math above, using `FnLayout`/`FnVar` pattern from `packages/core/src/webgpu/` (see `GaussianBlurNode.ts` for reference).

**⚠ Risk**: It is unclear whether `positionNode` gives enough control in clip space for the covariance expansion. May require a full `vertexNode` or WGSL injection — must prototype this first.

---

## 5. glTF Loader Extension

### 5.1 `KHR_gaussian_splatting` glTF Schema

```json
{
  "primitives": [{
    "extensions": {
      "KHR_gaussian_splatting": { "type": "splat" },
      "KHR_gaussian_splatting_compression_spz": { "bufferView": 5 }
    },
    "attributes": {
      "POSITION": 0, "_SCALE": 1, "_ROTATION": 2, "COLOR_0": 3, "_SH_0": 4
    }
  }]
}
```

The `KHR_gaussian_splatting` marker signals this primitive is a splat. Data lives in standard accessors. The `_compression_spz` variant references a buffer view of raw SPZ bytes instead.

### 5.2 `KhrGaussianSplattingExtension` — Three.js GLTFLoader Plugin

```typescript
export class KhrGaussianSplattingExtension {
  readonly name = 'KHR_gaussian_splatting'
  parser: GLTFParser

  constructor(parser: GLTFParser) { this.parser = parser }

  async extendMeshPrimitive(meshDef, primitiveDef): Promise<Object3D> {
    // Check for SPZ compression first
    const spzExt = primitiveDef.extensions?.KHR_gaussian_splatting_compression_spz
    if (spzExt != null) {
      const buffer = await this.parser.getDependency('bufferView', spzExt.bufferView)
      const data = await this.spzLoader.decode(buffer)
      return new GaussianSplatMesh(new GaussianSplatGeometry(data), new GaussianSplatMaterial(), data)
    }

    // Standard accessor path
    const [positions, scales, rotations, colors] = await Promise.all([
      this.parser.getDependency('accessor', primitiveDef.attributes.POSITION),
      this.parser.getDependency('accessor', primitiveDef.attributes._SCALE),
      this.parser.getDependency('accessor', primitiveDef.attributes._ROTATION),
      this.parser.getDependency('accessor', primitiveDef.attributes.COLOR_0),
    ])
    const data: GaussianSplatData = { count: positions.count, positions, scales, rotations, colors }
    return new GaussianSplatMesh(new GaussianSplatGeometry(data), new GaussianSplatMaterial(), data)
  }
}
```

Registration: `loader.register(parser => new KhrGaussianSplattingExtension(parser))`

### 5.3 `PLYSplatLoader` (Phase 1 standalone)

```typescript
export class PLYSplatLoader extends Loader {
  // Parses community-standard .ply files with properties:
  //   x, y, z, scale_0..2, rot_0..3, opacity, f_dc_0..2, f_rest_0..44
  async loadAsync(url: string): Promise<GaussianSplatMesh>
}
```

---

## 6. 3d-tiles-renderer Plugin

### 6.1 `GaussianSplatsPlugin` Full Interface

```typescript
export class GaussianSplatsPlugin {
  tiles?: TilesRenderer
  private tileSplatMeshes = new Map<string, GaussianSplatMesh>()

  init(tiles: TilesRenderer): void {
    this.tiles = tiles
    // Auto-register GLTF extension into GLTFExtensionsPlugin:
    const gltfPlugin = tiles.getPluginByType(GLTFExtensionsPlugin)
    gltfPlugin?.register(parser => new KhrGaussianSplattingExtension(parser))
    tiles.addEventListener('load-model', this.handleLoadModel)
    tiles.addEventListener('dispose-model', this.handleDisposeModel)
  }

  async processTileModel(scene: Object3D, tile: Tile): Promise<void> {
    scene.traverse(obj => {
      if (obj instanceof GaussianSplatMesh) {
        obj.renderOrder = this.renderOrder
        obj.sorter = new WebWorkerSorter()
        this.tileSplatMeshes.set(tile.key, obj)
      }
    })
  }

  update(camera: Camera): void {
    for (const [, mesh] of this.tileSplatMeshes) mesh.updateSort(camera)
  }

  private handleDisposeModel = ({ scene }) => {
    scene.traverse(obj => {
      if (obj instanceof GaussianSplatMesh) {
        obj.sorter.dispose()
        obj.geometry.dispose()
        obj.material.dispose()
      }
    })
  }

  dispose(): void {
    this.tiles?.removeEventListener('load-model', this.handleLoadModel)
    this.tiles?.removeEventListener('dispose-model', this.handleDisposeModel)
  }
}
```

### 6.2 Registration Order (Critical)

`GLTFExtensionsPlugin` must be registered before `GaussianSplatsPlugin` so it exists when `init()` calls `getPluginByType()`:

```typescript
tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader }))  // FIRST
tiles.registerPlugin(new GaussianSplatsPlugin())                  // SECOND
```

### 6.3 Sort Buffers

**Per-tile sorters** — each `GaussianSplatMesh` gets its own `GaussianSplatSorter`. Rationale: tiles load/unload independently; a shared sorter would need to track tile membership. Worker pool dispatch is tile-parallel.

### 6.4 Memory Management

`dispose-model` disposes all GPU resources (`geometry.dispose()`, `material.dispose()`, `sorter.dispose()`). No custom LRU needed — 3d-tiles-renderer manages tile lifecycle.

---

## 7. R3F Component API

### 7.1 Standalone `<GaussianSplats>` (Phase 1)

```typescript
interface GaussianSplatsProps {
  url?: string                    // .ply or .spz file
  data?: GaussianSplatData        // or pass pre-parsed data
  depthTextureNode?: TextureNode  // WebGPU: opaque depth from passNode
  renderOrder?: number            // default 2
  sortInterval?: number           // ms, default 100
  position?: Vector3Like
  rotation?: EulerLike
  scale?: Vector3Like | number
}
```

Internally: detects WebGPU vs WebGL renderer, creates the appropriate material, wires depth texture.

### 7.2 Tiled `<TilesPlugin plugin={GaussianSplatsPlugin}>` (Phase 2)

```tsx
<TilesRenderer>
  <TilesPlugin plugin={GLTFExtensionsPlugin} />
  <TilesPlugin plugin={GaussianSplatsPlugin} args={{ renderOrder: 2 }} />
  <TilesPlugin plugin={UpdateOnChangePlugin} />
</TilesRenderer>
```

Sort updates driven from `useFrame` via a companion `<GaussianSplatsUpdater plugin={plugin} />` component (or built into the plugin's R3F wrapper).

---

## 8. Depth Compositing with the Existing Pipeline

### 8.1 Render Order Summary

| Pass | Object | renderOrder |
|---|---|---|
| Opaque (geometry, terrain, tiles) | mesh materials | 0 |
| **Splats** | GaussianSplatMesh | **2** |
| Translucent / post-processing | effects chain | — |

### 8.2 WebGL Path

After the opaque pass, `inputBuffer.depthTexture` holds the opaque scene depth.
`GaussianSplatMaterial` receives it as a uniform before draw:

```typescript
splatMesh.material.uniforms.depthTexture.value = inputBuffer.depthTexture
```

Fragment shader discards splat fragments that are behind opaque geometry:
```glsl
float opaqueDepth = texture2D(depthTexture, gl_FragCoord.xy / resolution).r;
if (gl_FragCoord.z > opaqueDepth) discard;
```

This requires a separate `SplatRenderPass` that runs *after* `GeometryPass`.

### 8.3 WebGPU Path

`passNode.getTextureNode('depth')` is already available after the MRT scene pass. Wire it into the material:

```typescript
splatMesh.material.depthTextureNode = passNode.getTextureNode('depth')
```

The `outputNode` in `GaussianSplatNodeMaterial` samples it and discards behind-depth fragments before the Gaussian alpha contribution.

Since splats have `renderOrder = 2`, Three.js draws them after `renderOrder = 0` opaques within the same `pass()` call — the opaque depth is already written when splats execute.

### 8.4 TAA Considerations

- Static splats have zero velocity → correct `highpVelocity` output (zero).
- **Ghosting risk on re-sort**: When sort order changes significantly, TAA history becomes stale. Mitigation options:
  1. Flag re-sort frames and suppress history accumulation for splat pixels that frame
  2. Accept ghosting (1–2 frame decay at 100ms sort interval is barely visible)
- **Recommendation**: Skip TAA wiring for Phase 1 stories. Prototype in Phase 2.

---

## 9. SPZ Decoder

### 9.1 Options

| Option | Pros | Cons |
|---|---|---|
| A: npm package (`spz` / `@niantic/spz`) | Zero bundler config, TS types | May not exist yet — check at impl time |
| B: Niantic WASM (`github.com/nianticlabs/spz`) | Official, high-fidelity | Needs `assetsInclude: ['**/*.wasm']` in vite.config |
| C: Pure TS reimplementation | No native deps | ~500 LOC, maintenance burden |

**Recommendation: Option B** with a clean abstraction:

```typescript
export class SPZLoader {
  private decoder?: SPZWasmModule

  async init(wasmUrl: string): Promise<void> {
    this.decoder = await loadSPZWasm(wasmUrl)
  }

  decode(buffer: ArrayBuffer): GaussianSplatData { ... }
}
```

`SPZLoader` is injected into `KhrGaussianSplattingExtension` via constructor — no global singleton (per CLAUDE.md: no fallback systems).

---

## 10. Storybook Story Plan

### 10.1 Phase 1: Local PLY File

`storybook-webgpu/src/splats/GaussianSplats-Basic.tsx`

Follows the same pattern as `3DTilesRenderer-PostProcessLighting.tsx`:
- `pass(scene, camera).setMRT(mrt({ output, velocity }))` for the scene
- Splat mesh in the same scene at `renderOrder = 2`
- `depthNode = passNode.getTextureNode('depth')` wired into material
- TAA disabled initially (samples: 0)
- Leva controls: sort interval slider, splat count display

```tsx
<WebGPUCanvas>
  <GaussianSplats url="/assets/splats/garden.ply" />
</WebGPUCanvas>
```

Test asset: `storybook-webgpu/assets/splats/garden.ply` (tracked via Git LFS).
Source: public 3DGS research datasets (Mip-NeRF 360 "garden" scene — commonly used for benchmarks).

### 10.2 Phase 2: 3D Tiles Tiled Splats

`storybook-webgpu/src/splats/GaussianSplats-3DTiles.tsx`

```tsx
<TilesRenderer url={tilesUrl}>
  <TilesPlugin plugin={CesiumIonAuthPlugin} args={{ apiToken, assetId }} />
  <TilesPlugin plugin={GLTFExtensionsPlugin} />
  <TilesPlugin plugin={GaussianSplatsPlugin} args={{ renderOrder: 2 }} />
  <TilesPlugin plugin={TilesFadePlugin} />
  <TilesPlugin plugin={UpdateOnChangePlugin} />
</TilesRenderer>
```

With atmosphere and globe base layer as background (existing `Globe` component unchanged).

---

## 11. Open Questions and Risks

These must be resolved by prototyping before or during implementation. No assumptions have been made about their answers.

1. **`positionNode` clip-space control in TSL.** The covariance expansion must happen in clip space, not local/world space. Whether overriding `positionNode` on `NodeMaterial` gives clip-space control, or whether a full `vertexNode` override (or WGSL injection) is needed, must be tested. This is the single highest-risk unknown.

2. **Depth read during the same render pass (WebGL).** Reading the opaque depth buffer while rendering the splat pass requires that the opaque pass has already completed and its depth texture is available. Confirm that `renderOrder = 2` within a single `WebGLRenderer.render()` call is sufficient, vs. needing a full second render target and pass.

3. **`GLTFExtensionsPlugin.register()` API at v0.4.23.** Verify the exact method to register a GLTF extension into `GLTFExtensionsPlugin`. The `Globe.tsx` usage only shows constructor options (`{ dracoLoader }`), not extension registration. Check `3d-tiles-renderer@0.4.23` source for this API.

4. **`TilesFadePlugin` + `GaussianSplatNodeMaterial` `outputNode` conflict.** `TilesFadePlugin` overwrites `material.outputNode` in `wrapFadeNodeMaterial.ts`. If `GaussianSplatNodeMaterial` also sets `outputNode`, the two will conflict. Need a node-chaining strategy rather than assignment.

5. **`InstancedMesh` with dummy `instanceMatrix`.** Three.js `InstancedMesh` may apply frustum culling or sorting based on `instanceMatrix`. Using identity matrices for all instances while encoding actual positions in custom attributes may trigger unexpected behavior. A plain `Mesh` with `InstancedBufferGeometry` and a manual draw call might be cleaner.

6. **TAA ghosting on re-sort events.** Severity is unknown until tested at realistic splat counts and camera speeds. Mitigation strategy TBD.

7. **SPZ npm package availability.** Check `npm info spz` and `npm info @niantic/spz` before committing to Option B WASM.

8. **`KHR_gaussian_splatting` spec stability.** Attribute names (`_SCALE`, `_ROTATION`, etc.) are from the draft spec. Cross-reference against actual tiled splat data before finalising the parser — real datasets may differ.

9. **SH evaluation: GPU vs CPU.** Passing per-fragment view direction as a `varying vec3` and evaluating SH in the fragment shader adds complexity. For degree-3 SH (45 floats/splat), CPU evaluation + per-splat `varying vec3 color` is simpler. Tradeoff: CPU evaluation needs re-upload when view changes; GPU evaluation avoids upload but adds shader complexity.

10. **Sort update index buffer GPU stall (WebGL).** Updating `geometry.index.needsUpdate = true` every sort triggers a full buffer re-upload. Measure the stall at 100k, 500k, 1M splats. May require a `StreamDrawUsage` hint on the index buffer.

---

## 12. Critical Reference Files

| File | Purpose |
|---|---|
| `packages/effects/vite.config.ts` | Canonical vite config template to clone |
| `packages/core/src/webgpu/ScreenSpaceShadowNode.ts` | Best reference for WebGPU `StorageBuffer` + `ComputeNode` sort |
| `packages/core/src/webgpu/GaussianBlurNode.ts` | TSL node pattern: `FnLayout`, `FnVar`, `TempNode` extension |
| `storybook-webgpu/src/plugins/fade/wrapFadeNodeMaterial.ts` | Closest parallel to splat material wrapping; verify `outputNode` compatibility |
| `storybook-webgpu/src/plugins/fade/TilesFadePlugin.ts` | 3d-tiles plugin lifecycle pattern for material-mutating plugins |
| `storybook-webgpu/src/components/Globe.tsx` | Exact `GLTFExtensionsPlugin` registration order + `TilesPlugin` R3F pattern |
| `storybook-webgpu/src/atmosphere/3DTilesRenderer-PostProcessLighting.tsx` | MRT `pass()` + `passNode.getTextureNode('depth')` wiring pattern |
| `packages/core/src/webgpu/TemporalAntialiasNode.ts` | TAA integration; understand before adding velocity to splats |
| `tsconfig.base.json` | Must add `@takram/three-geospatial-splats` aliases here |
