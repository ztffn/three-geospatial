// CPU mirror of the vertex-stage Gerstner overlay so gameplay code (ship
// buoyancy probes) can sample the Gerstner component of the ocean surface
// without GPU readback. MUST stay math-identical to gerstnerSingle/gerstnerSum
// in resources/shader/ocean/fragments/gerstner.wgsl.js — same vec4 wave layout
// (dirX, dirZ, wavelength, amplitude), hardcoded phases 0/2.1/4.2, ω=√(g·k).

import type { Vector3, Vector4 } from 'three'

const GRAVITY = 9.81
const TWO_PI = 6.2831853
// Phases match gerstnerSum's hardcoded per-slot values in gerstner.wgsl.js.
const SLOT_PHASES = [0.0, 2.1, 4.2]

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
  const k = TWO_PI / Math.max(wave.z, 0.001)
  const omega = Math.sqrt(GRAVITY * k)
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
  const waves = [wave0, wave1, wave2]
  for (let i = 0; i < 3; i++) {
    // Zero-amplitude slots are disabled, same as the WGSL early-out.
    if (waves[i].w > 0) {
      gerstnerSingleCPU(x, z, t, waves[i], steepness, SLOT_PHASES[i], out)
    }
  }
  return out.multiplyScalar(strength)
}
