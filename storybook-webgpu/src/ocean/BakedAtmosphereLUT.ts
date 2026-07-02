// BakedAtmosphereLUT.ts — Drop-in replacement for the WebGPU AtmosphereLUTNode
// that LOADS the precomputed Bruneton LUTs shipped in packages/atmosphere/assets
// (the same .bin files the WebGL demos use) instead of computing them on the GPU
// at startup. Injected into AtmosphereContext by GlobeWaterproOcean-Story so the
// atmosphere phase is a texture fetch, not a requestIdleCallback-driven compute.

import {
  Data3DTexture,
  DataTexture,
  HalfFloatType,
  LinearFilter,
  type Texture
} from 'three'
import { Node, type Texture3DNode, type TextureNode } from 'three/webgpu'

import {
  IRRADIANCE_TEXTURE_HEIGHT,
  IRRADIANCE_TEXTURE_WIDTH,
  SCATTERING_TEXTURE_DEPTH,
  SCATTERING_TEXTURE_HEIGHT,
  SCATTERING_TEXTURE_WIDTH,
  TRANSMITTANCE_TEXTURE_HEIGHT,
  TRANSMITTANCE_TEXTURE_WIDTH
} from '@takram/three-atmosphere'
import type {
  AtmosphereLUTTexture3DName,
  AtmosphereLUTTextureName
} from '@takram/three-atmosphere/webgpu'
import { outputTexture, outputTexture3D } from '@takram/three-geospatial/webgpu'

// The four LUTs the runtime samples with the default AtmosphereParameters
// (combinedScatteringTextures = true, higherOrderScatteringTexture = true).
// single_mie_scattering.bin is NOT fetched: with combined scattering the shader
// derives Mie from the combined texture's alpha and never samples that node.
// `new URL(..., import.meta.url)` bundles them the same way the story bundles
// stars.bin — hashed asset URLs in the build, /@fs in dev — so no staticAssets
// entry is needed.
const LUT_URLS = {
  transmittance: new URL(
    '../../../packages/atmosphere/assets/transmittance.bin',
    import.meta.url
  ),
  irradiance: new URL(
    '../../../packages/atmosphere/assets/irradiance.bin',
    import.meta.url
  ),
  scattering: new URL(
    '../../../packages/atmosphere/assets/scattering.bin',
    import.meta.url
  ),
  higherOrderScattering: new URL(
    '../../../packages/atmosphere/assets/higher_order_scattering.bin',
    import.meta.url
  )
} as const

type BakedLUTName = keyof typeof LUT_URLS

// Kick the downloads off at module-evaluation time — before the renderer
// initializes or React mounts — so the network transfer overlaps renderer init
// and pipeline compiles instead of serialising after them.
const fetchLUT = async (name: BakedLUTName): Promise<Uint16Array> => {
  const response = await fetch(LUT_URLS[name])
  if (!response.ok) {
    throw new Error(`${LUT_URLS[name].pathname}: HTTP ${response.status}`)
  }
  // Raw little-endian float16 RGBA texels, exactly as PrecomputedTexturesLoader
  // parses them (parseFloat16Array reinterprets the same bytes).
  return new Uint16Array(await response.arrayBuffer())
}

const fetchStart = performance.now()
const lutDataPromise = Promise.all([
  fetchLUT('transmittance'),
  fetchLUT('irradiance'),
  fetchLUT('scattering'),
  fetchLUT('higherOrderScattering')
])

// The consumer chain (the node constructor) attaches lazily — possibly never,
// on a browser that fails the WebGPU probe. Absorb the rejection here so a
// failed fetch can't fire an unhandled-rejection (the constructor's own catch
// still receives and reports it), and log the transfer time — it's the
// atmosphere-phase network cost in the load baseline.
lutDataPromise.then(
  () => {
    console.log(
      `[baked-lut] 4 LUT bins fetched in ${Math.round(performance.now() - fetchStart)}ms`
    )
  },
  () => undefined
)

const configure = <T extends Texture>(texture: T): T => {
  texture.type = HalfFloatType
  texture.minFilter = LinearFilter
  texture.magFilter = LinearFilter
  texture.needsUpdate = true
  return texture
}

// Full-size zeroed placeholders so the sky/aerial pipelines always bind valid
// textures even when a frame renders before the fetch resolves (the splash
// covers the visuals; the readiness probe holds reveal until the data is in).
// The loaded bytes are later written into these same instances — no TextureNode
// value swap, just a data fill + needsUpdate re-upload.
const createLUT = (width: number, height: number): DataTexture =>
  configure(new DataTexture(new Uint16Array(width * height * 4), width, height))

const createLUT3D = (
  width: number,
  height: number,
  depth: number
): Data3DTexture =>
  configure(
    new Data3DTexture(
      new Uint16Array(width * height * depth * 4),
      width,
      height,
      depth
    )
  )

export class BakedAtmosphereLUTNode extends Node {
  static override get type(): string {
    return 'BakedAtmosphereLUTNode'
  }

  // Readiness mirror of AtmosphereLUTNode's private fields, read (as any) by
  // the loaders' atmosphere probes (main.tsx ReadinessProbe + the Storybook
  // stage effect): ready ⇔ currentVersion != null && updating === false.
  currentVersion: number | null = null
  updating = true

  private readonly textures = {
    transmittance: createLUT(
      TRANSMITTANCE_TEXTURE_WIDTH,
      TRANSMITTANCE_TEXTURE_HEIGHT
    ),
    irradiance: createLUT(IRRADIANCE_TEXTURE_WIDTH, IRRADIANCE_TEXTURE_HEIGHT),
    scattering: createLUT3D(
      SCATTERING_TEXTURE_WIDTH,
      SCATTERING_TEXTURE_HEIGHT,
      SCATTERING_TEXTURE_DEPTH
    ),
    // Never sampled (combined scattering) but declared in the shader function
    // layouts, so the binding must hold a valid 3D texture.
    singleMieScattering: createLUT3D(1, 1, 1),
    higherOrderScattering: createLUT3D(
      SCATTERING_TEXTURE_WIDTH,
      SCATTERING_TEXTURE_HEIGHT,
      SCATTERING_TEXTURE_DEPTH
    )
  }

  private readonly textureNodes = {
    transmittance: outputTexture(this, this.textures.transmittance),
    irradiance: outputTexture(this, this.textures.irradiance),
    scattering: outputTexture3D(this, this.textures.scattering),
    singleMieScattering: outputTexture3D(
      this,
      this.textures.singleMieScattering
    ),
    higherOrderScattering: outputTexture3D(
      this,
      this.textures.higherOrderScattering
    )
  }

  constructor() {
    super(null)

    lutDataPromise
      .then(([transmittance, irradiance, scattering, higherOrder]) => {
        this.textures.transmittance.image.data = transmittance
        this.textures.irradiance.image.data = irradiance
        this.textures.scattering.image.data = scattering
        this.textures.higherOrderScattering.image.data = higherOrder
        for (const texture of Object.values(this.textures)) {
          texture.needsUpdate = true
        }
        this.currentVersion = this.version
        this.updating = false
        // SkyEnvironmentNode re-renders its environment cube on this event.
        this.dispatchEvent({ type: 'update' } as any)
      })
      .catch((error: unknown) => {
        // No compute fallback by design — leave `updating` set so the loader
        // splash reports the stall honestly instead of revealing a black sky.
        console.error('[baked-lut] failed to load atmosphere LUTs:', error)
      })
  }

  getTextureNode(name: AtmosphereLUTTextureName): TextureNode
  getTextureNode(name: AtmosphereLUTTexture3DName): Texture3DNode
  getTextureNode(
    name: AtmosphereLUTTextureName | AtmosphereLUTTexture3DName
  ): TextureNode | Texture3DNode {
    return this.textureNodes[name]
  }

  override dispose(): void {
    for (const texture of Object.values(this.textures)) {
      texture.dispose()
    }
    super.dispose()
  }
}

// Singleton: the story's AtmosphereContext is created once per mount but the
// GPU-side textures and the fetched data are process-wide; reuse them.
let instance: BakedAtmosphereLUTNode | undefined

export function getBakedAtmosphereLUTNode(): BakedAtmosphereLUTNode {
  instance ??= new BakedAtmosphereLUTNode()
  return instance
}
