// CPU mirror of the vertex-stage Gerstner overlay so gameplay code (ship
// buoyancy probes, camera submersion) can sample the Gerstner component of
// the ocean surface without GPU readback. MUST stay math-identical to
// gerstnerSingle/gerstnerSum in resources/shader/ocean/fragments/gerstner.wgsl.js
// — same vec4 layout (dirX, dirZ, wavelength, amplitude), phases, ω=√(g·k).

import type { Vector3, Vector4 } from 'three'

// Mirrors of literals in gerstner.wgsl.js — keep in sync (the WGSL is a JS
// template string; if these ever need to change, change both sides).
export const GERSTNER_GRAVITY = 9.81
export const GERSTNER_TWO_PI = 6.2831853
/** Hardcoded per-slot phases of gerstnerSum's three waves. */
export const GERSTNER_SLOT_PHASES = [0.0, 2.1, 4.2] as const

function gerstnerSingleCPU(
  x: number,
  z: number,
  t: number,
  wave: Vector4,
  steepness: number,
  phase: number,
  out: Vector3
): void {
  const len = Math.hypot(wave.x, wave.y) || 1
  const dirX = wave.x / len
  const dirZ = wave.y / len
  const k = GERSTNER_TWO_PI / Math.max(wave.z, 0.001)
  const omega = Math.sqrt(GERSTNER_GRAVITY * k)
  const amplitude = wave.w
  const theta = k * (dirX * x + dirZ * z) - omega * t + phase
  const qa = steepness * amplitude
  const c = Math.cos(theta)
  out.x += qa * dirX * c
  out.y += amplitude * Math.sin(theta)
  out.z += qa * dirZ * c
}

/**
 * Sum the three vertex-stage Gerstner waves at ocean-local (x, z) for
 * animation time t. Writes (Δx, Δy, Δz) into `out` (overwritten, not
 * accumulated). Δy is the surface height contribution buoyancy wants.
 * Allocation-free — called several times per frame.
 */
export function gerstnerSumCPU(
  x: number,
  z: number,
  t: number,
  wave0: Vector4,
  wave1: Vector4,
  wave2: Vector4,
  steepness: number,
  strength: number,
  out: Vector3
): Vector3 {
  out.set(0, 0, 0)
  // Zero-amplitude slots are disabled, same as the WGSL early-out. Unrolled —
  // no per-call array in this hot path.
  if (wave0.w > 0) {
    gerstnerSingleCPU(x, z, t, wave0, steepness, GERSTNER_SLOT_PHASES[0], out)
  }
  if (wave1.w > 0) {
    gerstnerSingleCPU(x, z, t, wave1, steepness, GERSTNER_SLOT_PHASES[1], out)
  }
  if (wave2.w > 0) {
    gerstnerSingleCPU(x, z, t, wave2, steepness, GERSTNER_SLOT_PHASES[2], out)
  }
  return out.multiplyScalar(strength)
}

/**
 * Structural view of the live vertex-stage uniform bag — matches what
 * OceanChunksWaterpro exposes via onReady without importing its type.
 */
export interface GerstnerVertexUniforms {
  time: { value: number }
  gerstnerWave0: { value: Vector4 }
  gerstnerWave1: { value: Vector4 }
  gerstnerWave2: { value: Vector4 }
  gerstnerSteepness: { value: number }
}

/**
 * Convenience over gerstnerSumCPU that unpacks the live uniform bag — the
 * single place that knows the bag→argument mapping, shared by every CPU
 * sampling site (ship probes, camera submersion).
 */
export function sampleGerstnerUniformsCPU(
  x: number,
  z: number,
  vu: GerstnerVertexUniforms,
  strength: number,
  out: Vector3
): Vector3 {
  return gerstnerSumCPU(
    x,
    z,
    vu.time.value,
    vu.gerstnerWave0.value,
    vu.gerstnerWave1.value,
    vu.gerstnerWave2.value,
    vu.gerstnerSteepness.value,
    strength,
    out
  )
}
