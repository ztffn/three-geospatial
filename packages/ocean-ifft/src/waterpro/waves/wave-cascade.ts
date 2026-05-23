// Single IFFT cascade — direct port of the decompiled WaterPro per-cascade
// pipeline (initial spectrum → time evolution → horizontal IFFT × log2(N) →
// vertical IFFT × log2(N) → permute → texture merge with lambda steepness).
//
// Produces three storage textures sampled by the ocean material:
//   - displacement (RGBA HalfFloat) : xz horizontal displacement + y height
//   - derivative   (RGBA HalfFloat) : ∂h/∂x, ∂h/∂z gradient + Jacobian terms
//   - jacobian     (RGBA Float)     : foam-relevant Jacobian determinant terms
//
// The shader WGSL strings are reused from `resources/shader/IFFT/*.js` — pure
// shader code, no framework coupling. Math is identical to WaterPro's WASM
// IFFT (standard Tessendorf inverse FFT with Phillips spectrum).

import * as THREE from 'three/webgpu'
import {
  textureStore,
  instanceIndex,
  uniform,
  uint,
  storage,
  workgroupId,
  localId,
} from 'three/tsl'
// @ts-expect-error — untyped WGSL string module
import { InitialSpectrumWGSL } from '../../../resources/shader/IFFT/initialSpectrum.js'
// @ts-expect-error
import { InitialSpectrumWithInverseWGSL } from '../../../resources/shader/IFFT/initialSpectrumWithInverse.js'
// @ts-expect-error
import { TimeSpectrumWGSL } from '../../../resources/shader/IFFT/timeSpectrum.js'
// @ts-expect-error
import { IFFT_InitWGSL } from '../../../resources/shader/IFFT/IFFT_init.js'
// @ts-expect-error
import { IFFT_HorizontalWGSL } from '../../../resources/shader/IFFT/IFFT_Horizontal.js'
// @ts-expect-error
import { IFFT_VerticalWGSL } from '../../../resources/shader/IFFT/IFFT_Vertical.js'
// @ts-expect-error
import { IFFT_PermuteWGSL } from '../../../resources/shader/IFFT/IFFT_permute.js'
// @ts-expect-error
import { TexturesMergerWGSL } from '../../../resources/shader/IFFT/texturesMerger.js'
import type { CascadeConfig, DualSpectrumParams } from './wave-defaults.js'
import { DEFAULT_WORKGROUP } from './wave-defaults.js'

export interface WaveCascadeParams {
  renderer: any  // THREE.WebGPURenderer
  size: number
  config: CascadeConfig
  spectrum: DualSpectrumParams
  butterflyBuffer: THREE.StorageBufferAttribute
}

export class WaveCascade {
  readonly size: number
  readonly logN: number
  readonly lengthScale: number
  readonly lambda: number

  readonly displacement: THREE.StorageTexture
  readonly derivative: THREE.StorageTexture
  readonly jacobian: THREE.StorageTexture

  private readonly renderer: any
  private readonly workgroupSize: [number, number, number]
  private readonly dispatchSize: [number, number]

  private readonly DDindex: any
  private readonly ifftStep: any
  private readonly pingpong: any
  private readonly deltaTime: any

  private readonly spectrumBuffer: THREE.StorageBufferAttribute
  private readonly waveDataBuffer: THREE.StorageBufferAttribute
  private readonly DxDzBuffer: THREE.StorageBufferAttribute
  private readonly DyDxzBuffer: THREE.StorageBufferAttribute
  private readonly DyxDyzBuffer: THREE.StorageBufferAttribute
  private readonly DxxDzzBuffer: THREE.StorageBufferAttribute
  private readonly pingpongBuffer: THREE.StorageBufferAttribute
  private readonly turbulenceBuffer: THREE.StorageBufferAttribute

  private readonly computeInitialSpectrum: any
  private readonly computeInitialSpectrumWithInverse: any
  private readonly computeTimeSpectrum: any
  private readonly computeInitialize: any
  private readonly computeHorizontal: any
  private readonly computeVertical: any
  private readonly computePermute: any
  private readonly computeMerge: any

  constructor(params: WaveCascadeParams) {
    this.renderer = params.renderer
    this.size = params.size
    this.logN = Math.log2(params.size)
    this.lengthScale = params.config.lengthScale
    this.lambda = params.config.lambda
    this.workgroupSize = DEFAULT_WORKGROUP
    this.dispatchSize = [
      params.size / this.workgroupSize[0],
      params.size / this.workgroupSize[1],
    ]

    const sq = params.size * params.size
    const buf2 = sq * 2
    const buf4 = sq * 4

    this.spectrumBuffer = new THREE.StorageBufferAttribute(new Float32Array(buf4), 4)
    this.waveDataBuffer = new THREE.StorageBufferAttribute(new Float32Array(buf4), 4)
    this.DxDzBuffer = new THREE.StorageBufferAttribute(new Float32Array(buf2), 2)
    this.DyDxzBuffer = new THREE.StorageBufferAttribute(new Float32Array(buf2), 2)
    this.DyxDyzBuffer = new THREE.StorageBufferAttribute(new Float32Array(buf2), 2)
    this.DxxDzzBuffer = new THREE.StorageBufferAttribute(new Float32Array(buf2), 2)
    this.pingpongBuffer = new THREE.StorageBufferAttribute(new Float32Array(buf2 * 2), 4)
    this.turbulenceBuffer = new THREE.StorageBufferAttribute(new Float32Array(sq), 1)

    this.DDindex = uniform(0)
    this.ifftStep = uniform(0)
    this.pingpong = uniform(0)
    this.deltaTime = uniform(0)

    this.displacement = this.makeStorageTex(params.size, THREE.HalfFloatType)
    this.derivative = this.makeStorageTex(params.size, THREE.HalfFloatType)
    this.jacobian = this.makeStorageTex(params.size, THREE.FloatType)
    const aniso = this.renderer.getMaxAnisotropy?.() ?? 1
    for (const tex of [this.displacement, this.derivative, this.jacobian]) {
      tex.anisotropy = aniso
    }

    // ── Initial spectrum compute kernels — sum primary + secondary spectra
    // into the spectrumBuffer / waveDataBuffer.
    this.computeInitialSpectrum = InitialSpectrumWGSL({
      spectrumBuffer: storage(this.spectrumBuffer, 'vec4', this.spectrumBuffer.count),
      waveDataBuffer: storage(this.waveDataBuffer, 'vec4', this.waveDataBuffer.count),
      index: instanceIndex,
      size: params.size,
      waveLength: uniform(params.config.lengthScale),
      boundaryLow: uniform(params.config.boundaryLow),
      boundaryHigh: uniform(params.config.boundaryHigh),
      // Primary spectrum (matches WGSL signature - no prefix)
      depth: params.spectrum.primary.depth,
      scaleHeight: params.spectrum.primary.scaleHeight,
      windSpeed: params.spectrum.primary.windSpeed,
      windDirection: params.spectrum.primary.windDirection,
      fetch: params.spectrum.primary.fetch,
      spreadBlend: params.spectrum.primary.spreadBlend,
      swell: params.spectrum.primary.swell,
      peakEnhancement: params.spectrum.primary.peakEnhancement,
      shortWaveFade: params.spectrum.primary.shortWaveFade,
      fadeLimit: params.spectrum.primary.fadeLimit,
      // Secondary spectrum (d_ prefix matches WaterPro WGSL signature)
      d_depth: params.spectrum.secondary.depth,
      d_scaleHeight: params.spectrum.secondary.scaleHeight,
      d_windSpeed: params.spectrum.secondary.windSpeed,
      d_windDirection: params.spectrum.secondary.windDirection,
      d_fetch: params.spectrum.secondary.fetch,
      d_spreadBlend: params.spectrum.secondary.spreadBlend,
      d_swell: params.spectrum.secondary.swell,
      d_peakEnhancement: params.spectrum.secondary.peakEnhancement,
      d_shortWaveFade: params.spectrum.secondary.shortWaveFade,
      d_fadeLimit: params.spectrum.secondary.fadeLimit,
    }).compute(sq)

    this.computeInitialSpectrumWithInverse = InitialSpectrumWithInverseWGSL({
      spectrumBuffer: storage(this.spectrumBuffer, 'vec4', this.spectrumBuffer.count),
      index: instanceIndex,
      size: params.size,
    }).compute(sq)

    // ── Per-frame compute kernels ──────────────────────────────────────────
    this.computeTimeSpectrum = TimeSpectrumWGSL({
      writeDxDzBuffer: storage(this.DxDzBuffer, 'vec2', this.DxDzBuffer.count),
      writeDyDxzBuffer: storage(this.DyDxzBuffer, 'vec2', this.DyDxzBuffer.count),
      writeDyxDyzBuffer: storage(this.DyxDyzBuffer, 'vec2', this.DyxDyzBuffer.count),
      writeDxxDzzBuffer: storage(this.DxxDzzBuffer, 'vec2', this.DxxDzzBuffer.count),
      spectrumBuffer: storage(this.spectrumBuffer, 'vec4', this.spectrumBuffer.count),
      waveDataBuffer: storage(this.waveDataBuffer, 'vec4', this.waveDataBuffer.count),
      index: instanceIndex,
      size: uint(params.size),
      time: uniform(0),
    }).computeKernel(this.workgroupSize)

    const bf = storage(params.butterflyBuffer, 'vec4', params.butterflyBuffer.count).toReadOnly()
    const pp = storage(this.pingpongBuffer, 'vec4', this.pingpongBuffer.count)
    const wgUniform = uniform(new THREE.Vector2().fromArray(this.workgroupSize))

    this.computeInitialize = IFFT_InitWGSL({
      size: uint(params.size),
      step: uint(this.ifftStep),
      logN: uint(this.logN),
      butterflyBuffer: bf,
      DxDzBuffer: storage(this.DxDzBuffer, 'vec2', this.DxDzBuffer.count).toReadOnly(),
      DyDxzBuffer: storage(this.DyDxzBuffer, 'vec2', this.DyDxzBuffer.count).toReadOnly(),
      DyxDyzBuffer: storage(this.DyxDyzBuffer, 'vec2', this.DyxDyzBuffer.count).toReadOnly(),
      DxxDzzBuffer: storage(this.DxxDzzBuffer, 'vec2', this.DxxDzzBuffer.count).toReadOnly(),
      pingpongBuffer: pp,
      initBufferIndex: uint(this.DDindex),
      index: instanceIndex,
      workgroupSize: wgUniform,
      workgroupId,
      localId,
    }).computeKernel(this.workgroupSize)

    this.computeHorizontal = IFFT_HorizontalWGSL({
      size: uint(params.size),
      step: uint(this.ifftStep),
      logN: uint(this.logN),
      butterflyBuffer: bf,
      pingpongBuffer: pp,
      initBufferIndex: uint(this.DDindex),
      pingpong: uint(this.pingpong),
      index: instanceIndex,
      workgroupSize: wgUniform,
      workgroupId,
      localId,
    }).computeKernel(this.workgroupSize)

    this.computeVertical = IFFT_VerticalWGSL({
      size: uint(params.size),
      step: uint(this.ifftStep),
      logN: uint(this.logN),
      butterflyBuffer: bf,
      pingpongBuffer: pp,
      initBufferIndex: uint(this.DDindex),
      pingpong: uint(this.pingpong),
      index: instanceIndex,
      workgroupSize: wgUniform,
      workgroupId,
      localId,
    }).computeKernel(this.workgroupSize)

    this.computePermute = IFFT_PermuteWGSL({
      size: uint(params.size),
      pingpongBuffer: storage(this.pingpongBuffer, 'vec4', this.pingpongBuffer.count).toReadOnly(),
      DxDzBuffer: storage(this.DxDzBuffer, 'vec2', this.DxDzBuffer.count),
      DyDxzBuffer: storage(this.DyDxzBuffer, 'vec2', this.DyDxzBuffer.count),
      DyxDyzBuffer: storage(this.DyxDyzBuffer, 'vec2', this.DyxDyzBuffer.count),
      DxxDzzBuffer: storage(this.DxxDzzBuffer, 'vec2', this.DxxDzzBuffer.count),
      initBufferIndex: uint(this.DDindex),
      index: instanceIndex,
      workgroupSize: wgUniform,
      workgroupId,
      localId,
    }).computeKernel(this.workgroupSize)

    this.computeMerge = TexturesMergerWGSL({
      size: uint(params.size),
      index: instanceIndex,
      lambda: uniform(params.config.lambda),
      deltaTime: this.deltaTime,
      DxDzBuffer: storage(this.DxDzBuffer, 'vec2', this.DxDzBuffer.count).toReadOnly(),
      DyDxzBuffer: storage(this.DyDxzBuffer, 'vec2', this.DyDxzBuffer.count).toReadOnly(),
      DyxDyzBuffer: storage(this.DyxDyzBuffer, 'vec2', this.DyxDyzBuffer.count).toReadOnly(),
      DxxDzzBuffer: storage(this.DxxDzzBuffer, 'vec2', this.DxxDzzBuffer.count).toReadOnly(),
      turbulenceBuffer: storage(this.turbulenceBuffer, 'float', this.turbulenceBuffer.count),
      writeDisplacement: textureStore(this.displacement),
      writeDerivative: textureStore(this.derivative),
      writeJacobian: textureStore(this.jacobian),
      workgroupSize: wgUniform,
      workgroupId,
      localId,
    }).computeKernel(this.workgroupSize)
  }

  /**
   * Run the one-shot initial spectrum compute. Call after construction and
   * any time spectrum-driving uniforms (windSpeed, windDirection, etc.) change.
   */
  initializeSpectrum(): void {
    this.renderer.compute(this.computeInitialSpectrum)
    this.renderer.compute(this.computeInitialSpectrumWithInverse)
  }

  /**
   * Per-frame update — time-evolved spectrum → IFFT (×4 channels) → merge.
   * `deltaTime` is wall-clock seconds since last frame; `timeSec` is the
   * absolute animation time fed into the time-evolution kernel.
   */
  update(deltaTime: number, timeSec: number): void {
    this.computeTimeSpectrum.computeNode.parameters.time.value = timeSec
    this.renderer.compute(this.computeTimeSpectrum, this.dispatchSize)
    // Four channels: x/z horizontal, y vertical, ∂y/∂x ∂y/∂z, ∂²y/∂x∂z etc.
    this.runIFFT(0)
    this.runIFFT(1)
    this.runIFFT(2)
    this.runIFFT(3)
    this.deltaTime.value = deltaTime
    this.renderer.compute(this.computeMerge, this.dispatchSize)
  }

  dispose(): void {
    this.displacement.dispose()
    this.derivative.dispose()
    this.jacobian.dispose()
  }

  private runIFFT(channel: number): void {
    this.DDindex.value = channel
    let pingpong = true
    this.ifftStep.value = 0
    this.renderer.compute(this.computeInitialize, this.dispatchSize)
    for (let i = 1; i < this.logN; i++) {
      pingpong = !pingpong
      this.ifftStep.value = i
      this.pingpong.value = pingpong ? 1 : 0
      this.renderer.compute(this.computeHorizontal, this.dispatchSize)
    }
    for (let i = 0; i < this.logN; i++) {
      pingpong = !pingpong
      this.ifftStep.value = i
      this.pingpong.value = pingpong ? 1 : 0
      this.renderer.compute(this.computeVertical, this.dispatchSize)
    }
    this.renderer.compute(this.computePermute, this.dispatchSize)
  }

  private makeStorageTex(size: number, type: THREE.TextureDataType): THREE.StorageTexture {
    const tex = new THREE.StorageTexture(size, size)
    tex.type = type
    tex.generateMipmaps = true
    tex.magFilter = THREE.LinearFilter
    tex.minFilter = THREE.LinearMipMapLinearFilter
    tex.wrapS = THREE.RepeatWrapping
    tex.wrapT = THREE.RepeatWrapping
    return tex
  }
}
