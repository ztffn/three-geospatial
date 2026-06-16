# Wet-Lens Raindrop Refraction (out-of-water polish effect)

## Objective

Add a "wet lens" raindrop-on-glass refraction as a minor, out-of-water polish effect for the
WebGPU digital twin: droplets on the camera lens that refract the already-rendered scene. This is
a **screen-space post effect**, not scene geometry (unlike the rain plugin in
`storybook-webgpu/src/weather/createPrecipitationSystem.ts:1`). It ships as a new self-contained
TSL fullscreen refraction node, `storybook-webgpu/src/weather/lensDropsNode.ts` — a SIBLING of the
precipitation factory, not a modification of it — wired into the existing post pipeline in
`storybook-webgpu/src/ocean/GlobeWaterproOcean-Story.tsx`.

Expected outcome: when it is raining, the camera is out of the water, and near the surface, faint
procedural droplets appear on the lens and refract/magnify the composited scene beneath them; the
rest of the frame stays untouched (identity) so the effect is invisible in clear weather, when
submerged, and from orbit. Cost is one framebuffer-class render-target copy plus one fullscreen
pass per frame (same class as bloom/DOF), independent of scene complexity — confirmed in the
session spike and approved on perf grounds.

This plan covers planning only. No code is written here. Implementation is deferred to an
implementation agent after the plan is aligned with the user.

## Established context (spike findings — treat as approved defaults)

- **Technique:** procedural fullscreen shader (greentec / codrops "rain on glass"). Droplets live
  on a screen grid (snap UV to a per-cell centre, then a per-cell hash), with a time-fade lifecycle. The lens look is
  produced by computing a fake per-drop spherical normal and sampling the scene color at
  `screenUV + normal.xy * strength` (refraction); non-drop areas are slightly blurred (wet-glass
  defocus). No particles, no assets. The heavier Lucas Bebber codrops variant (2D trails + merging
  over a static image) is a worse fit for a live 3D scene and is rejected.
- **Cost model:** refraction samples the *already-rendered* framebuffer; it does NOT re-render the
  scene. Verified: `convertToTexture` / `rtt` exist in three 0.183.2 at
  `node_modules/three/src/nodes/utils/RTTNode.js:282` and `:269`; `convertToTexture` wraps a
  non-pass node in an `RTTNode` that extends `TextureNode` (so it can be offset-sampled by a UV
  node, `node_modules/three/src/nodes/accessors/TextureNode.js:632`) and renders the node into its own
  render target once per frame (`autoUpdate`, `updateBeforeType = RENDER`,
  `node_modules/three/src/nodes/utils/RTTNode.js:106,132`). Cost = one extra fullscreen RTT render +
  one fullscreen lens pass per frame, scene-independent.
- **The one integration risk (materialize-composite seam):** `viewportSharedTexture` samples the
  "framebuffer so far", which in a single-pass node graph is NOT the current frame's final
  composite — so it cannot refract the freshly computed atmosphere+ocean+rain composite mid-graph.
  The composite must be materialized into a texture FIRST (via `convertToTexture`), then the lens
  node offset-samples that texture. This touches the shared `postProcessingData` memo in the story
  (`storybook-webgpu/src/ocean/GlobeWaterproOcean-Story.tsx:3287`, `outputNode` at `:3356`).
- **Gating (reuse, no new plumbing):** show only when raining (`precipIntensity`,
  `storybook-webgpu/src/ocean/GlobeWaterproOcean-Story.tsx:3172`), out of water
  (`1 - underwaterUniforms.underwaterT.value`, `:2574`), and near-surface / not orbital (the same
  altitude fade `Precipitation.tsx:99-105` computes from `seaLevelRadius = target.length()`,
  `:3703`). `underwaterT` changes faster than React renders, so it must be read via a per-frame
  getter, exactly as the `submerged` getter prop is wired on the `<Precipitation>` element
  (`storybook-webgpu/src/ocean/GlobeWaterproOcean-Story.tsx:3698`).
- **TSL footguns to honour:** right-handed `makeBasis` only; object / vec2 uniforms mutated in
  place may not re-upload — use scalar uniforms and reassign `.value` (per
  `createPrecipitationSystem.ts:116-119`); use the free `mix(a, b, t)` not the chained `.mix()`.

## Implementation Plan

- [ ] 1. **Pre-flight: confirm baseline and re-verify the seam API before any edit.** Re-read the
  plugin pattern files to ensure they still match this plan: `storybook-webgpu/src/weather/README.md`
  (overlay-pass vs depth gotcha — why rain composites in the overlay scene, not as main-scene
  geometry), `storybook-webgpu/src/weather/createPrecipitationSystem.ts:1` (factory contract,
  `PRECIP_DEFAULTS` single-source pattern at `:85`, the TSL idioms), and
  `storybook-webgpu/src/ocean/cloud-coverage.ts:1` (the self-contained TSL node module shape this
  node should mirror: defaults constant + factory returning uniforms / closures / `sync` /
  `dispose`). Start the twin dev server (`pnpm run dev:globe-waterpro`) and confirm it boots clean
  with the current rain effect working, establishing a known-good baseline before touching the post
  pipeline. Rationale: the post memo is shared and previously-fixed (depth-prepass, aerial
  perspective, overlay composite) — a clean baseline makes any regression attributable to this work.

- [ ] 2. **Create the `lensDropsNode.ts` module skeleton and contract.** Add
  `storybook-webgpu/src/weather/lensDropsNode.ts` as a sibling of `createPrecipitationSystem.ts`,
  with the mandatory five-line file-purpose header (load-bearing per project rules). Mirror the
  `cloud-coverage.ts` module shape: export a `LENS_DROPS_DEFAULTS` constant (single source of truth
  for tunables — droplet grid density, refraction strength, wet-glass blur radius, base drop
  opacity / rim highlight, lifecycle rate), a `LensDropsValues` interface (the per-frame CPU values
  pushed in: effective `strength`, optional `density`, and any animated params), a `LensDrops`
  return interface, and a `createLensDrops()` factory. The factory returns `{ uniforms,
  apply(sceneColor) , sync(values), dispose }`, where `apply` takes a materialized scene-color
  texture node and returns the refracted output node, and `sync` reassigns scalar uniform `.value`s
  (NOT in-place vec mutation — honour `createPrecipitationSystem.ts:116-119`). No React, no scene
  imports — pure node/TSL module. Rationale: keeping the node self-contained and detachable matches
  the weather-plugin contract (`README.md:7-19`) and lets the story's footprint stay to one wire-in
  plus a leva panel.

- [ ] 3. **Implement the procedural droplet field inside the node.** In `lensDropsNode.ts`, build
  the fullscreen refraction graph driven by `uv()` and the renderer `time` node, using the
  approved procedural-shader technique. Compose: (a) a wet-glass base — the scene-color texture
  sampled with a small fixed multi-tap blur so the whole frame reads slightly defocused through the
  water film; (b) a droplet layer — partition screen UV into a hash-seeded grid, place at most one
  drop per cell at a jittered position with a per-cell random radius and birth phase, and search the
  immediate neighbour cells so drops are not clipped at cell borders; (c) a lifecycle — each drop's
  age advances with `time` (and per-cell phase) so drops fade in, sit, and fade out, optionally
  drifting slightly downward along geocentric-screen-down; (d) refraction — inside a drop, build a
  fake spherical normal from the normalized offset to the drop centre (`n.z = sqrt(1 - r^2)`) and
  sample the scene-color texture at `uv` offset by `n.xy * refractStrength`, clamped to `[0,1]` to
  avoid edge smear; (e) a subtle rim highlight for readability. Outside any drop, output the
  wet-glass base. Use the free `mix(a, b, t)` form throughout. Rationale: this is the cheap,
  asset-free technique the spike validated; the fake-normal refraction is what sells the "lens"
  look while costing only a few texture samples per fragment in a single pass.

- [ ] 4. **Define gating and identity-passthrough semantics in the node and its `sync`.** The node
  must collapse to a pure passthrough (scene-color sampled at the unmodified `uv`, no blur, no
  drops) when its `strength` uniform is ~0, so the effect is genuinely invisible in clear weather /
  submerged / orbital states and costs nothing visible. Drive every visible contribution (drop
  opacity, blur amount, refraction magnitude) by the single `strength` scalar uniform so one value
  smoothly fades the whole effect. Keep `strength` and all tunables as scalar uniforms reassigned
  in `sync` (the vec2/object-uniform re-upload footgun, `createPrecipitationSystem.ts:116-119`).
  Rationale: a smooth scalar gate avoids any pipeline rebuild on weather changes and matches how
  the rain plugin fades via `fade`/`intensity` rather than mount/unmount churn.

- [ ] 5. **Wire the materialize-composite seam into the story post pipeline.** In
  `storybook-webgpu/src/ocean/GlobeWaterproOcean-Story.tsx`, inside the `postProcessingData` memo
  (`:3287`), keep the existing composite expression (currently assigned directly to
  `result.outputNode` at `:3356`: `toneMappingNode.add(dithering).mul(overlayPassNode.a.oneMinus())
  .add(overlayPassNode)`) but capture it as a named composite node, materialize it with
  `convertToTexture` (add the import to the `three/tsl` line at `:51`), and set
  `result.outputNode` to `lens.apply(<materialized composite>)`. Gate this structurally on a leva
  `enabled` boolean so that when the lens feature is off the pipeline stays the plain composite (no
  RTT, no extra pass); when on, the smooth `strength` uniform from task 4 handles per-frame
  show/hide. The `lens` instance comes from a `createLensDrops()` held in a stable `useMemo([])`
  (like the precipitation `system`), added to the memo dependency array alongside the new `enabled`
  flag. Rationale: materializing the composite is the only correct way to offset-sample the FINAL
  image (atmosphere + ocean + rain overlay); gating the RTT on a leva toggle keeps the common
  clear-weather path at zero added cost while the strength uniform gives a hitch-free fade.

- [ ] 6. **Add the leva panel and per-frame uniform updates (reuse existing gating signals).** Add
  a "Lens" leva panel near the precipitation panel (`:3126`) seeded from `LENS_DROPS_DEFAULTS`
  (single-source pattern, mirroring how the Precipitation panel seeds from `PRECIP_DEFAULTS` at
  `:3134-3154`): `enabled` toggle plus ranges/labels for refraction strength, droplet density,
  blur, and opacity. In a `useFrame` (or by extending the existing underwater/precip frame logic),
  compute the effective `strength` each frame as the product of: rain factor (from `precipIntensity`
  `:3172`, ramped so light rain still reads), out-of-water factor
  (`1 - underwaterUniforms.underwaterT.value` read live, `:2574`), and the altitude fade (recompute
  the same cubic band as `Precipitation.tsx:99-105` using `seaLevelRadius = target.length()`,
  `:3703`, and a Lens fade band — or reuse the precip fade values). Push that plus the leva tunables
  into `lens.sync(...)`. Read `underwaterT` and camera altitude inside the frame loop (getter
  semantics) since they change faster than React renders. Rationale: all three gates already exist
  and are already proven on `<Precipitation>`; reusing them keeps the story footprint minimal and
  guarantees the lens and the rain plugin agree on "is it raining / am I out of water / am I near
  the surface".

- [ ] 7. **Typecheck, clean-restart, and hand off a manual test checklist.** Run the package
  typecheck for the storybook-webgpu / story target. Because HMR runs the stale TSL pipeline and
  lies, do a CLEAN restart of `pnpm run dev:globe-waterpro` (not a hot reload) after the TSL edits.
  Since there is no Playwright / automated visual test here and the user tests manually, hand off a
  checklist: (a) clear weather out of water — no droplets, frame unchanged; (b) raise rain
  intensity (Precipitation panel source=manual) near the surface — faint droplets appear and
  refract the scene; (c) pull to orbit — droplets fade out with altitude; return — they return; (d)
  dive underwater while raining — lens effect disappears (submerged gate), underwater suspended
  specks unaffected; (e) toggle the Lens `enabled` leva off — pipeline reverts to the plain
  composite with no visible change and no perf delta; (f) confirm framerate is unchanged within
  noise (cost is one RTT + one fullscreen pass). Rationale: the repo's manual-only verification
  workflow requires an explicit, ordered checklist, and the clean-restart guards against a stale
  pipeline reporting a false pass.

## Verification Criteria

- A new file `storybook-webgpu/src/weather/lensDropsNode.ts` exists, carries the five-line
  file-purpose header, imports nothing from React or the scene, and exports `LENS_DROPS_DEFAULTS`,
  the value/return interfaces, and a `createLensDrops()` factory whose return matches the documented
  `{ uniforms, apply, sync, dispose }` contract.
- `createPrecipitationSystem.ts` is unmodified; the lens node is a sibling, not an edit of the rain
  plugin. Nothing under `packages/` is touched (ocean must stay PR-able upstream).
- In `GlobeWaterproOcean-Story.tsx`, the `postProcessingData` memo materializes the existing
  composite via `convertToTexture` and routes it through `lens.apply(...)` when the Lens panel is
  enabled, and falls back to the unchanged composite when disabled; `convertToTexture` is added to
  the `three/tsl` import; the memo dependency array includes the stable `lens` instance and the
  enable flag.
- The effect is a true identity (frame pixel-unchanged) when `strength` is 0 — verified in clear
  weather, when submerged, and from orbit — and visibly refracts droplets only when raining, out of
  water, and near the surface.
- Gating reuses the existing `precipIntensity`, `underwaterUniforms.underwaterT.value`, and
  `target.length()` signals with no new detection plumbing; `underwaterT` and altitude are read
  per-frame, not via React props that would lag.
- Typecheck passes; the twin runs after a CLEAN dev-server restart; the manual checklist (clear /
  rain-near-surface / orbit / submerged / leva-off / perf) is handed off and each item behaves as
  described.
- Added GPU cost is one render-target copy plus one fullscreen pass per frame when enabled, and zero
  when the Lens panel is disabled.

## Potential Risks and Mitigations

1. **Materialize seam wrong — sampling stale or wrong framebuffer.** Using `viewportSharedTexture`
   or sampling before the composite is materialized would refract the previous frame or a partial
   image.
   Mitigation: explicitly `convertToTexture(composite)` (verified RTTNode path,
   `node_modules/three/src/nodes/utils/RTTNode.js:282`) and feed THAT into `lens.apply`; prototype
   this seam first with `strength` forced to a visible value and a trivial constant offset to prove
   the materialized texture is the current frame's final composite before layering on the droplet
   logic.

2. **RTTNode render-target resolution / format mismatch.** `convertToTexture` defaults to
   `pixelRatio = 1` and `HalfFloatType` (`RTTNode.js:83`, `:279`), which may soften the image
   relative to the canvas and could differ from the swap-chain format.
   Mitigation: accept `pixelRatio = 1` as desirable for the wet-glass softening (cheaper, softer);
   if sharpness is needed, pass an explicit size/options to `convertToTexture`. Confirm the
   HalfFloat target round-trips the AgX-tonemapped + dithered composite without banding or clipping
   during the task-7 manual check.

3. **Pipeline rebuild hitch from a per-frame gate.** Gating the RTT structurally on a continuously
   changing value (rain intensity, submersion) would rebuild the post memo and hitch on every
   weather/dive transition.
   Mitigation: gate the RTT structurally ONLY on the leva `enabled` boolean (rare, deliberate
   toggle) and drive all per-frame show/hide through the smooth `strength` scalar uniform, so the
   node graph is built once per enable state.

4. **Refraction offset sampling outside `[0,1]` smears screen edges.** Large `n.xy * strength`
   offsets near the frame border sample outside the texture.
   Mitigation: clamp the offset UV to `[0,1]` (or use clamp-to-edge wrapping on the materialized
   texture) and keep `refractStrength` small; verify the frame edges during manual test.

5. **TSL uniform re-upload footgun.** A vec2/object uniform mutated in place may silently not
   re-upload (the exact bug that zeroed wind in the rain plugin, `createPrecipitationSystem.ts:116`).
   Mitigation: keep `strength` and all tunables as scalar uniforms and reassign `.value` in `sync`,
   exactly as the rain factory does.

6. **Stale-pipeline false pass.** HMR after a TSL edit runs the old compiled pipeline and can show a
   working (or broken) result that does not reflect the new code.
   Mitigation: mandatory CLEAN dev-server restart (not hot reload) before any visual judgement, per
   the weather README test protocol (`README.md:71-73`).

7. **Double-refracting the rain overlay reads oddly.** The materialized composite already contains
   the rain streaks from the overlay pass, so lens drops will also bend the in-scene rain.
   Mitigation: this is acceptable and generally looks correct (drops on glass distort everything
   behind them); if it reads wrong in manual test, the fallback is to materialize and refract the
   pre-overlay tone-mapped image instead and composite the overlay on top afterward — noted as a
   contingency, not the default.

## Alternative Approaches

1. **Two separate `PostProcessing` passes (render composite to an explicit RT, then a second
   fullscreen lens pass).** More explicit control over the intermediate target than
   `convertToTexture`, but adds a second `PostProcessing` object and more story wiring for the same
   cost. Rejected as the default: `convertToTexture` inside the single `outputNode` graph is the
   idiomatic three.js TSL pattern (same as bloom/DOF) and keeps the seam local to the existing memo.

2. **Heavier codrops 2D-trail variant (Lucas Bebber: persistent drops with downward trails and
   merging over a buffered image).** More physically rich trails, but designed for a static image,
   needs persistent state buffers, and is markedly more expensive — a worse fit for a live 3D scene.
   Rejected per the spike.

3. **Scene-geometry droplets on a near-camera plane (like the rain plugin's instanced quads).**
   Reuses the precipitation instancing path, but cannot refract the rendered scene (it would only
   add opaque/blended sprites, not a lens distortion) and reintroduces the depth/overlay
   complications the README documents. Rejected: the requested effect is specifically a screen-space
   refraction of the composite, which only the post-pass approach delivers.

4. **Always-on RTT with no leva enable (gate purely via `strength`).** Simplest wiring and never
   rebuilds, but pays the RTT + fullscreen-pass cost every frame even in clear weather when nothing
   is visible. Rejected as the default in favour of the leva-enable structural gate (task 5), which
   keeps the common path free; can be revisited if the toggle proves unnecessary.
