# weather — precipitation plugin

Self-contained, detachable rain/snow effect for the offshore-wind digital twin.
Lives outside `ocean/` so the planned story refactor can move the whole effect by
moving this one folder, and outside `packages/` so the ocean stays PR-able upstream.

## Contract

Two files, mirroring the `cloud-coverage.ts` → `CloudLayer.tsx` (factory + wrapper) pattern:

- **`createPrecipitationSystem.ts`** — pure factory. No React, no scene imports.
  Returns `{ object3D, update(camera), sync(values), dispose }`. Inputs are only
  the camera, plain CPU numbers, and (implicitly) the renderer's `time` node.
- **`Precipitation.tsx`** — thin R3F wrapper. Mounts `object3D` via `<primitive>`,
  calls `update`/`sync` each frame, derives the altitude fade and the ENU wind
  vector from props. Mount/unmount the whole feature by adding/removing this element.

The story's footprint is one mount line plus two pass-through props
(`precip`, `airTemperature`). Nothing scene-specific leaks into the module.

## How it works

Drops are an `InstancedMesh` of `MeshBasicNodeMaterial` streak quads,
**world-oriented** as a cylindrical billboard about the velocity axis: the length
runs along the drop's velocity (`normalize(wind + gravity)`), the width turns to
face the camera. Because it's a real 3D quad it **foreshortens to a dot when you
look straight up/down the rain** — a fixed-size camera-facing sprite cannot, and
shows full-length streaks at the wrong angle (that was a failed iteration). The
camera-local frame is **right-handed** (`makeBasis(east, north, up)`, +Z up);
a left-handed basis makes `setFromRotationMatrix` emit a reflected quaternion that
flips gravity with the view angle (rain falls up — another bug that bit us).
Per-drop motion is **analytic in the node graph** — position is a closed-form
function of the renderer `time` node and `instanceIndex`-seeded `hash` randoms
(fall via `mod(time)`, continuous wind drift wrapped into the box, snow sway via
`sin`). The
field is parented to a Group that is re-positioned and ENU-oriented on the camera
every frame, so `+Y` is geocentric up (drops fall toward the planet) and the box
follows the eye — scene size is irrelevant, only the near field is ever drawn.

Rain and snow are one system; the `mode` uniform (0 rain / 1 snow) blends fall
speed, sway, scale, shape alpha, and colour. Intensity scales the visible drop
budget and the drawn instance count; the altitude fade zeroes opacity from orbit.

**Underwater** is a second blend axis: a `uw` (0→1) factor — fed from the host's
existing submerged detector via the `submerged` getter prop — morphs the same
drops into slow-rising (`uwRise`), sideways-drifting, small square suspended
specks (not air bubbles). Surface wind fades out underwater; vertical velocity
flips from `-fallSpeed` to `+uwRise`. Underwater particles are **always present**
(baseline `underwaterIntensity`, independent of rain above), so the host mounts
the system whenever enabled and trims the visible budget when nothing shows.

### Deviation from the plan (deliberate)

The plan specified a WebGPU compute path. This ships the **analytic GPU-instancing**
path instead: rain is stateless falling motion, so a closed-form node graph needs
no compute dispatch and no storage buffers. Benefits: far fewer failure modes for
a build that can't be visually unit-tested here, and it runs on **both** the WebGPU
and the WebGL2-fallback backends (the compute path would have needed a backend
guard). The factory's React contract is unchanged, so an internal swap to compute
later (e.g. for collision-based splash) needs no caller changes.

## Deferred (phase 2)

- **Splash ripples** on the analytic sea surface (plan task 9). Deferred: the
  riskiest piece to land without visual verification. The factory can add an
  impact-event buffer without changing the wrapper API.
- **Scene-response** — precipitation-driven ocean wetness / atmosphere darkening /
  visibility drop (plan task 10). Deferred: requires editing the shared ocean and
  atmosphere materials, which are PR-constrained and out of this module's scope.

## Manual test checklist (no automated visual test in this repo)

1. Typecheck clean, then clean-restart the dev server (stale TSL pipelines lie).
2. Storybook `GlobeWaterproOcean`: open the **Precipitation** leva panel, set
   source = manual, intensity up — drops appear near the surface.
3. Pull the camera to orbit — drops fade out; return to surface — they return.
4. Raise wind speed / change wind-from — streaks lean and drift.
5. Switch mode to snow (or set a sub-zero air temp via the deploy) — slow swaying
   flakes, no lean.
6. Deploy: scrub the forecast — rain intensity tracks MET `precipitation`; zero/null
   precipitation draws nothing (no synthesized shower).
