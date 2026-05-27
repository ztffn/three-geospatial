# WaterPro → TSL Port Status

Living document. Tracks what's been ported from the decompiled WaterPro reference into this package, the architectural decisions taken along the way, and what's still missing for 1:1 visual parity.

## Source of truth

The decompiled WaterPro JavaScript is in:

```
packages/ocean-ifft/tools/waterpro-decoder/
├── waterpro-shaders.wasm        # original (opaque) shader VM
├── waterpro-shaders.wat         # disassembled WASM (math NOT extractable)
├── decode-opcodes.py            # decoder script
├── extract-wasm.py
├── depth-pass-decoded.js        # JS-level decoded reference
└── full-shader-decoded.js       # JS-level decoded reference (PRIMARY)
```

Memory note (carried across sessions): **"WASM shader math not extractable"** — the per-program inner math lives in the WASM and was not recoverable. What IS recoverable is the JS-level pipeline structure: class definitions, uniform defaults, input/output signatures, and how programs are composed. All ports inferred the per-program math from the input list + uniform names + how the outputs are consumed downstream.

WaterPro programs are addressed by integer: `wB(n, inputs, uniforms) → outputs`. The decompiled `full-shader-decoded.js` contains the class wrappers for each program (`_F`, `EF`, `BF`, `PF`, etc.) and the composition class `AF`. The full registry of programs we identified:

| Program | Class | Purpose | Status |
|--------:|------|---------|--------|
| 0       | (anonymous) | Screen-space reflection (SSR) | Not ported |
| 1       | `OF`  | Sun glow / sparkle | ✅ Ported |
| 2       | `MF`  | Fresnel + distance fade | ✅ Ported |
| 3       | `NF`  | Subsurface scattering | ✅ Ported |
| 4       | `_F`  | Water color (deep/shallow + waterColumnDepth) | ✅ Ported |
| 5       | `EF`  | Surface foam | ✅ Ported |
| 6       | `BF`  | Shoreline foam | ✅ Ported |
| 7       | `PF`  | Wave foam / turbulent foam (Jacobian eigenvalues) | ✅ Ported |
| 10      | (anonymous) | Sun-shaft compositor / final output | Not ported |
| 11      | `TF`  | Turbulent foam from normal divergence | ✅ Ported |
| 12      | `DF`  | Wake foam | Not ported |

Non-program composition classes:
| Class | Purpose | Status |
|-------|---------|--------|
| `SF`  | Cascade simulation interface (sampleDisplacement / sampleNormals) | ✅ Ported as `WaveSimulation` |
| `yF`  | CPU-side wave sampler (height-probe for buoyancy) | Not ported |
| `AF`  | Foam compositor (`AF.build()`) | ✅ Ported as `combineFoamNode` |
| `CF`  | Displacement scale / visualisation mode controls | Partial (not exposed via Storybook) |
| `GF`  | Main material composer | Not directly ported — replicated structurally in `WaterproDepthDemo-Story.tsx` |
| `zF`  | Waterline highlight (meniscus) | Not ported |

## Ported components

All ports live under `packages/ocean-ifft/src/waterpro/`:

```
waterpro/
├── index.ts                       # public barrel
├── PORT-STATUS.md                 # this document
├── waves/
│   ├── wave-defaults.ts           # Phillips spectrum + 3-cascade defaults
│   ├── wave-cascade.ts            # single IFFT cascade pipeline (reuses existing WGSL kernels)
│   ├── wave-simulation.ts         # SF — manages cascades + butterfly buffer
│   ├── wave-sampler.ts            # TSL nodes that summed-sample displacement, normals, eigenvalues
│   └── gerstner.ts                # Gerstner overlay (golden-angle phases, AF normal+folding blend)
└── nodes/
    ├── water-color.ts             # program 4 (_F) — deep/shallow water + waterColumnDepth + isObjectInFront + isDynamic
    ├── surface-foam.ts            # program 5 (EF) — world-space tiled noise foam
    ├── shoreline-foam.ts          # program 6 (BF) — wcd-gated foam ring
    ├── wave-foam.ts               # program 7 (PF) — Jacobian-eigenvalue crest mask + textured detail
    ├── turbulent-foam.ts          # program 11 (TF) — normal divergence foam
    ├── fresnel-distance.ts        # program 2 (MF) — Schlick fresnel + distance fade
    ├── sub-surface-scattering.ts  # program 3 (NF) — sun back-scatter
    ├── sparkle.ts                 # program 1 (OF) — sun glint
    └── combine-foam.ts            # AF.build() compositor
```

### IFFT cascade simulation (`waves/`)

- **3 cascades** at length scales `[250 m, 17 m, 5 m]` (matches `wave-constants.LENGTH_SCALES`).
- **256² resolution per cascade** (configurable).
- Reuses the existing IFFT WGSL kernels at `resources/shader/IFFT/*.js` — the math is identical to WaterPro's WASM IFFT (standard Tessendorf inverse FFT), so no need to re-implement.
- **Two superposed Phillips spectra per cascade** (primary swell + secondary cross-swell) — exact transcription of `FIRST_WAVE_DATASET` / `SECOND_WAVE_DATASET` from `wave-constants.js`.
- Each cascade exposes three storage textures: `displacement` (RGBA HalfFloat), `derivative` (RGBA HalfFloat), `jacobian` (R32Float; stores **turbulence**, *low at crests*).
- `WaveSimulation.update(dt, t)` runs the full per-frame pipeline (time-evolved spectrum → IFFT ×4 channels → permute → texture merge).

### Gerstner overlay (`gerstner.ts`)

Direct port of `evaluateGerstnerCPU` from `full-shader-decoded.js` line 98.

- Storage buffer layout exactly matches: `[2i] = (dirX, dirZ, amp, λ)`, `[2i+1] = (steepness, phase, ω, 0)`.
- Setup math: `k = 2π/λ`, `ω = √(g·k)`, `phase = 137.5°·i mod 2π` (golden-angle scatter).
- `GerstnerOverlay.evaluate(worldXZ, time)` returns `{ displacement, normal, folding }` via two TSL `Fn` + `Loop` kernels (one for displacement, one for normal+folding).
- Blended with cascade output per the decompiled line-161 formula: `normal = normalize(cascadeN + gerstnerN with y−1)`, `eigen0 −= folding`.

### Foam compositor (`combine-foam.ts`)

Direct math port of `AF.build()` from `full-shader-decoded.js` line 98 (compositing block):

```
F = clamp(S + M + P, 0, 1)               // total foam strength
D = fresnel · (1 − F·0.8)                  // effective fresnel
k = 1 − isObjectInFront
I = F · k                                  // combinedFoamStrength
L = S + M + 1e-4
U = S / L                                  // surface/wave ratio
O = mix(C_wave, T_surface, U)              // weighted color blend
z = P / (F + 1e-4)
V = mix(O, B_wake, z)                      // wake on top
G = k · (1 − isDynamic)
```

Outputs: `{ combinedFoamColor, combinedFoamStrength, earlyFoamStrength, shorelineFoamStrength, shorelineZoneMask, shorelineFoamTint, effectiveFresnel }`.

### Per-program nodes (`nodes/`)

Each TSL node mirrors the corresponding `wB(n, ...)` signature and uniform list. Defaults are transcribed from the decompiled class field initializers. Where the WASM math is opaque the implementation infers from:
- Input/output signature
- Uniform names (e.g. `focusPower` → specular exponent)
- How outputs are consumed in `AF.build()` / `GF` composition
- Standard ocean-shader literature (Schlick fresnel, Phong glint, etc.)

## Demos

### Storybook (`ocean/WaterPro Depth Demo`)

File: `storybook-webgpu/src/ocean/WaterproDepthDemo-Story.tsx`

The reference demo. Has all WaterPro features wired with Storybook controls in categorised slider/toggle panels:
- **Toggles**: skyReflection, sss, sparkle, surfaceFoam, waveFoam, turbulentFoam, shorelineFoam, distanceFade
- **Fresnel / Sparkle / SSS / Surface / Wave / Shoreline / Turbulent / Water color / Distance fade** sliders

Scene contents:
- 80×80 m segmented ocean plane (256×256 verts) with IFFT + Gerstner displacement
- A tilted box (foam-falloff visualisation: above-water → deep underwater)
- A vertical capsule probe (waterline foam check)
- Cubemap sky from `resources/textures/cube/sky/*.jpg` (sRGB color space — required, JPGs are sRGB)

Toggles drive uniform `enabled` values on each node; the TSL graph is compiled exactly once and `useTransientControl` updates uniform values without rebuilding.

### Storybook (`ocean/WaterPro Atmosphere`)

File: `storybook-webgpu/src/ocean/WaterproAtmosphere-Story.tsx`

Sibling of the depth demo — **does not replace it**. Same scene contents (plane + tilted box + capsule probe), but mounted with `AtmosphereContextNode`:

- **Sun direction** comes from `atmosphereContext.sunDirectionECEF` transformed via inverted `matrixWorldToECEF` (matches `OceanChunks.tsx:234-239`). The local demo has identity ECEF↔world so the transform is a no-op; kept for parity with the globe-scale code path.
- **PBR IBL / environment node**: `scene.environmentNode = skyEnvironment(context)`. This is **load-bearing**: it both (a) provides IBL ambient to `MeshStandardNodeMaterial` so the ocean isn't pitch black at low sun angles, and (b) drives `SkyEnvironmentNode.updateBefore` so the atmosphere's cube render target stays current (used by the debug sphere; available for future use).
- **In-shader sky reflection** samples a **static sRGB JPG cubemap** (`resources/textures/cube/sky/*.jpg`), NOT the atmosphere cube. See "HDR vs LDR cube sources" in *Architecture decisions* below.
- **Post-processing** is the standard atmosphere stack: `pass → colorNode.mul(SCENE_RADIANCE_SCALE) → aerialPerspective → lensFlare → toneMapping(AgX, exposure) → dithering`. `SCENE_RADIANCE_SCALE = 0.28` is calibrated against `GlobeOceanProto.tsx:513`'s `0.55` after accounting for the WaterPro composition's ~2× higher peak vs `ocean-material.js`'s WGSL fragment output.
- **Preset selector** writes water-only fields from the 10 WaterPro scenes (see `presets.ts`). Atmosphere/caustics/oceanFloor/postProcessing/fresnel.underwater/ssr fields from the source presets are explicitly skipped — those belong on `AtmosphereContextNode` + the post-processing pipeline.
- **Distance fade**: no in-shader horizon-blend. The WaterPro `applyDistanceFog` step that mixes toward a sky-cube sample at distance was deliberately removed — it washed the surface to flat pale grey at zoomed-out cameras, hiding all foam/highlights. AerialPerspective in the post-pass handles atmospheric attenuation instead.

### Globe (`examples/ocean-ifft-demo/`)

File: `packages/ocean-ifft/components/GlobeOceanProto.tsx`

The full ECEF-scale ocean rendered against atmosphere + Cesium terrain. Uses the IFFT path via `OceanChunks` + `ocean-material.js`. Foam comes from the WaterPro nodes (currently only `shorelineFoamNode` is wired; remaining nodes still on the storybook-only path). The depth pre-pass in `OceanChunks.tsx` writes terrain depth to a `FloatType` render target (HalfFloat is insufficient at `cameraFar = 1e8`, see memory note `depth_pass_webgpu_gotchas.md`).

## Architecture decisions

1. **Programs as TSL node factories**. Each WaterPro program becomes a function returning a struct of TSL nodes (matches three.js TSL idiom). All inputs are passed as `params`, all outputs as a returned object. Callers compose programs by feeding outputs of one as inputs to another.

2. **`enabled` parameter on every node**. Each node accepts an `enabled` uniform that multiplies the final output strength. This lets Storybook toggle features at runtime without rebuilding the TSL graph.

3. **Stable uniform identity**. Demo `useMemo`'s the uniform bag so `useTransientControl` can write into the same uniform objects the TSL graph holds references to. Material rebuilds are rare; uniform writes are per-frame.

4. **No re-port of IFFT compute kernels**. The existing `resources/shader/IFFT/*.js` WGSL strings ARE the IFFT math; they're not WaterPro-specific. `WaveCascade` wraps them in a clean TS class without the lil-gui / `entity.Component` coupling the original `src/waves/wave-cascade.js` has.

5. **Sampler-based access for cascades**. `sampleWaveDisplacement`, `sampleWaveNormal`, `sampleWaveSurface` are TSL helper functions that take a `WaveSimulation` reference + world XZ coordinates. This matches WaterPro's `SF.sampleDisplacement(x, z, cascade)` / `SF.sampleNormals(...)` signature.

6. **Custom `positionNode` requires explicit world-space + view-space overrides**. TSL's built-in `positionView` / `positionWorld` use the raw `position` attribute, not the `positionNode` output. For the IFFT ocean (vertices displaced by sampled cascade textures), this is wrong by ± wave amplitude. Solution: pass `oceanDepth = modelViewMatrix · displacedLocal · z.negate()` and `oceanPositionWorld = (modelWorldMatrix · displacedLocal).xyz` explicitly via the node params. Documented in `nodes/water-color.ts` and applied in `ocean-material.js`.

7. **Schlick fresnel with F0 baked in**. WaterPro's program 2 includes an F0 = 0.02 (air↔water reflectance at normal incidence). Without F0, oblique angles reflect 15-40% of the sky → water reads beige/washed-out. With F0, water stays its natural blue at all but very-grazing angles.

8. **Wave foam uses crest mask, not crest + noise sum**. The earlier implementation summed noise + crest contribution and thresholded the sum, producing foam wherever the noise happened to be high (random blob appearance unrelated to wave crests). Corrected to: `strength = crestMask · noiseDetail · …` where `crestMask` gates *where* foam appears (Jacobian eigenvalues) and `noiseDetail` is the texture inside the gated region.

9. **Jacobian-eigenvalue interpretation**. The existing IFFT pipeline writes the *turbulence* value (low at crests, ~1 on flat water) to the cascade's `jacobian` render target. WaterPro's program 7 expects an `eigen` input that is *high* at crests. `wave-sampler.ts` inverts: `eigen0 = 1 − turbulence`.

10. **HDR vs LDR cube sources for in-shader reflection** (load-bearing — got this wrong for a long session). The WaterPro composition's `mix(waterColor, skyReflection, fresnel)` math is calibrated for an **LDR sRGB cubemap input (~0..1 range)**. Sampling `skyEnvironment(context).renderTarget.texture` instead — the atmosphere's HDR linear-radiance cube with values 5–10× — pushes the mixed reflection to 2–8× expected; AgX then saturates the entire surface to flat white regardless of fresnel power or any other knob. Reference: `ocean-material.js:117-120` loads the static JPG cubemap for its reflection; the atmosphere only drives sun direction and the post-pass. Same approach is correct for any WaterPro-derived material. If a true atmosphere-tracking reflection is needed, sample the HDR cube and scale by ~0.1-0.2× (empirical) before the fresnel mix, or switch to a tonemap-applied cube source. See `~/.claude/projects/-Users-steffen-Projects-three-geospatial/memory/waterpro_reflection_cube_source.md`.

11. **`MeshStandardNodeMaterial` with `colorNode` set still runs PBR lighting** on top of `colorNode`. Verified in three's source: `NodeMaterial.js:868` assigns `colorNode` to `diffuseColor`; `setupLighting` at line 1061 then multiplies by `PhysicalLightingModel(NdotL × sunColor + IBL)`. This is *intentional* in `ocean-material.js` — its WGSL output is pre-scaled assuming the PBR dim will follow. WaterPro nodes peak ~2× higher; the WaterproAtmosphere story keeps PBR on because `scene.environmentNode = skyEnvironment(context)` provides the IBL ambient that prevents pink-sand collapse at low sun (NdotL→0). Disabling PBR (`mat.lights = false` causes `NodeMaterial.js:934` to return `diffuseColor.rgb` verbatim) is an option but requires recalibrating the post-pass scale.

12. **`material.colorSpace = SRGBColorSpace` is a dead assignment in three.js WebGPU.** Greping `node_modules/three/src` for `material.colorSpace` / `this.colorSpace` consumers turns up nothing. The line appears in `ocean-material.js:193` and was copied into the WaterproAtmosphere story for parity, but it does NOT make three convert the colorNode output from sRGB to linear before lighting/tonemap. If true sRGB→linear conversion of the composed color is needed, do it explicitly in the shader (e.g. `pow(rgb, 2.2)` or a proper sRGB decode function). Currently neither demo needs it because the WaterPro composition uses `Color.convertSRGBToLinear()` on every hex string upstream in `presets.ts`.

13. **Pre-pass radiance scale (`colorNode.mul(K)`) is per-material, not per-pipeline**. `GlobeOceanProto.tsx:513` uses `0.55` for `ocean-material.js`'s WGSL output. The WaterproAtmosphere story uses `0.28` because the WaterPro TSL composition peaks roughly 2× higher (`waterColor 0.8 + SSS 0.2-0.5 + sparkle glow + foam mix to 1.0` vs ocean-material's `~0.5` peak). The constant lives at the top of each story file. When adapting a new material to this post-pass chain, the calibration question is: "what's the peak output of your colorNode?" — and `K ≈ 0.55 × (0.5 / peak)`.

## Known WaterPro defaults (transcribed)

From the decompiled class field initializers:

```
_F (water color)        waterDepth=20, depthFalloff=50, shallow=#00C9CC, deep=#003366, transmission=#00FFCC, alpha=1
EF (surface foam)       coverage=0.5, opacity=0.5, size=100, color=#FFFFFF
BF (shoreline foam)     range=50, size=50, coverage=0.5, opacity=0.5, color=#FFFFFF
PF (wave foam)          waveWeight=1, rippleWeight=1, crestCoverage=0.5, windBias=0.8, size=100,
                        windStretch=0.5, coverage=0.5, opacity=0.5, peakIntensity=1, color=#FFFFFF
TF (turbulent foam)     depthAttenuation=0.5, intensity=1, sampleEpsilon=2, waterSize=400
MF (fresnel + fade)     fadeStart=50, fadeEnd=200, fadePower=1, normalStrength=0.1, power=3
OF (sparkle)            focusPower=75.7, intensity=5.81, color=(1.0, 0.97, 0.88)
NF (SSS)                power=4, intensity=1, enabled=1
```

Note: WaterPro's `EF/PF` defaults of `coverage=0.5, opacity=0.5` assume the default 1×1 *white* foam texture (`RF()`). When using an actual noise texture (`simplex-noise.png` in this repo), `coverage` becomes a threshold past which noise values become foam — `0.5` means ~50% of pixels foam-up. Storybook demo currently runs `surfaceFoamCoverage=0.02`, `waveFoamCrestCoverage=0.3`. WaterPro's `OF` sparkle defaults (`intensity=5.81`) assume an HDR pipeline + tonemapping; without tonemapping the lobe blows out to solid white, so demo uses `1.5`.

## Quality presets (decompiled)

From `vF` in `full-shader-decoded.js`:

```
low    : segments=16,  gerstnerMax=0, jacobianFoam, surfaceFoam, turbulentFoam, shorelineFoam, sparkle, sss
medium : segments=32,  gerstnerMax=2, +wakeFoam
high   : segments=64,  gerstnerMax=4, +screenSpaceRefraction, +ssr
ultra  : segments=128, gerstnerMax=8, +domainWarpedFoam
```

Our current storybook demo runs equivalent to **high** minus SSR + screen-space-refraction.

## What's remaining for 1:1

In rough order of visual impact:

-2. **Globe-scale WaterPro story — atmosphere + 3D-tiles terrain + tiled WaterPro ocean.** The existing `examples/ocean-ifft-demo/` (localhost:5173) renders the full globe scene via `packages/ocean-ifft/components/GlobeOceanProto.tsx`. Its ocean is a quadtree clipmap that samples the **legacy** JS wave system (`src/waves/wave-generator.js` + `src/ocean/ocean-material.js`), not the WaterPro TSL nodes we built. Goal: a new Storybook story `GlobeWaterproOcean-Story.tsx` that runs the same scene but replaces the ocean material with the WaterPro composition (water color, sparkle, SSS, fresnel, sky reflection, foam) — atmosphere-driven, 1:1 with the WaterproAtmosphere flat-plane story but rendered through the chunk clipmap.

   **Scene currently composed in `GlobeOceanProto.tsx`.**
   - `AtmosphereContextNode` driving sun direction, sky environment, aerial perspective, lens flare, AgX tonemap (matches our WaterproAtmosphere story).
   - `TilesRenderer` (3D Tiles Cesium Ion) for terrain — `globalTerrainAssetId = 1`, plugin chain `CesiumIonAuthPlugin → TileMaterialReplacementPlugin`.
   - `OceanChunks` (components/OceanChunks.tsx) → `OceanChunkManager` (src/ocean/ocean.js) → quadtree tiling around the camera. Constants: `OCEAN_SIZE = 500 km`, `QT_OCEAN_MIN_CELL_SIZE = 500 m`, `QT_OCEAN_MIN_NUM_LAYERS = 15`, `QT_OCEAN_MIN_CELL_RESOLUTION = 36`. Each chunk is a triangle-strip patch with vertex-morphing at LOD boundaries.
   - Depth pre-pass into a `RGBA FloatType` render target (NOT HalfFloat — at `cameraFar = 1e8` half-float precision collapses; documented in PORT-STATUS footguns).
   - Chunk material = `ocean-material.js` `OceanMaterial`, which:
     - `positionNode = vertexStageWGSL(...)` — a WGSL vertex stage that does (a) LOD-boundary morphing using the `position/vindex/width/lod` attributes the chunk builder writes, (b) samples the 3 cascade displacement textures from the LEGACY `WaveGenerator`, (c) emits `vDisplacedPosition` and `vCascadeScales` varyings.
     - `colorNode = fragmentStageWGSL(...)` — WGSL fragment stage doing the legacy water shading (NOT the WaterPro TSL nodes).
     - Plus a single shoreline-foam node bolted on at the end via TSL `mix(colorWGSL, contactFoamColor, strength)` — the only WaterPro node currently reaching the globe demo.

   **What needs to change.**
   - Stand up a parallel chunk material that uses the WaterPro TSL nodes (water-color, sparkle, sub-surface-scattering, fresnel-distance, surface-foam, wave-foam, turbulent-foam, combine-foam, plus the live atmosphere reflection emissive path) instead of the WGSL `fragmentStageWGSL` and the legacy cascade WGSL composition.
   - Source the cascade displacement / derivative / jacobian textures from our `WaveSimulation` (`packages/ocean-ifft/src/waterpro/waves/wave-simulation.ts`) — same RGBA HalfFloat + R32Float texture shape, just a different class.
   - Preserve the **LOD-morphing vertex stage**. The chunk builder emits the position/vindex/width/lod attributes specifically so the WGSL vertex stage can interpolate between LOD-level vertex positions at boundaries; bypassing that produces visible chunk seams. Easiest path: keep the existing `vertexStageWGSL` and patch its cascade texture bindings (`buildCascadeUniforms` in ocean-material.js line 19) to point at our `WaveSimulation.cascades[i]` instead of `params.cascades[i]` from the legacy `WaveGenerator`. The cascade shape matches; the bindings are the same uniform names.
   - Re-issue the depth pre-pass to keep shoreline-foam working at globe scale.

   **Two main risks / unknowns.**
   1. **Cascade count.** The legacy globe path is hard-coded for 3 cascades (lines 21–37 of ocean-material.js: `cascades[0..2]`). Our `WaveSimulation` defaults to 3 cascades `[250, 17, 5]` (Phase A was reverted). If we ever move to the 2-cascade WaterPro preset schema, the vertex stage WGSL also needs to be updated. For this story, stay on 3 cascades.
   2. **Atmosphere cube vs static cube for reflection.** WaterproAtmosphere uses a HDR atmosphere cube for live sky reflection via `emissiveNode`. The globe scene also has atmosphere; reuse that path. Already documented in PORT-STATUS §10–11 (HDR cube must NOT route through `colorNode`, only `emissiveNode`).

   **Phased plan.**

   *Phase G-A — read-only scaffold.* Stand up the new story without touching any package code. Copy `GlobeOceanProto.tsx` patterns into `storybook-webgpu/src/ocean/GlobeWaterproOcean-Story.tsx`, mounting the same `TilesRenderer + AtmosphereContextNode + AtmosphereLight + post-processing` chain. Ocean is **legacy** material at this stage (just to prove the scaffold renders). Ends with a story that visually matches localhost:5173 in Storybook.

   *Phase G-B — Waterpro material adapter.* Author a new `buildWaterproChunkMaterial(...)` factory inside `storybook-webgpu/src/ocean/` (or in `packages/ocean-ifft/src/waterpro/` if reusable elsewhere) that:
   - Constructs a `MeshStandardNodeMaterial` with the chunk vertex stage as `positionNode` (reuse `vertexStageWGSL` from ocean-material.js but pass our `WaveSimulation.cascades` into `buildCascadeUniforms`-equivalent bindings).
   - Composes the WaterPro TSL fragment graph (water-color → SSS → sparkle → foam → reflection emissive) using `sampleWaveDisplacement` / `sampleWaveNormal` against the same `WaveSimulation`. World-XZ comes from the `vDisplacedPosition` varying, not from the raw plane attribute — same trick the WaterproAtmosphere story already uses.
   - Routes sky reflection through `emissiveNode` against the **static sRGB cubemap** (NOT the atmosphere HDR cube — PORT-STATUS §10).

   *Phase G-C — wire it into the chunk system.* Replace `OceanChunks`' material assignment with the new factory. `OceanChunkManager.CreateOceanChunk` passes a `material` param into `OceanChunk.Init`; the factory just supplies that. No changes to the chunk builder, quadtree, or LOD morphing math.

   *Phase G-D — depth pre-pass + atmosphere reflection.* The chunk material needs the depth pre-pass texture for shoreline-foam (mirrors the legacy hook in `OceanChunks.tsx:53–69`). Atmosphere context comes from the same `AtmosphereContextNode` instance the post-processing chain already owns; sun direction propagates through it.

   *Phase G-E — controls + presets.* Mirror WaterproAtmosphere's slider set + preset selector. Atmosphere fog distance is much larger here (aerial-perspective handles distance fade at globe scale; in-shader `fadeStart/End` should be set to disable).

   **Constraints.**
   - Do not modify `GlobeOceanProto.tsx`, `OceanChunks.tsx`, or `ocean-material.js` — those drive the existing localhost:5173 scene and must keep working. New story = new files in `storybook-webgpu/src/ocean/` only.
   - Stay PR-able to upstream takram: ocean code that needs to live in the package goes under `packages/ocean-ifft/src/waterpro/`; storybook-only adapter code stays in `storybook-webgpu/`.
   - The legacy `WaveGenerator` (JS) and our `WaveSimulation` (TS) cannot both run simultaneously in the same Canvas at full quality — they each own their own IFFT compute. For the new story, instantiate ONLY our `WaveSimulation`.



-1. **Wave system schema rewrite for 1:1 preset compatibility.** Highest priority — gates everything below it because the visible "rolling wave body" character the user is chasing comes from the preset schema, not the source `FIRST_WAVE_DATASET` defaults.

   **The discovery.** `tools/waterpro-decoder/extracted-presets.json` shows the live app uses a *different* schema than `src/waves/wave-constants.js`. The `arctic` preset's `waves` block:

   ```
   waves.fft:
     amplitude:            0.36
     animationSpeed:       3.8      // time scale on IFFT update — we lack this
     choppiness:           1        // = lambda (we hardcode 0.9 per cascade)
     directionalSpreading: 14.5     // not a FIRST_WAVE_DATASET field
     frequency:            1
     standingWaveRatio:    0.35     // not a FIRST_WAVE_DATASET field
     windDirection:        0
     windSpeed:            7.2      // NOT 50 — that was a slider max in the user's panel screenshot, not the default
     cascades:
       ripples: {scale: 249,  amplitudeScale: 0.28}
       waves:   {scale: 1356, amplitudeScale: 0.24}
   waves.gerstner:
     amplitude: 3, wavelength: 700, wavelengthSpread: 2.2, directionalSpread: 1
   ```

   **What this means structurally.**
   - The app uses **two** IFFT cascades named `ripples` and `waves`, not the source code's three `[250, 17, 5]`. Cascade scales are much larger (249 m and 1356 m).
   - Per-cascade `amplitudeScale` — a multiplier per cascade output that we don't expose.
   - App-layer params (`animationSpeed`, `directionalSpreading`, `frequency`, `standingWaveRatio`) don't map 1:1 to source `FIRST_WAVE_DATASET`. Either the app transforms them into `peakEnhancement` / `spreadBlend` / `swell` before pushing to the spectrum kernel, or the spectrum kernel reads them directly (and our port has been ignoring them since the WASM math is opaque). Same `wB(...)` opacity caveat applies: we can match field names and let downstream programs consume them, but the per-uniform math is inferred.

   **The boundary-cutoff bug already fixed.** Separately found and patched in `wave-defaults.ts`: cascade k-space boundaries were hand-tuned `[0.5, 6, 1e6]` leaving a gap in the ~2.83 – 12.5 m wavelength band — exactly the medium-rolling-waves range. Replaced with the canonical chain formula `boundaryHigh[i] = 2π / lengthScale[i+1] * 6` from source `wave-generator.js`. Closes the gap. Independent of the schema refactor below; should ship as its own small commit.

   **Phased plan.**

   *Phase A — wave engine schema (foundation, no UI yet).*
   1. Change `DEFAULT_CASCADES` to two cascades, ripples + waves, with the preset scales as defaults. Drop the third 5 m cascade. Recompute canonical boundaries for the new chain.
   2. Add `amplitudeScale` to `CascadeConfig`. Apply it when sampling cascade output (multiply slope/displacement reads, or apply at the IFFT compute level — pick one and document).
   3. Add `animationSpeed` as a uniform on `WaveSimulation`. Multiply `timeSec` by it inside `update()`.
   4. Add `choppiness` (= per-cascade lambda) so a single preset value can drive all cascades.
   5. Decide on `directionalSpreading` / `frequency` / `standingWaveRatio` semantics. Easiest: map onto `spreadBlend` / `peakEnhancement` / `swell` respectively via transparent passthrough and document the guess. We can refine once we see whether numerical ranges align with preset values.

   *Phase B — Gerstner schema match.*
   1. Rework `GerstnerOverlay` config to take `{amplitude, wavelength, wavelengthSpread, directionalSpread}` instead of the current direct wave-list construction.
   2. Internally still generate `maxWaves` Gerstner waves but with parameters derived from the four scalars (wavelength sampled within `[wavelength / wavelengthSpread, wavelength * wavelengthSpread]`, directions spread by `directionalSpread`, all amplitudes scaled by `amplitude`).

   *Phase C — preset importer.*
   1. Rewrite `presets.ts` so its `applyWaterproPreset` mutates `waveSim.spectrum.primary.*`, `waveSim.cascades[i].*`, and the Gerstner overlay's new schema fields, consuming `waves.fft.*` and `waves.gerstner.*` from extracted-presets shape directly.
   2. Keep the preset selector in the story; remove story-side wave sliders that this overrides (or keep them as override knobs that fire after preset apply).

   *Phase D — Story controls UI.*
   1. Add one slider per WaterPro UI panel control: windSpeed, windDirection, choppiness, animationSpeed, amplitude, frequency, directionalSpreading, standingWaveRatio, ripples.scale, ripples.amplitudeScale, waves.scale, waves.amplitudeScale, gerstner.amplitude, gerstner.wavelength, gerstner.wavelengthSpread, gerstner.directionalSpread. Mirror their UI exactly. Match defaults from `arctic` preset (or a chosen baseline) so the story opens on a known-good look.
   2. Wire each via `useTransientControl` to mutate the matching live uniform. Reinitialize the spectrum when any spectrum-driving uniform changes (`waveSim.reinitializeSpectrum()`).

   *Phase E — verify against extracted presets.*
   1. Iterate through `extracted-presets.json` keys (arctic, tropical, etc.), apply each, screenshot, compare against any WaterPro reference imagery we have. Document mismatches per preset in a new section.

   **Constraints.**
   - Each phase ends in a working storybook. Don't intermediate-state-break the demo.
   - Phase A breaks the existing presets.ts mapping (cascade count changes) — either temporarily disable preset selector during A→B, or replumb in lockstep.
   - The 5 m smallest cascade we'd drop in A1 is currently the dominant contributor to wave-foam crest mask (`eigen0` sample). Verify the new ripples cascade (249 m) still produces meaningful eigen0 values, or rework wave-foam to read from the surface-tile cascade instead.

0. **SSS per-crest "translucent wave" character.** Current SSS is a smooth view-aligned angular lobe (`pow(dot(viewDir, FROM-sun), power) × saturate(N.y) × distFade`), routed through `emissiveNode` so it bypasses PBR `NdotL × diffuseColor` attenuation. On the storybook 80m flat-ish plane this reads as a single tinted blob on the sun-facing side rather than light-through-each-crest. Three candidate fixes, in order of likely impact:
   - **Crest height mask**: gate by `sampleWaveDisplacement(sim, fragWorldXZ).displacement.y > threshold`. SSS fires only on high points → spotty per-crest look. Easiest; doesn't require wave amplitude changes.
   - **Per-cascade normal masks**: sample cascade-0 normal alone is degenerate at 80m × 250m scale (slopes ≈ 0 → mask ≈ 0). Cascade-1 (17m) is the right scale for the storybook plane — produces meaningful slope variation per wave body. Mask = `saturate(dot(N_cascade1, FROM-sun))` then multiply onto `sssOut.scattering`.
   - **Bigger wave amplitudes**: raise IFFT wind / Gerstner amplitude so the combined surface normal varies enough that the existing `N.y` term naturally modulates SSS per-crest. Closer to source reference but changes the whole scene's wave feel.
   - Source reference: WaterPro `NF.build` math is opaque (WASM) but the input list includes `waveNormal` AND `waveColumnDepth`. Suggests their masking uses near-shore depth as a gate — irrelevant for open-ocean storybook scene. The "inside the waves" character likely comes from their wave amplitude (much larger than our defaults) + the small-cascade normal variation, not from explicit per-crest gating.


1. **Program 0 (SSR)** — screen-space reflection. Needed for scene-geometry reflections (capsule, terrain reflected on water). Requires:
   - Scene color render target (currently we only have depth)
   - Ray-marching the depth buffer in screen-space
   - Outputs blend into the same fresnel-mix slot the cubemap currently uses

2. **`zF` waterline highlight** — bright meniscus when camera dips near the water plane. Light port: a screen-space band around `viewDir · normal ≈ 0` clipped by camera-Y proximity. Only fires when the camera approaches the surface.

3. **`underwaterSurfaceGlow`** — bright glow looking up at the surface from below. Only fires when `cameraPos.y < oceanLevel`.

4. **Underwater TIR (total internal reflection) + screen-space refraction** — bends the scene color through the wave normal when underwater. Quality preset gate at `high+`.

5. **Program 12 (`DF` wake foam)** — foam trails behind moving objects. Needs a wake render target (top-down camera that draws decals where dynamic objects move) and per-frame wake decay. Demo-impact: zero unless we add moving objects.

6. **`domainWarpedFoam`** — extra foam pattern in the `ultra` preset. Variant of surface foam with UV warping (sample noise, displace by another noise sample). Light port.

7. **Program 10 (sun shafts / output composite)** — atmospheric god-rays. Post-process pass; not part of the per-fragment ocean shader. Heavy port.

8. **`yF` CPU-side wave sampler** — height probe for buoyancy / object floating. Not visual; affects gameplay only. Reads the cascade displacement render target back to CPU asynchronously and samples it for given world positions.

9. **Atmosphere coupling** — WaterPro drives `sunDirection`, `sunIntensity`, and the reflection cubemap from a real atmosphere model (Bruneton-style). The globe demo has this via `@takram/three-atmosphere`; the storybook demo uses hardcoded `sunDir = (−0.4, −0.7, −0.3)` and the static cube/sky JPGs. Switching to atmosphere-driven inputs would close the gap.

10. **Fragment-side tuning to match `vF` quality presets**. The storybook demo currently doesn't expose a `preset` dropdown; each control is tunable independently. Could add a `preset: 'low' | 'medium' | 'high' | 'ultra'` arg that batch-sets all the other sliders to match the decompiled defaults.

## Footguns / things we learned the hard way

(See also `~/.claude/projects/-Users-steffen-Projects-three-geospatial/memory/depth_pass_webgpu_gotchas.md`.)

- **`scene.overrideMaterial` doesn't work with TSL node materials in WebGPU.** Use per-mesh material swap (`OceanChunks.tsx` does this).
- **Depth render target must be cleared to WHITE before the depth pass.** Black clear → `terrainDepth = cameraNear` everywhere → max shoreline foam over the entire ocean.
- **`HalfFloatType` depth target is insufficient at `cameraFar = 1e8`.** Precision collapses; use `FloatType`. The globe demo applies this; the storybook demo can stay HalfFloat (`cameraFar = 500`).
- **JPG cubemaps need `colorSpace = SRGBColorSpace`.** Without it, sRGB-encoded bytes are read as linear → everything washes out to beige.
- **TSL `positionView` / `positionWorld` use the raw `position` attribute**, not the custom `positionNode` output. For the IFFT ocean, this is wrong by ± wave amplitude; must compute view/world from `vDisplacedPosition` + `modelViewMatrix` / `modelWorldMatrix` explicitly.
- **Wave foam from Jacobian eigenvalues: high `eigen` = high turbulence = crest.** The existing cascade pipeline writes the *raw* turbulence value (low at crests, ~1 flat). Invert at the sampler so consumers get the "high = crest" convention WaterPro programs expect.
- **The atmosphere cube is HDR linear-radiance, not LDR sRGB.** Sampling `(skyEnvironment(context) as any).renderTarget.texture` directly into a WaterPro fresnel mix saturates AgX to flat white across the entire surface (values 5-10× expected). For in-shader reflections, use a static sRGB cubemap (matches `ocean-material.js`); the atmosphere cube is fine for PBR `scene.environmentNode` IBL because PBR rescales IBL contribution internally. See `~/.claude/projects/-Users-steffen-Projects-three-geospatial/memory/waterpro_reflection_cube_source.md`.
- **`material.colorSpace = SRGBColorSpace` does nothing in three.js WebGPU.** No code path reads it. Don't rely on it for sRGB→linear conversion; do it explicitly in shader if needed.
- **`MeshStandardNodeMaterial` applies PBR lighting to `colorNode`.** It's not a pass-through. Either embrace it (provide `scene.environmentNode` for IBL ambient so low-sun angles don't collapse to black/pink) or disable with `mat.lights = false` and recalibrate the post-pass scale.
- **WaterPro's in-shader distance-fade horizon-blend washes out the surface at zoomed-out cameras**, mixing `finalColor` toward a pale sky-cube sample along the view direction. If using `aerialPerspective` in the post-pass, drop the in-shader fade — they're redundant and the latter is gentler/correct atmospheric attenuation.
- **TSL chained `.mix()` treats the RECEIVER as the blend factor, not the first source.** `a.mix(b, c)` compiles to `mix(b, c, a)` = `b*(1-a) + c*a`. The chained form is wired up via `addMethodChaining('mix', mixElement)` where `mixElement = (t, e1, e2) => mix(e1, e2, t)` (see `three/src/nodes/math/MathNode.js:1059, 1156`). Three's own usage is consistent — e.g. `Fog.js:77` `factor.mix(output, color)`, `LightsNode.js:364` `backdropAlpha.mix(totalDiffuse, backdrop)`, all use the receiver as alpha — but it's the opposite of intuition coming from GLSL's `mix(x, y, alpha)`. Symptom: visible colour appears as the complement of the intended blend (because `(1 - receiver)` enters the math). **Always use the free `mix(a, b, t)` function for in-shader colour blends, or write chained as `t.mix(a, b)` with `t` as the alpha.** This bug bit the WaterproAtmosphere story for an entire multi-day session; four `.mix()` calls in the ocean composition had swapped semantics.
- **`new Color().setStyle('#hex')` already converts sRGB → linear** via `colorSpaceToWorking` inside `setHex` (`three/src/math/Color.js:212`); the working colour space is `LinearSRGBColorSpace` by default. **DO NOT chain `.convertSRGBToLinear()` afterward** — it double-applies the sRGB-decode curve. White survives (`1^2.4 = 1`) but all other values get crushed toward zero. Symptom: a colour picker control wired to a TSL uniform "only white works; any other hex looks identical to black."
- **`sunDirectionECEF.applyMatrix4(matrixECEFToWorld)` is wrong — use `.transformDirection()`.** `matrixWorldToECEF` produced by `Ellipsoid.getNorthUpEastFrame` is built with `.makeBasis(...).setPosition(P)` where `P` is the ECEF position of the location (~6.37e6 m magnitude). Inverting that matrix gives a translation of `-R^T · P ≈ (0, -|P|, 0)` in world coords. Applying that full inverse to a unit direction vector then normalizing collapses the result to almost exactly `(0, -1, 0)` regardless of the actual sun direction — the translation completely dominates the unit input. Symptom: SSS produces nothing (sun light direction wrong) and sparkle pattern doesn't track time-of-day (sun appears stuck below the surface). `Vector3.transformDirection(m)` applies only the rotation portion of a Matrix4 and is the correct method for transforming direction vectors. The wrong pattern lives in `packages/ocean-ifft/components/OceanChunks.tsx` and `packages/ocean-ifft/src/r3f/OceanChunks.tsx` too — both have been receiving a fake sun direction since the original commit. Memory: `~/.claude/projects/-Users-steffen-Projects-three-geospatial/memory/transform_direction_vs_apply_matrix4.md`.
- **WaterPro `sunDir` input on SSS + sparkle nodes is light propagation direction (sun → scene), not TO-sun.** The atmosphere convention `sunDirectionECEF` / `sunDirUniform` is the opposite (TO-sun). Pass `sunDirUniform.negate()` — and prefer mirroring it as a dedicated CPU-side `UniformNode<Vector3>` rather than a TSL `.negate()` chain, since the TS typings don't expose `.negate()` on `UniformNode` and the runtime behaviour through `reflect(...)` has been unreliable in this codebase. The depth demo's hardcoded `sunDir = new Vector3(-0.4, -0.7, -0.3).normalize()` is propagation (downward at noon) — use that as the convention reference. Symptom of passing TO-sun: `dot(viewDir, sunDir.negate())` inside the SSS node becomes `dot(viewDir, FROM-sun)`, which is ≤ 0 at every visible pixel → `saturate → 0` → SSS sliders are no-ops; sparkle still lights random wave faces because `reflect(I, N)` is forgiving but in geometrically wrong places.

## Reproduction

```bash
cd storybook-webgpu
npx storybook dev --port 6006
# Depth demo (LDR pipeline, hardcoded sun, static cubemap):
#   http://localhost:6006/?path=/story/ocean-waterpro-depth-demo--depth-demo
# Atmosphere demo (AtmosphereContextNode + AgX + preset selector):
#   http://localhost:6006/?path=/story/ocean-waterpro-atmosphere--atmosphere
```

Both stories share the WaterPro composition; the depth demo uses `MeshBasicNodeMaterial` direct-display, the atmosphere demo uses `MeshStandardNodeMaterial` + aerialPerspective post-pass with AgX tonemapping. The atmosphere demo additionally exposes a 10-scene `preset` dropdown that writes water-only fields via `applyWaterproPreset`.

For the globe demo:
```bash
npm run dev  # examples/ocean-ifft-demo
# Open: http://localhost:5175/
```
