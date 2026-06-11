// Committed cable-bake snapshot for TurbineCables. When the snapshot's sig
// matches the live scene inputs, cables load instantly from these node paths
// (no terrain raycasts, no Verlet solve, no tile-streaming wait). Regenerate:
// let the scene bake (or click the Cables folder's 'Rebake' once tiles look
// loaded), click 'Copy bake', and paste the clipboard over this file.
//
// Currently null: the last captured snapshot predated the solver fixes
// (per-segment rest lengths + ceiling clamp) and contained sky arches.
// Capture a fresh one from a bake you've eyeballed.

import type { CableBakeSnapshot } from './TurbineCables'

export const CABLE_BAKE: CableBakeSnapshot | null = null
