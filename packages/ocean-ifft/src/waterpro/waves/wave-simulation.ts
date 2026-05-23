// Wave simulation backbone — direct port of the decompiled WaterPro SF class.
// Owns the shared butterfly buffer + a set of cascades operating at different
// length scales. The user-facing surface is intentionally minimal: construct,
// update once per frame, sample displacement/normal/jacobian textures from a
// fragment/vertex shader via the helpers in wave-sampler.ts.

import * as THREE from 'three/webgpu'
import { instanceIndex, storage, uint } from 'three/tsl'
// @ts-expect-error — untyped WGSL string module
import { butterflyWGSL } from '../../../resources/shader/IFFT/butterfly.js'
import { WaveCascade } from './wave-cascade.js'
import {
  DEFAULT_CASCADES,
  DEFAULT_RESOLUTION,
  makePrimarySpectrum,
  makeSecondarySpectrum,
} from './wave-defaults.js'
import type {
  CascadeConfig,
  DualSpectrumParams,
  SpectrumParams,
} from './wave-defaults.js'

export interface WaveSimulationParams {
  renderer: any
  resolution?: number
  cascades?: CascadeConfig[]
  // Per-spectrum overrides. If omitted, WaterPro defaults are used.
  primarySpectrum?: SpectrumParams
  secondarySpectrum?: SpectrumParams
}

export class WaveSimulation {
  readonly cascades: WaveCascade[]
  readonly resolution: number
  readonly spectrum: DualSpectrumParams

  private readonly renderer: any
  private readonly butterflyBuffer: THREE.StorageBufferAttribute
  private readonly butterflyCompute: any
  private disposed = false

  constructor(params: WaveSimulationParams) {
    this.renderer = params.renderer
    this.resolution = params.resolution ?? DEFAULT_RESOLUTION
    this.spectrum = {
      primary: params.primarySpectrum ?? makePrimarySpectrum(),
      secondary: params.secondarySpectrum ?? makeSecondarySpectrum(),
    }

    const cascadeConfigs = params.cascades ?? DEFAULT_CASCADES

    // Butterfly buffer — precomputed FFT permutation indices, shared across
    // cascades because it only depends on resolution.
    const logN = Math.log2(this.resolution)
    this.butterflyBuffer = new THREE.StorageBufferAttribute(
      new Float32Array(logN * this.resolution * 4),
      4
    )
    this.butterflyCompute = butterflyWGSL({
      butterflyBuffer: storage(this.butterflyBuffer, 'vec4', this.butterflyBuffer.count),
      index: instanceIndex,
      N: uint(this.resolution),
    }).compute(logN * this.resolution)
    this.renderer.compute(this.butterflyCompute)

    this.cascades = cascadeConfigs.map(cfg => {
      const cascade = new WaveCascade({
        renderer: this.renderer,
        size: this.resolution,
        config: cfg,
        spectrum: this.spectrum,
        butterflyBuffer: this.butterflyBuffer,
      })
      cascade.initializeSpectrum()
      return cascade
    })
  }

  /**
   * Run one frame of the wave simulation across every cascade.
   * `timeSec` is the absolute animation time in seconds.
   */
  update(deltaTimeSec: number, timeSec: number): void {
    if (this.disposed) return
    for (const c of this.cascades) c.update(deltaTimeSec, timeSec)
  }

  /**
   * Re-run the one-shot initial-spectrum compute for every cascade.
   * Call after mutating any spectrum uniform (windSpeed, fetch, etc.).
   */
  reinitializeSpectrum(): void {
    for (const c of this.cascades) c.initializeSpectrum()
  }

  dispose(): void {
    this.disposed = true
    for (const c of this.cascades) c.dispose()
  }
}
