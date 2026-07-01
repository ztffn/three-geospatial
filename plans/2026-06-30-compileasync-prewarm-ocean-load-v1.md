# compileAsync Pre-warm to Speed Up the Globe-WaterPro Twin Load

## Objective

Move the synchronous WGSL pipeline compile (~2.3 s measured at baseline) that
currently lands on the first visible frame of the ocean phase **off the critical
path** and under the loading splash, so it no longer blocks the main thread while
the ocean chunk-builder workers are draining results. The compile blocking the
main thread is what serialises the ~3.6 s ocean build (the dominant remaining
load cost); freeing the main thread should let the build complete in roughly its
own work time and remove the load-time `requestAnimationFrame` spikes. The same
pre-warm must cover the terrain material so the post-pass recompile that produced
the reveal fade-to-black cannot recur (FINDINGS item B), and must be robust
rather than reliant on the first terrain tile arriving before reveal.

Scope: `examples/ocean-globe-waterpro-demo` and `storybook-webgpu/src/ocean/`,
with read-only understanding of `packages/ocean-ifft`. The approved spec is
`storybook-webgpu/src/ocean/PERFORMANCE-FINDINGS.md` items A, A2, and B. Do not
modify `packages/atmosphere` or postprocessing (the ocean/twin work must stay
PR-able upstream to takram).

## Background (verified against the code and three 0.183.2)

The post chain is a single `PostProcessing` instance, which in three 0.183.2 is a
deprecated alias for `RenderPipeline` and renders the whole effect graph as one
fullscreen quad whose fragment node is the entire chain — scene pass, aerial
perspective, underwater, lens flare, AgX tone map, dithering, plus the splat and
overlay composites (`storybook-webgpu/src/ocean/GlobeWaterproOcean-Story.tsx:3483`
and `node_modules/.pnpm/three@0.183.2/node_modules/three/src/renderers/common/RenderPipeline.js:104`).

There are two synchronous compile sites on the first ocean-phase frame, not one:
the depth pre-pass renders the scene with a swapped depth material into a separate
render target at frame priority 0.5
(`storybook-webgpu/src/ocean/OceanChunksWaterpro.tsx:639`), and the post render
runs at priority 1 (`storybook-webgpu/src/ocean/GlobeWaterproOcean-Story.tsx:3886`).
The build driver runs at priority 0 (`packages/ocean-ifft/src/ocean/ocean.js:152`,
with the worker drain at `packages/ocean-ifft/src/ocean/ocean.js:176`).

`renderer.compileAsync` compiles scene object pipelines and awaits the GPU
pipeline-creation promises
(`node_modules/.pnpm/three@0.183.2/node_modules/three/src/renderers/common/Renderer.js:862`).
The WebGPU backend only uses the async pipeline path when those promises exist;
the normal render path compiles synchronously
(`node_modules/.pnpm/three@0.183.2/node_modules/three/src/renderers/webgpu/utils/WebGPUPipelineUtils.js:275`).
Crucially, the scene pass node exposes its own pre-warm entry point that binds the
pass render target and MRT before delegating to the renderer
(`node_modules/.pnpm/three@0.183.2/node_modules/three/src/nodes/display/PassNode.js:739`),
which is the faithful way to warm inner-scene materials with the exact pipeline
context the live render will use. The TSL-to-WGSL codegen still runs on the main
thread even in the async path; the net win is timing (relocation under the splash
plus async GPU compile), not free work, so every step below must be measured.

## Implementation Plan

- [ ] 1. Record the baseline before touching code: clear the Vite cache, start the globe-waterpro dev server, open a fresh tab with the leva localStorage key cleared, and capture the `[ready] ocean chunks built in …ms` value plus every load-time `requestAnimationFrame` violation duration. Repeat this exact protocol after each change, since the loader holds WebGPU state that does not survive remount and HMR misreports.

- [ ] 2. Return the three pass nodes (main scene pass, splat pass, overlay pass) and the live `PostProcessing` instance out of the `postProcessingData` memo at `storybook-webgpu/src/ocean/GlobeWaterproOcean-Story.tsx:3483`, alongside the existing skyNode, so a pre-warm effect can reach their pre-warm entry points. They are currently memo-locals; do not otherwise change the graph.

- [ ] 3. Add a story-level pre-warm effect that fires once in the ocean phase, keyed on the ocean-manager handoff at `storybook-webgpu/src/ocean/OceanChunksWaterpro.tsx:451` (real material existence, not a timer), and runs the warm sequence to completion before signalling reveal-readiness.

- [ ] 4. Within that effect, warm the inner-scene materials by awaiting the main scene pass node's pre-warm entry point, then the splat and overlay pass nodes only when their scenes are non-empty (the splat layer is parked, so skip cleanly when absent). This covers the WaterPro ocean material, the terrain Lambert material (FINDINGS item B), the turbine PBR, and ship/overlay materials with the correct render-target and MRT context.

- [ ] 5. Warm the depth pre-pass pipelines, a distinct compile site the pass-node warm does not reach, by replicating the production swap rules from `storybook-webgpu/src/ocean/OceanChunksWaterpro.tsx:570` (bind the depth target, white clear, strip the environment node, swap the depth/occluder materials, skip Int32-attribute chunk meshes, multi-material meshes, and pure-transparent meshes) then calling `renderer.compileAsync` against that state. The skip rules are load-bearing: a wrong depth-material swap hard-crashes the device.

- [ ] 6. Gate the live depth pre-pass and live post render so neither draws ocean materials until the warm resolves, closing the race where the first live frame compiles synchronously first. Prefer keeping the ocean group hidden from those passes (the build driver advances regardless of visibility) and revealing on completion; fall back to gating the two render callbacks behind a ready flag if hiding disturbs the warm traversal.

- [ ] 7. Absorb the residual outer post-graph compile (the aerial-perspective and tone-map quad, not reachable through the pass-node pre-warm API and independent of the ocean build) with one post render under the splash after the inner warm and after the build reports done, so it compiles only the outer graph.

- [ ] 8. Thread a pre-warm-complete signal back to the loader: add a getter to the readiness refs surfaced from `Content` and extend the ocean-phase poll at `examples/ocean-globe-waterpro-demo/main.tsx:231` so ocean-ready requires both the existing build-done plus chunk-count test and the new warm-done flag before the splash fades.

- [ ] 9. Instrument the warm sequence with start/done timestamps and which pass nodes were warmed, in the same console-log style as the `[ready] …` lines in `examples/ocean-globe-waterpro-demo/main.tsx`, so the user can confirm the spike moved rather than vanished without a debugger.

- [ ] 10. Typecheck, clean-restart, and re-measure on a fresh tab with leva cleared. Confirm the build time dropped, the load spikes moved under the splash, and the first revealed frame shows the full scene without a fade-to-black; record the outcome and any residual in `storybook-webgpu/src/ocean/PERFORMANCE-FINDINGS.md` items A, A2, and B.

## Verification Criteria

- The `[ready] ocean chunks built in …ms` log drops materially from the ~3.6 s baseline (record exact before/after numbers; the target is removing a large slice, driven by the main thread no longer being blocked during the build).
- The load-time `requestAnimationFrame` violation of roughly 1.5 to 2.4 s no longer occurs on the first visible frame after reveal; any remaining large spike sits under the splash, before reveal.
- The first frame after the splash fades shows sky, ocean, terrain, and turbines together with no whole-frame fade-to-black and no missing-sky artifact (the aerial-perspective-during-recompile symptom that FINDINGS item B targets).
- No WebGPU device-loss or persistent black canvas occurs during the depth-pass pre-warm across repeated clean restarts.
- Flying to a fresh region with a new terrain variant either does not blank the frame or blanks only once; the behaviour is documented in PERFORMANCE-FINDINGS.md.
- Typecheck passes, and a clean restart on a fresh tab reproduces the improvement deterministically rather than only under HMR.

## Potential Risks and Mitigations

1. **Codegen still blocks the main thread.** compileAsync only moves the GPU
   driver compile off-thread; the TSL-to-WGSL generation remains synchronous, so
   the spike may shrink and relocate rather than disappear.
   Mitigation: measure explicitly per the instrumentation task; if codegen alone
   still spikes, accept the relocation under the splash as the win, and treat
   further codegen reduction (graph simplification) as separate follow-up work.

2. **Pipeline cache-key divergence.** A pre-warmed pipeline only helps if its
   cache key matches the live one; differences in render target, MRT layout,
   lights, clipping, or geometry attributes would cause a cache miss and the
   compile would still happen live.
   Mitigation: warm the real pass nodes with the real objects through the pass
   node's own pre-warm entry point (which binds the same render target and MRT),
   not synthetic stand-ins; verify a cache hit by confirming no synchronous spike
   on the first live frame after reveal.

3. **Race between the live render loop and the async warm.** The render loop runs
   every frame during the ocean phase, so a chunk drawn before the warm resolves
   would compile synchronously and defeat the change.
   Mitigation: the gating task above must land with the warm; keep the ocean
   group out of the drawn passes until the warm-complete signal fires.

4. **Depth-pass pre-warm crashing the device.** Swapping the depth material onto
   Int32-attribute chunk meshes, multi-material meshes, or transparent meshes is a
   known hard crash that blacks the canvas until reload.
   Mitigation: replicate the exact production skip rules and target/clear/env
   setup from the live depth pass when assembling the warm; test on a clean
   restart and watch for device-loss before trusting the path.

5. **Loader WebGPU state does not survive remount and HMR lies.** Apparent
   success under hot reload can be false.
   Mitigation: enforce the clean-restart protocol (stop server, remove the Vite
   cache, fresh tab, clear the leva localStorage key) for every measurement, as
   already required by the loader's design.

6. **Slow-connection ordering.** The terrain tile or ocean material may not exist
   when the warm runs, and a new material variant can appear later during
   navigation, reintroducing a one-time recompile (FINDINGS item B recurrence).
   Mitigation: key the warm on actual material and object existence rather than a
   timer; document the navigation-time recurrence and, if it proves visible,
   re-run the warm on region change as a follow-up.

7. **Type-version gap.** The installed three types are 0.182 while the runtime is
   0.183.2.
   Mitigation: the pass node pre-warm entry point is present in the 0.182 types,
   so casting is minimal; add narrow casts only where a 0.183 addition is missing.

## Alternative Approaches

1. Synchronous single pre-warm render under the splash (call the post render once
   before reveal, no compileAsync): simplest, but both codegen and GPU compile
   block the main thread synchronously, so it only avoids starving the build if
   performed strictly after the build completes, forfeiting the overlap benefit.
2. Reveal on the near high-LOD chunks instead of the full quadtree (FINDINGS item
   A first lever): largest perceived-load win and orthogonal to the compile fix,
   but risks distant-LOD pop-in and needs a near-set-ready signal from the chunk
   manager; combinable with this change later.
3. Dedicated throwaway pre-warm scene built from representative meshes, decoupled
   from the live build and visibility: avoids gating, but risks cache-key
   divergence from the live pipelines, which would silently fall back to a live
   compile.
4. Bump the chunk worker pool from the hardcoded count toward hardware
   concurrency: cheap, but only helps if the build is worker-bound rather than
   main-thread-starved; the compile fix addresses the starvation directly and
   should be measured first.
