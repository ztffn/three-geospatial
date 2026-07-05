// Typed camera-command contract between the twin shells (visitor/author) and
// the 3D scene. FlyToTarget is the scene's own fly payload (canonical type in
// GlobeWaterproOcean-Story, re-exported here so shells/author code don't
// import the story for a type); CameraCommand is the dispatch union author
// tooling drives the camera with, bypassing Leva and scene internals.

import type { FlyToTarget } from '../../../storybook-webgpu/src/ocean/GlobeWaterproOcean-Story'
import type { CameraMode } from '../ui/DigitalTwinUI'

export type { FlyToTarget }

// Author-side camera dispatch. The dispatcher (TwinExperience) owns the fly
// nonce and the FPS respawn derivation, so producers only state intent.
// A 'follow-path' variant (tour runtime driving the camera along a
// SerializedEnuBezierPath) is deliberately reserved for the gravis-plan
// Phase 5 tour runtime — additive next to CameraRig/FpsRig, not a rewrite.
export type CameraCommand =
  | { type: 'fly-to'; target: Omit<FlyToTarget, 'nonce'> }
  | { type: 'set-mode'; mode: CameraMode }
  // Re-run the FPS spawn for the active scenario/viewpoint (no-op in orbit).
  | { type: 'respawn' }
