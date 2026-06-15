# Water + Coastline Realism — Design Plan (DEFERRED feature)

<!--
Purpose: durable design record for making the digital-twin ocean read as a
realistic, coastline-accurate earth twin (ships at dock, future aquafarming).
Scope: the FULL tile-shading water feature, deferred for time. The minimal
now-work (square altitude-fade + globe specular glint) is tracked separately
in the story; this doc is the roadmap for the real thing. Read before resuming.
-->

## Problem (why the current ocean is wrong at scale)

The deployed twin renders a **finite WaterPro IFFT plane** placed at a fixed
WGS84-ellipsoid height (`Geodetic(lon,lat, height:20).toECEF()` + a global
`seaLevelOffset` leva, default ~29 m → ellipsoid +49 m). Two structural errors:

1. **Vertical datum (geoid vs ellipsoid).** Google Photorealistic 3D Tiles place
   the real sea surface at the **geoid** (mean sea level), which deviates from the
   WGS84 ellipsoid by roughly −100 m … +85 m and varies smoothly by location. A
   single ellipsoidal height can never match worldwide. The hand-tuned +49 m fits
   Norway (geoid N ≈ +42–45 m there) and **floods New York by ~80 m** (N ≈ −33 m).
   Confirmed empirically (NYC floods badly).
2. **Coastline boundary.** A flat plane vs. a complex shoreline produces visible
   boundary error regardless of height — it masks ports, piers, river mouths, the
   land border. This is the blocker for "ships at dock" and aquafarming scenarios.

A geoid correction fixes (1) only; (2) remains. So a geoid patch is NOT the answer
for a realistic twin — it was explicitly rejected as a quick-fix.

## Chosen approach — takram's "Water Area" tile-shading water (WebGPU/TSL)

takram already solved this on `main` (`storybook-webgpu/src/plugins/waterArea/`,
`WaterAreaNodeMaterial.ts`). It does **not** use a water plane. It shades the
**existing 3D-tile mesh in place** via a `TileMaterialReplacementPlugin`
(`MeshPhysicalNodeMaterial`, preserves the tile `.map`). Where an OSM-derived
water mask says "water" it:

- darkens color toward deep blue (`mix(map, #020514, mask*0.8)`),
- sets `ior 1.33`, `roughness 0.35`, ramps `specularIntensity` 0→1,
- **replaces the fragment normal with the ellipsoid surface normal** so PBR
  specular reflects sky/sun off smooth water despite the bumpy photogrammetry,
- discards water from the shadow map (`castShadowNode`).

Because it recolors the tiles' own geometry at the OSM boundary, **water sits at
the tiles' real coastline height and aligns to the land border by construction —
no geoid math, no boundary error.** No depth-buffer manipulation; tile depth is
written normally so aerial perspective composites over it unchanged.

### Mask data pipeline (takram's shipped path)

- Source: **OSM Shortbread MVT** (`https://vector.openstreetmap.org/shortbread_v1/{z}/{x}/{y}.mvt`), maxDataLevel 14.
- Rasterized in a **WebWorker** (`computeWaterAreaTileImage.ts`, protomaps-leaflet
  + `@mapbox/vector-tile`) to a 128px red-channel mask: ocean/water_polygons →
  white; **bridges/pier_polygons/dam_polygons → black (occluders punched out so
  docks/bridges aren't flooded)**.
- Solid-land / solid-water fast paths reuse 4×4 textures (skip rasterization).
- Attached to tiles as `layer_uv_0` attributes via a **WebGPU-ported
  `ImageOverlayPlugin`** (the stock 0.4.23 plugin is WebGL-only).

The 45 GB pre-baked TMS alternative was rejected by takram in favor of
MVT-in-worker. jamesx0416's fork (Maxar prebaked PNG, WebGL `onBeforeCompile`,
destructive discard, no WebGPU, no sea level) is **superseded** — only its
conservative land/water classifier concept is of any note.

## Architecture decision — HYBRID (locked)

Cannot simply replace the IFFT ocean: **ship buoyancy probes sample
`sampleWaveDisplacement`**, and the twin's purpose is ships on real waves. So:

- **Coastline / mid / globe range:** tile-shading water (accurate boundary, ships
  at dock, correct height, no geoid math) — cities, ports, aquafarming, full globe.
- **Offshore close-up (turbines, ship decks):** WaterPro IFFT plane for real
  geometric waves + buoyancy.
- **Unification:** perturb the tile-water ellipsoid normal with `sampleWaveNormal`
  (in an ocean-LOCAL frame — see precision risk) for wave detail; cross-fade the
  IFFT displacement plane in only at close range. Tie the cross-fade to the same
  altitude-LOD as the cloud/square-fade work.

Water-SOURCE decision: **REOPENED** — see "Water-source options" below. (Was
locked to OSM-mask + WebGPU `ImageOverlayPlugin` port; the quantized-mesh
watermask path, Option C, is a cheaper alternative discovered later.)

## Water-source options (the real decision)

The shine itself is trivial (PBR + ellipsoid-normal + sky env). The cost is
*water/land discrimination on the globe*. Three ways to get it, and the choice is
really about the fidelity of the base globe, not effort:

| option | water shine | base globe imagery | coastline detail | effort |
|---|---|---|---|---|
| **A — Google PT3D + OSM mask** (takram Water Area) | yes | photoreal photogrammetry | OSM-polygon sharp; piers/bridges punched out | HIGH — MVT worker + WebGPU `ImageOverlayPlugin` port |
| **B — in-fragment lon/lat global mask** | approx | photoreal (Google PT3D) | coarse (one global raster); poor at dock scale | LOW but degraded — a hack |
| **C — Cesium quantized-mesh watermask** | **near-free** | none from terrain — needs a separate imagery overlay (Bing/Sentinel/Ion) | per-tile 256² (fine at zoom, coarser than OSM) | LOW for the shine; you trade away Google photogrammetry |

### Option C detail — quantized-mesh watermask (discovered via Cesium forum)

Our `3d-tiles-renderer@0.4.23` **already decodes the Cesium quantized-mesh water
mask and wires it to shine** — no OSM pipeline, no plugin port:

- `QuantizedMeshLoaderBase.js:33` requests `extensions=octvertexnormals-watermask-metadata`.
- `QuantizedMeshLoader.js:274-296` parses `extensions['watermask'] = { mask, size }`
  (`size` = 1 whole-tile, or 256 → 256×256), builds a per-tile `DataTexture`
  (water → 0, land → 255), and assigns it to **`material.roughnessMap`** — so water
  is smooth (reflective) and land is rough (matte) out of the box.

Catches:
- The watermask is a **quantized-mesh (Cesium World Terrain) feature**. We render
  **Google Photorealistic 3D Tiles** (asset 2275207) for imagery, which carry
  **no** watermask. The mask only arrives on the quantized-mesh tileset — which is
  elevation-only (no imagery; renders flat white, as we saw with "Asset 1"). So
  Option C means a globe architecture change: Cesium terrain + an imagery overlay,
  OR running both tilesets and projecting the per-tile mask onto the Google tiles
  (awkward).
- `TileMaterialReplacementPlugin` currently swaps tiles to flat
  `MeshLambertNodeMaterial`, which discards `roughnessMap` — switch to a PBR
  material that keeps it.
- Boundary is terrain-tile resolution (256² per tile), not OSM-polygon sharp.

This **reopens "tile-classified water"** (route (b)), which was written off as dead
on Google tiles: it IS viable on the Cesium quantized-mesh tileset, because that
tileset carries the classification and our renderer already decodes it.

Recommendation lean: for an **offshore-wind twin** (camera mostly over open water),
Option C's near-free shine + classic terrain may be the better deal; for **dockside
city realism**, Google photogrammetry (Option A) is hard to give up. Decide per the
product's dominant viewpoint before committing.

## Our pipeline readiness (study findings)

Already in place:
- The deployed example reuses the story's `Content` directly (`examples/ocean-globe-waterpro-demo/main.tsx` imports from `GlobeWaterproOcean-Story`).
- `TileMaterialReplacementPlugin` (`GlobeWaterproOcean-Story.tsx:217`) already swaps
  tile materials and **preserves `.map`** (currently `MeshLambertNodeMaterial`,
  `#6f7f68`). Identical install point to takram's handler.
- `renderer.contextNode` wired with `getAtmosphere`; `getAtmosphereContext(builder)`
  exposes ECEF matrices as TSL `uniform('mat4')` (`packages/atmosphere/.../AtmosphereContext.ts`).
- Tiles + ocean render into one scene pass; aerial perspective layers over depth
  (`GlobeWaterproOcean-Story.tsx:2526-2613`) — takram's exact premise.
- Reusable IFFT nodes `sampleWaveNormal` / `sampleWaveDisplacement`
  (`buildWaterproOceanMaterial.ts`, re-exported) — perturb a normal without
  displacing geometry. takram's base WaterArea has no waves; we can add them.
- WebWorker infra (`packages/ocean-ifft/src/ocean/ocean-builder-threaded.js`) +
  a Node server (`examples/ocean-globe-waterpro-demo/server/index.ts`, already
  proxies MET + BarentsWatch) to host/proxy mask tiles.

Gaps / risks:
- **HIGH — ECEF float32 precision.** Per-fragment ECEF math / IFFT-cascade sampling
  at ~6.37e6 m collapses to solid-color tiles. The ocean already solves this with
  an ocean-local frame; tile-water MUST sample wave nodes in a local frame.
- **MEDIUM — no `matrixViewToECEF`/`matrixECEFToView` in our atmosphere context**
  (only world↔ECEF). Adding them touches `packages/atmosphere` → violates the
  PR-able constraint. Mitigation: compute the ellipsoid normal in **world frame**
  using the exposed `matrixECEFToWorld` + the geocentric-up trick the ocean
  material already uses (`buildWaterproOceanMaterial.ts:483-485`).
- **MEDIUM — `ImageOverlayPlugin` WebGPU port** is real engineering (the `flipY`
  ImageBitmap UV flip + `.uniformFlow()` workarounds; the `LAYER_COUNT`
  getter/setter colorNode-rebuild hack).
- **LOW — depth pre-pass** swaps tile materials to a linear-depth material; a
  single-material/single-group WaterArea material is swapped like today's Lambert.
- **PR constraint satisfiable**: all new code lands in `packages/ocean-ifft/` +
  `storybook-webgpu/`, consuming atmosphere read-only; `WaterAreaNodeMaterial`
  → `packages/ocean-ifft/`, plugin port → `storybook-webgpu/`.

## Phased plan

- **Phase 0 — de-risk proof.** `WaterAreaNodeMaterial` (PBR + world-frame
  ellipsoid-normal) on tiles at **NYC** (the failing case) with a placeholder mask.
  Proves contextNode + normal-replacement + ECEF precision in our pipeline.
- **Phase 1 — mask data.** WebGPU-port `ImageOverlayPlugin`; OSM Shortbread MVT →
  WebWorker rasterizer → mask onto tiles, proxied via the Node server. Global.
- **Phase 2 — occluders.** bridges/piers/dams punched out → docks not flooded.
- **Phase 3 — waves on accurate water.** local-frame `sampleWaveNormal`
  perturbation; cross-fade IFFT displacement for close offshore.
- **Phase 4 — altitude LOD.** merge with the cloud/square-fade work; one shared
  altitude metric (`camera.position.length() - target.length()`).

## References

- Issue thread: https://github.com/takram-design-engineering/three-geospatial/issues/91
- Live story: https://takram-design-engineering.github.io/three-geospatial-webgpu/?path=/story/atmosphere-3d-tiles-renderer-integration--water-area
- takram source (main): `storybook-webgpu/src/plugins/waterArea/`, `WaterAreaNodeMaterial.ts`, `wrapWaterAreaNodeMaterial.ts`, `worker/tasks/computeWaterAreaTileImage.ts`, `packages/core/src/webgpu/math.ts` (`rayEllipsoidIntersection`).
- Our anchors: `GlobeWaterproOcean-Story.tsx:217` (tile plugin), `:2526` (post chain), `buildWaterproOceanMaterial.ts` (IFFT nodes), `OceanChunksWaterpro.tsx` (depth pre-pass, oceanGroup).
- Option C (quantized-mesh watermask): Cesium forum https://community.cesium.com/t/understanding-watermask/20124 ; our decoder already present — `node_modules/3d-tiles-renderer/src/core/plugins/loaders/QuantizedMeshLoaderBase.js:33,227` (request + parse) and `.../three/plugins/loaders/QuantizedMeshLoader.js:274-296` (mask → `DataTexture` → `material.roughnessMap`). quantized-mesh-1.0 watermask: per-tile `size` 1 (whole tile) or 256 (256×256).
