# Cloud reflection — vertical line artefact (DEBUG LOG)

Living reference for the single-line artefact on the globe WaterPro ocean.
READ THIS before touching cloud-coverage.ts / buildWaterproOceanMaterial.ts.
Do NOT re-ask the user things already confirmed below. Update as facts land.

## ✅ RESOLUTION (do not reopen without reading this)

The line is **NOT a wrong number** and **NOT localizable by visualization.**
Proven this session by dumping and diffing the generated WGSL (debug-present vs
debug-absent, procedural source):

1. The cloud-reflection math (`reflect`/`rayShellDir`/`sampleCloud`/horizon/gate)
   is **byte-identical** whether or not the line shows. There is no precision
   bug to fix in the math — viewDir ECEF subtraction, `rayShellDir` cancellation,
   the `finiteDir` gate, the noise hash were all checked and are identical or
   provably continuous.
2. The artefact is the **GPU driver scheduling/fusing that identical math
   differently** depending on surrounding shader structure (register pressure /
   FMA / instruction order). The old `debugMode`/`cloudDebug` path hid the line
   only because it wrapped the emissive in an `if/else` scope as a side effect —
   a real, deterministic structural change, not a 1-ULP fluke.
3. Because observation requires *adding graph*, and adding graph changes the
   structure, the line can NEVER be seen via a `debugMode`-style paint. Confirmed.

**The fix (shipped) — the "compile-ordering fence":** in
`buildWaterproOceanMaterial.ts`, the emissive is wrapped in an always-false
`select` driven by a runtime uniform (`emissiveFence = uniform(0)`):
`emissiveFence.greaterThan(0).select(vec3(0), totalEmissive)`. This forces the
TSL→WGSL compiler to emit the emissive inside its own `if/else` scope (verified
in the generated WGSL — the reflection compiles inside the `else`), so the driver
builds the reflection in isolation and the sub-pixel line does not appear. The
uniform must be runtime-valued — a literal `0` would be constant-folded and the
box (and the line's absence) would vanish.

Trade-off, stated honestly: this is **structural isolation**, not a corrected
number. On the tested GPU/driver it is deterministic. A very different driver
*could* schedule the isolated block differently — if the line ever returns,
re-dump the WGSL and confirm the `if/else` box is still present before touching
the reflection math (which is, again, not wrong).

Verified: clean restart (vite cache cleared, fresh tab), debug fully stripped,
fence in place → line gone, in both procedural and live source. WGSL shows
`if ((emissiveFence > 0)) { e = vec3(0) } else { <reflection+shadow> }`.

## The artefact
A single thin line (~1px native; waves chop it into a dashed look, projection
widens it) on the ocean surface. See user screenshot: runs from near the
horizon toward the camera, slight curve.

## CONFIRMED facts (do not re-test)
- Appears in **BOTH** `procedural` AND `live` source modes. (Mode-independent.)
- **Follows the camera**; parallaxes "like the sky reflection". → view-dependent.
- **Sun-independent**: unchanged by Atmosphere → Local time / day of year.
- Visible looking along its direction or 180° opposite → great-circle-like locus.
- **Gone only when Clouds → enabled = false.** So it is the cloud injection.
- No effect from: opacity, altitude, intensity, density, contrast, windSpeed,
  tiles.
- `reflectionStrength` / `shadowStrength`: on a clean restart, neither at 0
  reliably removed it. `shadowStrength=1` made it less visible (likely overall
  water darkening masking it, since the line is sun-independent → not the shadow
  projection itself). `coverage` removed it in ONE early (pre-clean) test but
  NOT reproducibly afterwards — treat as unreliable.

## RULED OUT (with evidence)
- **Live equirect mipmap seam** as the root: insufficient — procedural has no
  texture yet shows the same line. (Mipmap-disable on the live tex was still
  applied as a real correctness fix, but it is NOT the cross-mode root.)
- **Close-shell reflection magnification**: switching the reflection to
  directional sampling (`sampleCloud(reflectDir)` instead of the shell hit) did
  NOT remove the line and made reflections look wrong → reverted.
- **ECEF-scale NaN in rayShellDir**: fixed earlier (radius-normalized solve).
  Not this line. The `n + s·dir` hit is unit-length by construction.
- **Degenerate-reflectDir NaN poisoning the whole frame**: that was the SEPARATE
  black/white-no-atmosphere bug, fixed via finiteDir scrub + staged load. Not
  this line.

## IMPLICATION (current best model)
Mode-independent + view-dependent + sun-independent ⇒ the line lives in the
**shared reflection geometry**, identical across source modes:
`reflectDir` → `finiteDir/gate` → `rayShellDir` → `horizon` cull.
NOT in the coverage content (FBM vs texture differ by mode), NOT in the
sun/shadow path. The only hard (1px-capable) element is the `gate` select; the
`horizon` smoothstep is a soft band; `rayShellDir`/`reflectDir` are continuous
in theory — so something there is not behaving as the code implies.

## Method going forward
STOP theorising. Use the live debug switch (Clouds → debugMode) added to
visualise each shared term straight onto the ocean colour:
  1 = gate, 2 = horizon, 3 = edged coverage, 4 = rayShellDir hit dir (RGB),
  5 = reflectDir (RGB), 6 = scrubbed reflectDir f.dir (RGB).
Drag debugMode live; the term whose image shows the line IS the cause. Report
which number shows it, then fix exactly that.

## UPDATE — compass data (strong lead)
- Line sits on a FIXED WORLD great circle at azimuth ~0/180 (framed at cam
  heading ~182 one side, ~2 the other — same circle, "opposite side"), near
  ZERO pitch (horizon).
- Parallax IDENTICAL to the cloud texture, MIRRORED → it's a reflection of a
  feature ON THE SHELL (sampleCloud seam), visible in sky + water.
- Sun-independent. `shadowStrength` does nothing to it (shadow verified still
  wired — line is the REFLECTION, not shadow). Not moved by tiles/wind.
- Azimuth 0/180 at Karmøy = the ECEF **dir.y = 0** great circle (X–Z plane:
  North-pole axis + prime meridian). Karmøy ≈ 5°E ≈ on the prime meridian, so
  that plane appears as the local N–S line.
- `dir.y = 0, dir.x < 0` is exactly the **atan(dir.y, dir.x) branch cut** in the
  LIVE equirect UV → antimeridian seam, landing locally because of the site.
- PRIME HYPOTHESIS: live equirect atan seam. Mipmap-disable fixes the mip
  derivative but NOT a texture-content edge mismatch at lon ±180; the branch
  cut + bilinear should wrap, so if it persists it's content-edge or the cut's
  derivative. PROCEDURAL has no atan → if a line truly shows in procedural it is
  a DIFFERENT/secondary thing; re-verify procedural in isolation.
- DECISIVE ROTATE TEST: change Location longitude away from 0. If the line's
  azimuth rotates with longitude → ECEF-fixed equirect seam (live). If it stays
  at local N–S regardless of location → reflection-geometry, local-frame-fixed.

## UPDATE — line GONE (both modes), no slider change
After: (a) live texture mipmaps disabled, (b) debug-viz plumbing added which
restructured buildWaterpro colorNode/emissive into `active.select(...)` — a
logical no-op at debugMode=0 but a GRAPH change forcing a fresh shader recompile.
Leading explanation:
- PROCEDURAL line = stale-pipeline ghost, cleared by the forced recompile. (The
  only functional change touching procedural is the graph restructure, which
  doesn't change the math.)
- LIVE line = equirect mip seam, genuinely fixed by disabling mipmaps.
CONFIRM real-vs-stale: full clean restart (kill server, `rm -rf
storybook-webgpu/node_modules/.vite`, fresh tab). Line stays gone on clean boot
⇒ real code fix; commit. Line returns ⇒ it was stale state; keep the debugMode
tool (already wired) and read which term shows it.
Location test earlier CONFIRMED live line tracks ECEF (rotates with longitude) →
consistent with the equirect seam being the live-mode cause.

## History of failed/guessed fixes this session (so we don't repeat)
1. radius-normalized rayShellDir — fixed a real NaN (black/white), kept.
2. finiteDir scrub on reflectDir — fixed frame-poisoning NaN, kept.
3. horizon cull — fixed a below-horizon streak (different artefact), kept.
4. asin clamp (live) — defensive, kept.
5. directional reflection — WRONG, reverted.
6. live mipmap disable — real fix for live seam, kept, but NOT this line's root.
