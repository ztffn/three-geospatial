# fish — shallow-water school prototype

Self-contained fish-school effect for testing offshore/ocean scenes before a
package-level implementation.

## Contract

- `createFishSchoolSystem.ts` is a pure Three.js factory. It returns
  `{ object3D, sync(values), update(delta), dispose }`.
- `FishSchool.tsx` is the thin R3F wrapper. Mount/unmount it like any other scene
  component.
- `FishSchool-Story.tsx` is a tuning scene with two schools and Storybook
  controls.

## First-pass design

This intentionally uses CPU motion plus instancing. The important thing being
tested is not raw particle count; it is the control model:

- horizontal spread: `radiusX`, `radiusZ`
- shallow-water vertical constraint: `depth`
- body scale: `size`, `fishLength`, `fishHeight`
- motion: `speed`, `wander`, `turnRate`, `currentX`, `currentZ`

Depth constrains positions inside an oblate ellipsoid. It does not scale the
mesh, so textures and fish body proportions remain intact.

## Motion model

Each fish steers toward a per-fish interior roaming target (re-rolled on arrival
or on a 2.5–6.5 s timer), with perpendicular wander jitter, a soft inward bias
that ramps once it nears the shell, and a gentle `current` drift. Heading is
lerped toward the goal at `turnRate` (steering responsiveness), then renormalized
to `speed` (constant swim pace, in units/s — it is no longer multiplied by
`turnRate`). There is no standing center force balanced against the current, so
fish do not pool on the downstream boundary; the ellipsoid clamp is only a
safety net.

`flock` (0→1) blends the heading away from the private target and toward a
flocking direction: a shared, time-morphing flow field (`flockScale` sets the
swirl size) plus cohesion toward the nearest of `flockGroups` drifting group
centres. Neighbouring fish sample the same field and the same centres, so they
align into swirling streams and gather into a few distinct schools. A per-fish
bond oscillates the cohesion in and out, so fish continually detach, stream
between groups, and rejoin (sometimes a new one) — schools that flow in and out,
no neighbour search (O(groups) per fish). Default off; the schools opt in.

## Rendering and tail bend

One `InstancedMesh` carries the whole school. CPU motion writes per-instance
attributes (`aPos`, `aFwd`) every frame; `aMap` (atlas variant) and `aPhase`
(tail-beat offset) are fixed at birth. A `MeshStandardNodeMaterial` (PBR, lit by
the scene) does the rest on the GPU: `positionNode` rebuilds the per-fish
orientation basis from `aFwd` (it must, because `positionNode` overrides the
instance matrix entirely), bends the body-length-segmented quad with the
threejs-toys tail wave — `sin(phase + dTail·1.5π)·smoothstep(2,0,dTail)` — which
peaks at the tail and is zero at the head, and sweeps it along the lateral axis.
`tailBeat` sets the wave rate, `tailAmplitude` the sweep as a fraction of body
length, `fishWidthSegments` the bend smoothness. The atlas variant (`aMap`) feeds
the colour, dimmed by `brightness` so the bright photo doesn't clip to white
under strong scene light. Lighting: if a `normalUrl`/`normalTexture` (OpenGL
tangent-space normal map, same canvas/frames as the albedo) is given, it drives
per-pixel lighting via a TBN built from the per-fish axes (U = −forward,
V = up, face = side), flipped on back faces — so fish catch light with real body
curvature. Without one it falls back to a constant **up** normal (consistent both
faces, no heading flicker). `metalness`/`roughness` set the specular gloss. It
renders as an **opaque alpha-cutout** (alphaTest
+ depthWrite) so fish don't read as see-through or draw through each other. The
swim volume is **raised by half
its height** (rendered at `y ∈ [0, 2·depth]`, simulated centred), so it hangs
below an anchor at its top rather than straddling it. Because the bend is lateral
(perpendicular to the flank), it reads strongest from above/three-quarter views
and foreshortens on a pure broadside — same trade-off as the original.

If this visual direction holds up in the full water scene, the same public
factory/wrapper contract can later be backed by a GPU/TSL update path without
changing callers.
