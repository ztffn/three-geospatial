// Single IFFT cascade — direct port of the decompiled WaterPro per-cascade
// pipeline (initial spectrum → time evolution → horizontal IFFT × log2(N) →
// vertical IFFT × log2(N) → permute → texture merge with lambda steepness).
//
// Produces three storage textures sampled by the ocean material:
//   - displacement (RGBA HalfFloat) : xz horizontal displacement + y height
//   - derivative   (RGBA HalfFloat) : ∂h/∂x, ∂h/∂z gradient + Jacobian terms
//   - jacobian     (RGBA Float)     : foam-relevant Jacobian determinant terms
//
// Each pass is a TSL Fn that performs the storage-buffer element loads/stores
// and calls the by-value WGSL kernels in wave-kernels.ts — core WGSL with
// module-scope buffer access, so it validates on Firefox's Naga as well as
// Chrome's Tint (the previous resources/shader/IFFT/*.js kernels took
// ptr<storage> function parameters, which Naga rejects). Index math is kept
// line-for-line from those originals; the math itself is identical to
// WaterPro's WASM IFFT (standard Tessendorf inverse FFT with JONSWAP/TMA).

import {
  Fn,
  instanceIndex,
  localId,
  storage,
  textureStore,
  uint,
  uniform,
  uvec2,
  vec4,
  workgroupId
} from 'three/tsl'
import * as THREE from 'three/webgpu'

import {
  DEFAULT_WORKGROUP,
  type CascadeConfig,
  type DualSpectrumParams
} from './wave-defaults.js'
import {
  ifftInitValueWGSL,
  ifftPassValueWGSL,
  initialSpectrumValueWGSL,
  initialWaveDataValueWGSL,
  mergeValueWGSL,
  permuteValueWGSL,
  pickChannelWGSL,
  selectWriteWGSL,
  timeSpectrumDerivativesWGSL,
  timeSpectrumDisplacementWGSL
} from './wave-kernels.js'

export interface WaveCascadeParams {
  renderer: any // THREE.WebGPURenderer
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
  private readonly time: any

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
      params.size / this.workgroupSize[1]
    ]

    const sq = params.size * params.size
    const buf2 = sq * 2
    const buf4 = sq * 4

    this.spectrumBuffer = new THREE.StorageBufferAttribute(
      new Float32Array(buf4),
      4
    )
    this.waveDataBuffer = new THREE.StorageBufferAttribute(
      new Float32Array(buf4),
      4
    )
    this.DxDzBuffer = new THREE.StorageBufferAttribute(
      new Float32Array(buf2),
      2
    )
    this.DyDxzBuffer = new THREE.StorageBufferAttribute(
      new Float32Array(buf2),
      2
    )
    this.DyxDyzBuffer = new THREE.StorageBufferAttribute(
      new Float32Array(buf2),
      2
    )
    this.DxxDzzBuffer = new THREE.StorageBufferAttribute(
      new Float32Array(buf2),
      2
    )
    this.pingpongBuffer = new THREE.StorageBufferAttribute(
      new Float32Array(buf2 * 2),
      4
    )
    this.turbulenceBuffer = new THREE.StorageBufferAttribute(
      new Float32Array(sq),
      1
    )

    this.DDindex = uniform(0)
    this.ifftStep = uniform(0)
    this.pingpong = uniform(0)
    this.deltaTime = uniform(0)
    this.time = uniform(0)

    this.displacement = this.makeStorageTex(params.size, THREE.HalfFloatType)
    this.derivative = this.makeStorageTex(params.size, THREE.HalfFloatType)
    this.jacobian = this.makeStorageTex(params.size, THREE.FloatType)
    const aniso = this.renderer.getMaxAnisotropy?.() ?? 1
    for (const tex of [this.displacement, this.derivative, this.jacobian]) {
      tex.anisotropy = aniso
    }

    // Shared node building blocks. `pos` reproduces the originals'
    // `workgroupSize.xy * workgroupId.xy + localId.xy` (the workgroup size is a
    // compile-time constant here instead of the redundant uniform it was).
    const sizeU = uint(params.size)
    const logNU = uint(this.logN)
    const WG = uvec2(this.workgroupSize[0], this.workgroupSize[1])
    const makePos = (): any => WG.mul(workgroupId.xy).add(localId.xy).toVar()

    // ── Initial spectrum — sum primary + secondary spectra into the
    // spectrumBuffer / waveDataBuffer (one dispatch, both texels; 1D indexed).
    const waveLength = uniform(params.config.lengthScale)
    const boundaryLow = uniform(params.config.boundaryLow)
    const boundaryHigh = uniform(params.config.boundaryHigh)
    const p = params.spectrum.primary
    const s = params.spectrum.secondary

    this.computeInitialSpectrum = Fn(() => {
      const spectrumN = storage(
        this.spectrumBuffer,
        'vec4',
        this.spectrumBuffer.count
      )
      const waveDataN = storage(
        this.waveDataBuffer,
        'vec4',
        this.waveDataBuffer.count
      )
      spectrumN.element(instanceIndex).assign(
        initialSpectrumValueWGSL({
          index: instanceIndex,
          size: sizeU,
          waveLength,
          boundaryLow,
          boundaryHigh,
          // Primary spectrum (matches WGSL signature - no prefix)
          depth: p.depth,
          scaleHeight: p.scaleHeight,
          windSpeed: p.windSpeed,
          windDirection: p.windDirection,
          fetch: p.fetch,
          spreadBlend: p.spreadBlend,
          swell: p.swell,
          peakEnhancement: p.peakEnhancement,
          shortWaveFade: p.shortWaveFade,
          fadeLimit: p.fadeLimit,
          // Secondary spectrum (d_ prefix matches WaterPro WGSL signature)
          d_depth: s.depth,
          d_scaleHeight: s.scaleHeight,
          d_windSpeed: s.windSpeed,
          d_windDirection: s.windDirection,
          d_fetch: s.fetch,
          d_spreadBlend: s.spreadBlend,
          d_swell: s.swell,
          d_peakEnhancement: s.peakEnhancement,
          d_shortWaveFade: s.shortWaveFade,
          d_fadeLimit: s.fadeLimit
        })
      )
      waveDataN.element(instanceIndex).assign(
        initialWaveDataValueWGSL({
          index: instanceIndex,
          size: sizeU,
          waveLength,
          boundaryLow,
          boundaryHigh,
          depth: p.depth
        })
      )
    })().compute(sq)

    // Pack the conjugate of the mirrored (-k) cell into zw. Index math is the
    // originals' `((size - i/size) % size) * size + (size - i % size) % size`;
    // reads are hoisted to vars so both happen before the write.
    this.computeInitialSpectrumWithInverse = Fn(() => {
      const spectrumN = storage(
        this.spectrumBuffer,
        'vec4',
        this.spectrumBuffer.count
      )
      const mirrored = sizeU
        .sub(instanceIndex.div(sizeU))
        .mod(sizeU)
        .mul(sizeU)
        .add(sizeU.sub(instanceIndex.mod(sizeU)).mod(sizeU))
        .toVar()
      const h0 = spectrumN.element(instanceIndex).toVar()
      const h0MinusK = spectrumN.element(mirrored).toVar()
      spectrumN
        .element(instanceIndex)
        .assign(vec4(h0.xy, h0MinusK.x, h0MinusK.y.negate()))
    })().compute(sq)

    // ── Per-frame passes ───────────────────────────────────────────────────

    // Time evolution: h0 → h(t); two kernel calls because a value function
    // returns one texel (xy/zw packing documented in wave-kernels.ts).
    this.computeTimeSpectrum = Fn(() => {
      const spectrumN = storage(
        this.spectrumBuffer,
        'vec4',
        this.spectrumBuffer.count
      ).toReadOnly()
      const waveDataN = storage(
        this.waveDataBuffer,
        'vec4',
        this.waveDataBuffer.count
      ).toReadOnly()
      const h0 = spectrumN.element(instanceIndex).toVar()
      const wave = waveDataN.element(instanceIndex).toVar()
      const a = timeSpectrumDisplacementWGSL({
        h0,
        wave,
        time: this.time
      }).toVar()
      const b = timeSpectrumDerivativesWGSL({
        h0,
        wave,
        time: this.time
      }).toVar()
      storage(this.DxDzBuffer, 'vec2', this.DxDzBuffer.count)
        .element(instanceIndex)
        .assign(a.xy)
      storage(this.DyDxzBuffer, 'vec2', this.DyDxzBuffer.count)
        .element(instanceIndex)
        .assign(a.zw)
      storage(this.DyxDyzBuffer, 'vec2', this.DyxDyzBuffer.count)
        .element(instanceIndex)
        .assign(b.xy)
      storage(this.DxxDzzBuffer, 'vec2', this.DxxDzzBuffer.count)
        .element(instanceIndex)
        .assign(b.zw)
    })().computeKernel(this.workgroupSize)

    // First IFFT stage: gather the even/odd rows for the channel selected by
    // DDindex into the pingpong buffer (butterfly indices from data.z/w).
    this.computeInitialize = Fn(() => {
      const bfN = storage(
        params.butterflyBuffer,
        'vec4',
        params.butterflyBuffer.count
      ).toReadOnly()
      const ppN = storage(
        this.pingpongBuffer,
        'vec4',
        this.pingpongBuffer.count
      )
      const dxdzN = storage(
        this.DxDzBuffer,
        'vec2',
        this.DxDzBuffer.count
      ).toReadOnly()
      const dydxzN = storage(
        this.DyDxzBuffer,
        'vec2',
        this.DyDxzBuffer.count
      ).toReadOnly()
      const dyxdyzN = storage(
        this.DyxDyzBuffer,
        'vec2',
        this.DyxDyzBuffer.count
      ).toReadOnly()
      const dxxdzzN = storage(
        this.DxxDzzBuffer,
        'vec2',
        this.DxxDzzBuffer.count
      ).toReadOnly()

      const pos = makePos()
      const data = bfN
        .element(pos.x.mul(logNU).add(uint(this.ifftStep)))
        .toVar()
      const evenIdx = pos.y.mul(sizeU).add(uint(data.z)).toVar()
      const oddIdx = pos.y.mul(sizeU).add(uint(data.w)).toVar()
      const sel = uint(this.DDindex)
      const even = pickChannelWGSL({
        a: dxdzN.element(evenIdx),
        b: dydxzN.element(evenIdx),
        c: dyxdyzN.element(evenIdx),
        d: dxxdzzN.element(evenIdx),
        sel
      }).toVar()
      const odd = pickChannelWGSL({
        a: dxdzN.element(oddIdx),
        b: dydxzN.element(oddIdx),
        c: dyxdyzN.element(oddIdx),
        d: dxxdzzN.element(oddIdx),
        sel
      }).toVar()
      ppN.element(instanceIndex).assign(ifftInitValueWGSL({ data, even, odd }))
    })().computeKernel(this.workgroupSize)

    // Horizontal butterfly stages (rows): butterfly index walks pos.x.
    this.computeHorizontal = Fn(() => {
      const bfN = storage(
        params.butterflyBuffer,
        'vec4',
        params.butterflyBuffer.count
      ).toReadOnly()
      const ppN = storage(
        this.pingpongBuffer,
        'vec4',
        this.pingpongBuffer.count
      )

      const pos = makePos()
      const data = bfN
        .element(pos.x.mul(logNU).add(uint(this.ifftStep)))
        .toVar()
      const even4 = ppN.element(pos.y.mul(sizeU).add(uint(data.z))).toVar()
      const odd4 = ppN.element(pos.y.mul(sizeU).add(uint(data.w))).toVar()
      const current = ppN.element(instanceIndex).toVar()
      ppN
        .element(instanceIndex)
        .assign(
          ifftPassValueWGSL({
            data,
            even4,
            odd4,
            current,
            pingpong: uint(this.pingpong)
          })
        )
    })().computeKernel(this.workgroupSize)

    // Vertical butterfly stages (columns): butterfly index walks pos.y and the
    // even/odd rows come from data.z/w × size + pos.x.
    this.computeVertical = Fn(() => {
      const bfN = storage(
        params.butterflyBuffer,
        'vec4',
        params.butterflyBuffer.count
      ).toReadOnly()
      const ppN = storage(
        this.pingpongBuffer,
        'vec4',
        this.pingpongBuffer.count
      )

      const pos = makePos()
      const data = bfN
        .element(pos.y.mul(logNU).add(uint(this.ifftStep)))
        .toVar()
      const even4 = ppN.element(uint(data.z).mul(sizeU).add(pos.x)).toVar()
      const odd4 = ppN.element(uint(data.w).mul(sizeU).add(pos.x)).toVar()
      const current = ppN.element(instanceIndex).toVar()
      ppN
        .element(instanceIndex)
        .assign(
          ifftPassValueWGSL({
            data,
            even4,
            odd4,
            current,
            pingpong: uint(this.pingpong)
          })
        )
    })().computeKernel(this.workgroupSize)

    // Permute (sign checkerboard) into the channel selected by DDindex; the
    // other three channels are rewritten with their own value, matching the
    // originals' select() writes.
    this.computePermute = Fn(() => {
      const ppN = storage(
        this.pingpongBuffer,
        'vec4',
        this.pingpongBuffer.count
      ).toReadOnly()
      const dxdzN = storage(this.DxDzBuffer, 'vec2', this.DxDzBuffer.count)
      const dydxzN = storage(this.DyDxzBuffer, 'vec2', this.DyDxzBuffer.count)
      const dyxdyzN = storage(
        this.DyxDyzBuffer,
        'vec2',
        this.DyxDyzBuffer.count
      )
      const dxxdzzN = storage(
        this.DxxDzzBuffer,
        'vec2',
        this.DxxDzzBuffer.count
      )

      const pos = makePos()
      const out = permuteValueWGSL({
        input: ppN.element(instanceIndex).xy,
        pos
      }).toVar()
      const sel = uint(this.DDindex)
      dxdzN
        .element(instanceIndex)
        .assign(
          selectWriteWGSL({
            oldValue: dxdzN.element(instanceIndex),
            newValue: out,
            sel,
            channel: uint(0)
          })
        )
      dydxzN
        .element(instanceIndex)
        .assign(
          selectWriteWGSL({
            oldValue: dydxzN.element(instanceIndex),
            newValue: out,
            sel,
            channel: uint(1)
          })
        )
      dyxdyzN
        .element(instanceIndex)
        .assign(
          selectWriteWGSL({
            oldValue: dyxdyzN.element(instanceIndex),
            newValue: out,
            sel,
            channel: uint(2)
          })
        )
      dxxdzzN
        .element(instanceIndex)
        .assign(
          selectWriteWGSL({
            oldValue: dxxdzzN.element(instanceIndex),
            newValue: out,
            sel,
            channel: uint(3)
          })
        )
    })().computeKernel(this.workgroupSize)

    // Merge: pack displacement/derivative texels (same swizzles as the original
    // texturesMerger textureStores) + turbulence accumulation via the value
    // kernel. The textureStores live here because Naga requires store targets
    // to be module-scope globals, not function parameters.
    const lambdaU = uniform(params.config.lambda)
    this.computeMerge = Fn(() => {
      const dxdzN = storage(
        this.DxDzBuffer,
        'vec2',
        this.DxDzBuffer.count
      ).toReadOnly()
      const dydxzN = storage(
        this.DyDxzBuffer,
        'vec2',
        this.DyDxzBuffer.count
      ).toReadOnly()
      const dyxdyzN = storage(
        this.DyxDyzBuffer,
        'vec2',
        this.DyxDyzBuffer.count
      ).toReadOnly()
      const dxxdzzN = storage(
        this.DxxDzzBuffer,
        'vec2',
        this.DxxDzzBuffer.count
      ).toReadOnly()
      const turbN = storage(
        this.turbulenceBuffer,
        'float',
        this.turbulenceBuffer.count
      )

      const pos = makePos()
      const bufferIndex = pos.y.mul(sizeU).add(pos.x).toVar()
      const x = dxdzN.element(bufferIndex).toVar()
      const y = dydxzN.element(bufferIndex).toVar()
      const z = dyxdyzN.element(bufferIndex).toVar()
      const w = dxxdzzN.element(bufferIndex).toVar()
      const turbulence = mergeValueWGSL({
        y,
        w,
        turbulenceOld: turbN.element(bufferIndex),
        lambda: lambdaU,
        deltaTime: this.deltaTime
      }).toVar()
      textureStore(
        this.displacement,
        pos,
        vec4(lambdaU.mul(x.x), y.x, lambdaU.mul(x.y), 0)
      ).toStack()
      textureStore(
        this.derivative,
        pos,
        vec4(z.x, z.y, w.x.mul(lambdaU), w.y.mul(lambdaU))
      ).toStack()
      textureStore(this.jacobian, pos, vec4(turbulence, 0, 0, 0)).toStack()
      turbN.element(bufferIndex).assign(turbulence)
    })().computeKernel(this.workgroupSize)
  }

  /**
   * Run the one-shot initial spectrum compute. Call after construction and any
   * time spectrum-driving uniforms (windSpeed, windDirection, etc.) change.
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
    this.time.value = timeSec
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

  private makeStorageTex(
    size: number,
    type: THREE.TextureDataType
  ): THREE.StorageTexture {
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
