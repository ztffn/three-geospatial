# Performance Findings — Globe WaterPro Twin (loader + render)

Purpose: record the loader/render performance work on the digital-twin
(`examples/ocean-globe-waterpro-demo`, backed by this story), what was fixed,
and the larger-scope optimisations still on the table. Scope spans the twin
entry, `storybook-webgpu/src/ocean/`, and `packages/ocean-ifft/`. WebGPU/TSL.

Date: 2026-06-22.

## Baseline (dev build, Karmøy scene)

- Atmosphere LUT precompute: **was a hang / ~20 s → now ~400 ms**.
- Ocean chunk build: **~3.5–3.8 s** — the dominant remaining load cost.
- First ocean-phase render: a single **~2.3 s** WGSL pipeline compile (under the splash).
- Perceived time to reveal: **~4 s**.

## Fixed this session

1. **Atmosphere LUT hang — dead `requestIdleCallback` shim.** The atmosphere
   package captures `window.requestIdleCallback` into a module-level `const` at
   first import; the inline shim in `main.tsx` ran *after* that (ES module
   imports are hoisted), so it was dead code and the LUT ran on native rIC,
   which the heavy WebGPU loop starves → permanent "Precomputing atmosphere".
   Fix: shim moved to its own module imported **first**
   (`installIdleCallbackShim.ts`), implemented as a `MessageChannel`
   setImmediate so the 12 LUT steps drain back-to-back.
2. **Heavy actors gated out of the atmosphere phase.** `TurbineFarm`,
   `CloudLayer`, `Precipitation` mount behind `!disableOcean` so the
   atmosphere-phase scene is minimal and the LUT drains without GPU contention.
3. **Dead per-frame reflection cube removed (WaterPro path).**
   `packages/ocean-ifft/src/ocean/ocean.js` rendered a 256³ `CubeCamera`
   (6 faces + mipmaps) every frame into a texture the WaterPro material never
   samples. Skipped when an external material is supplied — steady-state FPS win.
4. **Post-reveal whole-frame fade-to-black — terrain.** The first terrain tile's
   `MeshLambertNodeMaterial` entering the scene forces a one-time recompile of
   the post `pass` pipeline; during it the pass depth is briefly invalid and the
   aerial-perspective draws no sky → whole frame (sky included) goes black ~1 s.
   Gating had deferred `TilesRenderer` to the ocean phase, landing that recompile
   at reveal. Un-gated terrain so the recompile happens under the splash.
   (Bulletproof follow-up: **B** below.)
5. **Underwater fade-to-black guard.** Symmetric altitude guard
   (`|camAltitude| > 500` → not submerged) so a transient near-earth-centre
   camera pose during load can't false-trigger the underwater post effect.

## Larger-scope optimisations (out of scope this session)

### A. Ocean chunk build (~3.6 s) — the dominant load cost
Reveal waits for the entire initial quadtree (160 chunks, 7 workers,
`builder.Busy === false`). Levers, roughly by impact:

- **Reveal on the near chunks, not all 160.** Gate reveal on the high-LOD
  chunks covering the initial view rather than the full 500 km LOD pyramid; let
  the far/coarse chunks finish after reveal. Largest perceived-load win. Needs
  the chunk manager to expose a "near set ready" signal or a count threshold;
  risk is distant-LOD pop-in.
- **Worker pool `7 → navigator.hardwareConcurrency`.**
  `ocean-builder-threaded.js` hardcodes `_NUM_WORKERS = 7`. Helps only if the
  build is worker-bound, not main-thread-starved (see next).
- **The ~2.3 s single-frame WGSL compile (highest-leverage structural change).**
  The first ocean-phase render compiles the WaterPro ocean material + depth
  pre-pass + turbine PBR + post graph **synchronously**, blocking the main
  thread — which then can't drain worker results, serialising the build. three
  0.183.2 supports `renderer.compileAsync`; pre-compiling the heavy materials
  off the critical path (during the splash) would unblock the build and likely
  cut a large slice of the 3.6 s.

### A2. Steady-state frame rate (the recurring `requestAnimationFrame` violations)
Two distinct things show up as DevTools rAF violations:
- **1.5–2.4 s spikes** — the one-time WGSL compiles from A (under the splash).
- **A continuous stream of 50–300 ms ones** — the scene renders at ~10 fps in
  dev (~100 ms/frame), and Chrome's violation threshold is 50 ms, so below
  ~20 fps **every frame trips the warning**. Not a discrete bug — it's the
  steady-state GPU cost of the full scene (IFFT ocean + sky reflections +
  aerial-perspective + the whole post chain + terrain streaming + turbines +
  clouds + precip + the wet-lens RTT). These are timing *notices*, not errors,
  and can't be suppressed from code — only by shortening frames. (Dev build;
  prod is faster, but steady-state fps is still a real axis.)

Cheapest steady-state lever: the **wet-lens always-on RTT**. With
`lensControls.enabled` (default on), `outputNode =
lensDrops.apply(convertToTexture(composite))` runs an **extra full-frame
render-to-texture every frame even when it isn't raining** (strength 0).
Bypassing the RTT when dry saves a whole pass per frame. The catch: `enabled` is
a post-memo dep, so toggling it rebuilds the pipeline (a hitch) — a clean fix
needs an internal passthrough in the lens node rather than a memo-level toggle.
Then: DPR clamp, and a pass-level profile (ocean reflections vs aerial-perspective
vs clouds) to find the dominant cost.

### B. Terrain dip — bulletproof fix
The shipped fix hides the one-time post-`pass` recompile under the splash by
mounting terrain early. It relies on the first tile arriving before reveal
(~3.5 s) — true on a normal connection, not guaranteed on a slow one — and the
same recompile can recur when navigating into a fresh region (new material
variant). Robust fix: pre-warm the terrain tile material (or `compileAsync` the
post pipeline with a representative terrain material) before reveal. Shares the
compileAsync work with A.

### C. Legacy ocean path — bundle weight
`packages/ocean-ifft` carries a legacy `OceanMaterial` path
(`params.material == null`) used by `Ocean-Basic` / `Ocean-Globe-Patch` /
`Ocean-Sphere` stories and the `ocean-ifft-demo` (`pnpm dev`). It never executes
in the twin (which always supplies the WaterPro material) but is statically
imported, so it + `ocean-material.js` ride along in the bundle (a few KB; no
network/runtime cost). If those consumers are obsolete, deleting them +
`ocean-material.js` + the cube target trims the bundle and maintenance surface.
Decision pending (their value + upstream-PR intent).

### D. Non-WebGPU / CPU-side (the hot path is mostly already offloaded)
The render hot path is in good shape: wave sim on the GPU, chunk geometry in
workers, Draco decode off-thread, LOD morph in the WGSL vertex stage
(`chunk.Update()` is a no-op), and — confirmed by grep — **no GPU→CPU readbacks**
(`readPixels`/`mapAsync`, the worst WebGPU stalls) and **no per-frame raycasts**.
So there's no hidden CPU bottleneck; the dominant cost is the GPU compile (A).
Remaining CPU items, by value:

- **Sun/moon astronomy every frame (clean win).** The sun/moon `useFrame`
  (`GlobeWaterproOcean-Story.tsx`) recomputes `getECIToECEFRotationMatrix` +
  `getSunDirectionECI` + `getMoonDirectionECI` ~60×/s, but `atmosphereDate` only
  changes when the clock advances (~60 s) or on scrub — so it writes the same
  uniforms repeatedly. Gate it on `atmosphereDate` change (move to a
  `useEffect`/`useMemo`). Low effort, low risk.
- **Chunk geometry upload at load.** As workers deliver chunks,
  `RebuildMeshFromData` (`ocean-chunk.js`) builds 6 new `BufferAttribute`s per
  chunk on the main thread (×160). Necessary, but could be throttled to N/frame
  so it doesn't pile into the same frames as the WGSL compile.
- **Per-frame micro-waste** (negligible but free to remove):
  `OceanChunkManager.Update_` re-sets `material.wireframe` and calls the empty
  `chunk.Update()` for all 160 chunks every frame, and allocates 2 `Vector3` +
  a `.clone()` per frame (GC). Reuse scratch vectors; drop the redundant sets.
- CPU Gerstner sampling (buoyancy + underwater) is a fixed 3-wave sum, a handful
  of calls/frame — not a concern.
- **Legacy CPU/JS dead weight** (extends C): the unused ocean-ifft game-engine
  modules — `player-controller`, `third-person-camera`, `player-input`,
  `spawners`, `threejs-component`, `spherical-ocean` — ride in the bundle for
  the twin without ever executing.

### E. Minor
- **Resize handler.** `ResizeSync` (`main.tsx`) calls `setSize`/`setDpr`
  (reallocates render targets) on every resize event — apply the rAF
  "ticking-flag" coalescing pattern and drop its TEMP `console.log`.
- **Deprecation warnings.** `THREE.Clock → Timer`,
  `PostProcessing → RenderPipeline`, `CesiumIonAuthPlugin` moved import path.
  Cosmetic; clears console noise.

## Cables — disabled, pending plugin refactor
`TurbineCables` (turbine inter-array cables) is **disabled by default**
(`Cables → enabled`). It baked cable geometry via terrain raycasts + a Verlet
solve and re-baked on every terrain tile-load while coverage improved (console
spam), and the committed `cable-bake.ts` snapshot loads only on a **byte-exact**
input-signature match — too brittle for the main render path (any layout /
ship-anchor / target tweak invalidates it). Direction: extract cables into a
**detachable scene-dressing plugin** (like the precipitation and fish-school
plugins) that places baked cable sets at variable sites on demand, decoupled
from the core scene. Re-enable the Leva toggle to author/inspect in the meantime.

## Gaussian splats — dither-opaque is SLOWER than blending on TBDR (2026-06-24)
The twin's `SplatLayer` (`storybook-webgpu/src/ocean/`, material in
`packages/splats/src/webgpu/GaussianSplatNodeMaterial.ts`) renders splats with
**premultiplied semi-transparent blending**, NOT dithered-opaque — and that is a
deliberate, measured choice that **inverts the usual desktop intuition**.

The standard splat perf wisdom (SuperSplat/PlayCanvas) is: render splats as
*opaque* geometry and fake transparency with a per-fragment `discard` (dither),
because on immediate-mode desktop GPUs that skips alpha-blending + back-to-front
sorting and keeps early-Z. We tried exactly this in the twin and it **dropped to
1–5 fps**. Root cause: the twin targets **Apple Silicon → Metal → tile-based
deferred rendering (TBDR)**, where the trade reverses:
- **Transparent blending is cheap** on TBDR — it blends overlapping layers in
  fast on-chip tile memory; that's what the architecture is built for.
- **`discard` is expensive** on TBDR — it breaks the hidden-surface-removal /
  early-visibility fast path, so every overlapping fragment shades at full cost.
  (The same applies to any `discard`/`alphaTest`/`alphaHash` "dithered opacity".)

So we reverted dither and shipped **premultiplied + composite-after-atmosphere**
(approach A): the splat renders in its own `splatScene` pass, composited after
`aerialPerspective` so its soft edges blend over the lit sky (no black halo), with
a depth mask against the scene depth for occlusion, and a no-op `setupDepth()` on
the material so the vertexNode's per-splat clip-z depth is authoritative (each
splat occludes per-pixel instead of the whole cloud writing one near-origin
depth). Perf is back to smooth.

Detours this took (so they aren't repeated): dither *requires* TAA to resolve its
stochastic coverage → TAA was added then removed; then a tiled OGC3DTiles/SPZ
streaming spike (`@jdultra/threedtiles`, contextsplat.xyz) — abandoned because
every public fixture is SPZ-v3 / `KHR_gaussian_splatting_compression_spz_2`, which
no JS decoder currently reads (`spz-js@1.2.5` maxes at v2; threedtiles' GLTFLoader
rejects the KHR extension). Streaming is still the eventual answer for real
million-splat captures, but it's parked on the ecosystem, not on us.

**Lesson for future splat / transparency work: do NOT assume desktop GPU
intuition on this twin.** On TBDR, prefer real alpha blending over
`discard`/dither-opacity. Always perf-test a discard-based "optimisation" on the
actual Apple-Silicon target before adopting it. (See memory
`twin_splats_dither_opaque_taa`.) Note dither for *output anti-banding*
(`.add(dithering)` in the post chain) is unrelated and stays — it adds sub-LSB
noise to final colours, no `discard`, always cheap.

## Diagnostic method notes
- **Leva persists control values to `localStorage`** and overrides code
  defaults. When testing a changed default, clear the `leva` key (DevTools →
  Application → Local Storage → `localhost:5173`) or confirm the panel reflects it.
- **The rIC shim must be a first-import module** — ES modules hoist imports, so
  an inline shim in the entry runs after the imported atmosphere helper has
  already captured the global.
- **Clean-restart discipline.** After any TSL/ocean edit: `Ctrl+C` →
  `rm -rf node_modules/.vite` → restart → fresh tab. The LUT pipeline and the
  chunk-builder pool hold mutable WebGPU state that HMR corrupts.
