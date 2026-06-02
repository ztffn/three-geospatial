// Gerstner overlay — direct port of the decompiled WaterPro Gerstner code.
// Reference: full-shader-decoded.js line 98 (CPU setup + yF.evaluateGerstnerCPU).
//
// Buffer layout (matches WaterPro exactly):
//   buffer[2*i + 0] = (dirX, dirZ, amplitude, wavelength)
//   buffer[2*i + 1] = (steepness, phase, frequency, 0)
//
// At setup time:
//   k = 2π / wavelength
//   ω = sqrt(g · k)         deep-water dispersion
//   phase = 137.5° · i  mod 2π    golden-angle distribution to scatter waves
//
// At evaluate time (per fragment/vertex, world-XZ position p, time t):
//   θ = (dirX·p.x + dirZ·p.z) · k − ω·t + phase
//   Δx +=  −Q · a · dirX · sin(θ)
//   Δy +=        a       · cos(θ)
//   Δz +=  −Q · a · dirZ · sin(θ)
//   ∂y/∂x += dirX · k · a · sin(θ)
//   folding+= Q    · k · a · cos(θ)
//   ∂y/∂z += dirZ · k · a · sin(θ)
//   normal = normalize(∂y/∂x, 1 − folding, ∂y/∂z)
//
// Folding is the sum of Q·k·a·cos(θ); when high it signals overlapping crests
// — WaterPro subtracts it from the cascade Jacobian eigenvalue so foam doesn't
// double up on Gerstner-driven breakers.

import * as THREE from 'three/webgpu'
import {
  Fn,
  Loop,
  cos,
  float,
  normalize,
  sin,
  storage,
  uint,
  uniform,
  vec3,
  vec4,
} from 'three/tsl'

const GRAVITY = 9.81
const GOLDEN_ANGLE = 137.5 * (Math.PI / 180) // radians

export interface GerstnerWaveSpec {
  /** Direction in horizontal plane (will be normalized). */
  direction: { x: number; z: number }
  /** Wavelength in world meters. */
  wavelength: number
  /** Vertical amplitude in world meters. */
  amplitude: number
  /** Steepness 0..1 (Q parameter in Gerstner formulation). */
  steepness: number
}

export interface GerstnerOverlayParams {
  /** Maximum number of waves (must match the buffer capacity). */
  maxWaves: number
}

export interface GerstnerEvalOutputs {
  /** Summed Gerstner displacement (vec3): (Δx, Δy, Δz). */
  displacement: any
  /** Unit normal contribution (vec3). Added to cascade normal at fragment. */
  normal: any
  /** Folding scalar — subtract from cascade Jacobian eigenvalue. */
  folding: any
}

/**
 * Owns the packed wave buffer + a count uniform. Construct once, populate via
 * `setWaves(...)` whenever the wave list changes, then call `evaluate(...)` in
 * TSL graphs.
 */
export class GerstnerOverlay {
  readonly maxWaves: number
  readonly buffer: THREE.StorageBufferAttribute
  readonly count: any  // TSL uniform — current active wave count
  private readonly bufferNode: any  // storage(...).toReadOnly()

  constructor(params: GerstnerOverlayParams) {
    this.maxWaves = params.maxWaves
    // Two vec4 entries per wave.
    this.buffer = new THREE.StorageBufferAttribute(
      new Float32Array(params.maxWaves * 2 * 4),
      4
    )
    this.bufferNode = storage(this.buffer, 'vec4', this.buffer.count).toReadOnly()
    this.count = uniform(0)
  }

  /**
   * Populate the buffer with up to `maxWaves` waves. Frequency and phase are
   * computed at setup time per WaterPro's golden-angle scatter.
   */
  setWaves(waves: readonly GerstnerWaveSpec[]): void {
    const n = Math.min(waves.length, this.maxWaves)
    const arr = this.buffer.array as Float32Array
    for (let i = 0; i < n; i++) {
      const w = waves[i]
      const dx = w.direction.x
      const dz = w.direction.z
      const len = Math.hypot(dx, dz) || 1
      const dirX = dx / len
      const dirZ = dz / len
      const k = (2 * Math.PI) / Math.max(w.wavelength, 1e-4)
      const omega = Math.sqrt(GRAVITY * k)
      const phase = (GOLDEN_ANGLE * i) % (2 * Math.PI)

      // [2i + 0] = (dirX, dirZ, amplitude, wavelength)
      arr[(2 * i + 0) * 4 + 0] = dirX
      arr[(2 * i + 0) * 4 + 1] = dirZ
      arr[(2 * i + 0) * 4 + 2] = w.amplitude
      arr[(2 * i + 0) * 4 + 3] = w.wavelength
      // [2i + 1] = (steepness, phase, frequency, 0)
      arr[(2 * i + 1) * 4 + 0] = w.steepness
      arr[(2 * i + 1) * 4 + 1] = phase
      arr[(2 * i + 1) * 4 + 2] = omega
      arr[(2 * i + 1) * 4 + 3] = 0
    }
    // Zero out unused slots (in case wave count shrank).
    for (let i = n; i < this.maxWaves; i++) {
      for (let j = 0; j < 8; j++) {
        arr[i * 8 + j] = 0
      }
    }
    this.buffer.needsUpdate = true
    this.count.value = n
  }

  /**
   * Evaluate the Gerstner sum at world-XZ position for animation time t.
   * Returns displacement (vec3) + normal (vec3) + folding (f32) as TSL nodes.
   *
   * Implementation note: TSL `Fn` cannot return a struct cleanly so we run two
   * Fns — one returning displacement (vec3), another returning (nx, ny, nz,
   * folding) packed into a vec4. The loops compile to identical WGSL bytecode
   * pairs; cost is one extra buffer traversal per Gerstner sample.
   */
  evaluate(worldXZ: any, timeSec: any): GerstnerEvalOutputs {
    const buf = this.bufferNode
    const count = this.count

    const dispFn = Fn(([worldXZ_, t_]: any[]) => {
      const dx = float(0).toVar()
      const dy = float(0).toVar()
      const dz = float(0).toVar()
      Loop({ start: uint(0), end: count, type: 'uint', condition: '<' }, ({ i }: any) => {
        const w0 = buf.element(i.mul(uint(2)))
        const w1 = buf.element(i.mul(uint(2)).add(uint(1)))
        const dirX = w0.x, dirZ = w0.y, amp = w0.z, wavelen = w0.w
        const steep = w1.x, phase = w1.y, omega = w1.z
        const k = float(2 * Math.PI).div(wavelen.add(float(1e-4)))
        const theta = dirX.mul(worldXZ_.x).add(dirZ.mul(worldXZ_.y)).mul(k)
          .sub(omega.mul(t_))
          .add(phase)
        const s = sin(theta)
        const c = cos(theta)
        dx.addAssign(steep.mul(amp).mul(dirX).mul(s).negate())
        dy.addAssign(amp.mul(c))
        dz.addAssign(steep.mul(amp).mul(dirZ).mul(s).negate())
      })
      return vec3(dx, dy, dz)
    })

    const nrmFoldFn = Fn(([worldXZ_, t_]: any[]) => {
      const nxAcc = float(0).toVar()
      const folding = float(0).toVar()
      const nzAcc = float(0).toVar()
      Loop({ start: uint(0), end: count, type: 'uint', condition: '<' }, ({ i }: any) => {
        const w0 = buf.element(i.mul(uint(2)))
        const w1 = buf.element(i.mul(uint(2)).add(uint(1)))
        const dirX = w0.x, dirZ = w0.y, amp = w0.z, wavelen = w0.w
        const steep = w1.x, phase = w1.y, omega = w1.z
        const k = float(2 * Math.PI).div(wavelen.add(float(1e-4)))
        const theta = dirX.mul(worldXZ_.x).add(dirZ.mul(worldXZ_.y)).mul(k)
          .sub(omega.mul(t_))
          .add(phase)
        const s = sin(theta)
        const c = cos(theta)
        const kAmp = k.mul(amp)
        nxAcc.addAssign(dirX.mul(kAmp).mul(s))
        folding.addAssign(steep.mul(kAmp).mul(c))
        nzAcc.addAssign(dirZ.mul(kAmp).mul(s))
      })
      return vec4(nxAcc, folding, nzAcc, folding)
    })

    const displacement = dispFn(worldXZ, timeSec)
    const packed = nrmFoldFn(worldXZ, timeSec)
    const nx = packed.x
    const folding = packed.y
    const nz = packed.z
    const normal = normalize(vec3(nx, float(1).sub(folding), nz))

    return { displacement, normal, folding }
  }

  dispose(): void {
    // StorageBufferAttribute has no explicit dispose; GPU buffer cleanup is
    // handled by the renderer when the node is no longer referenced.
  }
}

/**
 * Default 4-wave demo configuration — varied directions/wavelengths roughly
 * matching the WaterPro medium-quality preset (gerstnerMaxWaves = 2..4).
 */
export const DEFAULT_GERSTNER_WAVES: GerstnerWaveSpec[] = [
  { direction: { x: 1.0, z: 0.3 }, wavelength: 80, amplitude: 0.8, steepness: 0.6 },
  { direction: { x: 0.5, z: 1.0 }, wavelength: 40, amplitude: 0.4, steepness: 0.5 },
  { direction: { x: -0.8, z: 0.6 }, wavelength: 20, amplitude: 0.15, steepness: 0.45 },
  { direction: { x: -0.3, z: -1.0 }, wavelength: 12, amplitude: 0.08, steepness: 0.4 },
]
