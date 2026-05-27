// G-C: WaterPro chunk wiring. Parallel to packages/ocean-ifft/components/
// OceanChunks.tsx (which drives localhost:5173 with the legacy material).
// Builds the chunk's WGSL vertex stage with our WaveSimulation cascade
// bindings, hands the positionNode + ocean-local fragSurfaceXZ to the
// SHARED material factory (carbon copy of the atmosphere story's composition),
// then passes the resulting material into OceanChunkManager via its optional
// `material` param. Drives sun-direction + wave-time uniforms per frame.

'use client'

import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { CubeTexture, Material, Mesh, Object3D, Texture } from 'three'
import {
  FloatType,
  Matrix4,
  NearestFilter,
  RenderTarget,
  RGBAFormat,
  Vector2,
  Vector3,
  Vector4,
  Color,
} from 'three'
import { MeshBasicNodeMaterial, type Renderer } from 'three/webgpu'
import {
  attribute,
  modelViewMatrix,
  modelWorldMatrix,
  texture,
  uniform,
  vec2,
  vec3,
  vec4,
  float,
  type ShaderNodeObject,
} from 'three/tsl'
import type { Node, UniformNode } from 'three/webgpu'

import type { AtmosphereContextNode } from '@takram/three-atmosphere/webgpu'

// @ts-expect-error JS module
import OceanChunkManager from '../../../packages/ocean-ifft/src/ocean/ocean.js'
// @ts-expect-error JS module
import { createLinearDepthMaterial } from '../../../packages/ocean-ifft/src/ocean/depth-material.js'
import { chunkVertexStageWGSL as vertexStageWGSL } from './chunkVertexStageWGSL'
import {
  DEFAULT_GERSTNER_WAVES,
  GerstnerOverlay,
  WaveSimulation,
} from '../../../packages/ocean-ifft/src/waterpro/index.js'

import {
  buildWaterproOceanMaterial,
  createWaterproOceanUniforms,
  type WaterproOceanUniforms,
} from './buildWaterproOceanMaterial'

// Mirror of ocean_constants used by OceanChunkManager. Kept here as plain
// numbers so this file has no further package dependencies.
const OCEAN_SIZE = 500_000
const QT_OCEAN_MIN_CELL_SIZE = 500
const QT_OCEAN_MIN_NUM_LAYERS = 15
const QT_OCEAN_MIN_CELL_RESOLUTION = 36
const QT_OCEAN_MIN_LOD_RADIUS = OCEAN_SIZE / 2 ** QT_OCEAN_MIN_NUM_LAYERS

const IFFT_RESOLUTION = 256
const GERSTNER_MAX_WAVES = 8
const DEPTH_PASS_PRIORITY = 0.5

type OceanManager = any

interface OceanChunksWaterproProps {
  /** Group that the ocean chunks attach to (positioned at sea level in ECEF). */
  parent: Object3D
  /** Atmosphere context — drives sun direction per frame. */
  atmosphereContext: AtmosphereContextNode
  /** Live atmosphere sky cube — `envNode.renderTarget.texture`. */
  envCubeTexture: CubeTexture
  /** Simplex-noise foam texture. */
  foamTexture: Texture
  /** Optional debug override for the quadtree LOD layer count. */
  numLayers?: number
  /** Debug flag: flat-blue MeshBasicNodeMaterial in place of the WaterPro graph. */
  useDiagnosticMaterial?: boolean
  /** Debug flag: skip the linear-depth pre-pass entirely. */
  skipDepthPrepass?: boolean
  onReady?: (ctx: {
    waveSim: WaveSimulation
    gerstner: GerstnerOverlay
    uniforms: WaterproOceanUniforms
    /** WGSL-vertex-stage uniforms (lodScale, swell, gerstner waves). */
    vertexUniforms: {
      lodScale: UniformNode<number>
      swellScale: UniformNode<number>
      swellStrength: UniformNode<number>
      gerstnerWave0: UniformNode<Vector4>
      gerstnerWave1: UniformNode<Vector4>
      gerstnerWave2: UniformNode<Vector4>
      gerstnerSteepness: UniformNode<number>
    }
    oceanManager: OceanManager
  }) => void
}

export default function OceanChunksWaterpro({
  parent,
  atmosphereContext,
  envCubeTexture,
  foamTexture,
  numLayers = 3,
  useDiagnosticMaterial = false,
  skipDepthPrepass = false,
  onReady,
}: OceanChunksWaterproProps): ReactElement | null {
  const { gl, scene: defaultScene, camera, size } = useThree()
  const renderer = gl as unknown as Renderer
  const oceanManagerRef = useRef<OceanManager | null>(null)
  const initializedRef = useRef(false)

  // Stable ref for onReady — keeps the latest closure callable from the init
  // effect without making `onReady` an effect dep (would cause remount loop
  // because the parent passes an inline arrow).
  const onReadyRef = useRef(onReady)
  useEffect(() => {
    onReadyRef.current = onReady
  }, [onReady])

  // Wave simulation + Gerstner overlay — instantiated once per renderer.
  const [waveSim, setWaveSim] = useState<WaveSimulation | null>(null)
  const [gerstner, setGerstner] = useState<GerstnerOverlay | null>(null)
  useEffect(() => {
    if (renderer == null) return
    const sim = new WaveSimulation({ renderer, resolution: IFFT_RESOLUTION })
    const gs = new GerstnerOverlay({ maxWaves: GERSTNER_MAX_WAVES })
    gs.setWaves(DEFAULT_GERSTNER_WAVES)
    setWaveSim(sim)
    setGerstner(gs)
    return () => {
      sim.dispose()
      gs.dispose()
      setWaveSim(null)
      setGerstner(null)
    }
  }, [renderer])

  // Shared uniforms bag — same defaults the atmosphere story uses. Stable
  // identity for the lifetime of the component so per-slider writes
  // propagate through to the running material.
  const uniforms = useMemo<WaterproOceanUniforms>(
    () => createWaterproOceanUniforms(),
    []
  )

  // Chunk-specific uniforms not in the shared bag (the WGSL vertex stage
  // needs these; the atmosphere story doesn't use the WGSL stage).
  const vertexUniforms = useMemo(
    () => ({
      time: uniform(0),
      cameraPositionUniform: uniform(new Vector3()),
      lodScale: uniform(1.0),
      gerstnerTime: uniform(0),
      gerstnerWave0: uniform(new Vector4(1.0, 0.3, 120.0, 1.2)),
      gerstnerWave1: uniform(new Vector4(0.5, 1.0, 60.0, 0.6)),
      gerstnerWave2: uniform(new Vector4(-0.8, 0.6, 30.0, 0.25)),
      gerstnerSteepness: uniform(0.5),
      gerstnerStrength: uniform(1.0),
      // Large-scale amplitude modulation — breaks top-down cascade-tile
      // repetition. swellStrength=0 → identity (uniform wave heights).
      swellScale: uniform(800.0),
      swellStrength: uniform(0.5),
    }),
    []
  )

  // Sun direction uniforms — mirror of the WaterproAtmosphere story's pair.
  // sunDirUniform = TO-sun (atmosphere convention); sunDirLightUniform =
  // FROM-sun (light propagation, what SSS / sparkle want). Updated per-frame
  // from the atmosphere context below.
  const sunDirUniform = useMemo(() => uniform(new Vector3(0, -1, 0)), [])
  const sunDirLightUniform = useMemo(() => uniform(new Vector3(0, 1, 0)), [])
  const sunIntensityUniform = useMemo(() => uniform(1.0), [])

  // Linear-depth pre-pass target. FloatType (not HalfFloat) is required at
  // cameraFar=1e8 — HalfFloat precision collapses near-geometry depth ratios
  // to ~0 and shoreline foam blows out across the whole ocean.
  const depthMaterial = useMemo(() => createLinearDepthMaterial(), [])
  const depthTargetRef = useRef<RenderTarget | null>(null)
  if (depthTargetRef.current == null) {
    const w = Math.max(1, size.width)
    const h = Math.max(1, size.height)
    depthTargetRef.current = new RenderTarget(w, h, {
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      type: FloatType,
      format: RGBAFormat,
      depthBuffer: true,
    })
  }
  const depthTarget = depthTargetRef.current
  useEffect(() => {
    depthTarget.setSize(Math.max(1, size.width), Math.max(1, size.height))
  }, [depthTarget, size.width, size.height])
  useEffect(() => {
    return () => {
      depthTargetRef.current?.dispose()
      depthTargetRef.current = null
    }
  }, [])

  // When the depth pre-pass is skipped, depth texture stays uninitialized →
  // water-column-depth reads garbage. Toggle the enabled flag so depth-based
  // foam paths short-circuit cleanly.
  const depthTextureEnabledUniform = useMemo(() => uniform(1.0), [])
  useEffect(() => {
    depthTextureEnabledUniform.value = skipDepthPrepass ? 0 : 1
  }, [depthTextureEnabledUniform, skipDepthPrepass])

  // ── Build the chunk material ────────────────────────────────────────────
  // Steps:
  //   1. Build the WGSL chunk vertex stage with cascades bound to OUR
  //      WaveSimulation (not the legacy WaveGenerator).
  //   2. Hand the resulting positionNode + ocean-local fragSurfaceXZ
  //      (vDisplaced.xz varying) to the SHARED carbon-copy material factory.
  //
  // The fragSurfaceXZ MUST be ocean-local at globe scale. Using
  // (modelWorldMatrix × vDisplaced).xz (the literal WaterproAtmosphere
  // expression) at ECEF ~6.37e6 m loses float32 precision and hashes
  // adjacent fragments to a single cascade UV — chunks render as solid
  // single-color tiles. This is the one place the carbon copy must diverge.
  const material = useMemo(() => {
    if (useDiagnosticMaterial) {
      return new MeshBasicNodeMaterial({ color: new Color(0x1980cc) })
    }
    if (waveSim == null || gerstner == null) return null
    if (waveSim.cascades.length < 3) {
      throw new Error(
        `WaterPro chunk material needs 3 cascades (got ${waveSim.cascades.length})`
      )
    }

    // Chunk WGSL vertex stage with cascades bound to our WaveSimulation.
    // gerstnerStrength is bound to the SHARED bag's gerstnerAmplitude so the
    // slider scales vertex Gerstner displacement in lockstep with the
    // fragment-side gerstner normal contribution. fftAmplitude does the same
    // for IFFT displacement (forked WGSL applies the multiplier — the
    // package's vertexStageWGSL doesn't have this param).
    const wgslParams = {
      time: vertexUniforms.time,
      cameraPosition: vertexUniforms.cameraPositionUniform,
      noise: texture(foamTexture),
      position: attribute('position'),
      vindex: attribute('vindex'),
      width: attribute('width'),
      lod: attribute('lod'),
      minLodRadius: uniform(QT_OCEAN_MIN_LOD_RADIUS),
      gridResolution: uniform(QT_OCEAN_MIN_CELL_RESOLUTION),
      gerstnerWave0: vertexUniforms.gerstnerWave0,
      gerstnerWave1: vertexUniforms.gerstnerWave1,
      gerstnerWave2: vertexUniforms.gerstnerWave2,
      gerstnerSteepness: vertexUniforms.gerstnerSteepness,
      gerstnerStrength: uniforms.gerstnerAmplitude,
      fftAmplitude: uniforms.fftAmplitude,
      swellScale: vertexUniforms.swellScale,
      swellStrength: vertexUniforms.swellStrength,
      // Varyings the WGSL body writes to — must be passed in or three's TSL
      // doesn't hook them into the `varyings` object → invalid pipeline →
      // black canvas + WebGPU device error.
      vDisplacedPosition: vertexStageWGSL.vDisplacedPosition,
      vMorphedPosition: vertexStageWGSL.vMorphedPosition,
      vCascadeScales: vertexStageWGSL.vCascadeScales,
      // Cascade texture bindings — same shape as legacy ocean-material.js
      // buildCascadeUniforms, just from OUR WaveSimulation cascades.
      displacement0: texture(waveSim.cascades[0].displacement),
      displacement1: texture(waveSim.cascades[1].displacement),
      displacement2: texture(waveSim.cascades[2].displacement),
      waveLengths: vec3(
        waveSim.cascades[0].lengthScale,
        waveSim.cascades[1].lengthScale,
        waveSim.cascades[2].lengthScale
      ),
      ifftResolution: uniform(waveSim.resolution),
      lodScale: vertexUniforms.lodScale,
    }

    const positionNode = vertexStageWGSL.vertexStageWGSL(wgslParams)

    // Fragment-side derivatives from the WGSL vertex stage's varyings.
    //
    // fragSurfaceXZ uses vMorphedPosition (the static, pre-displacement
    // ocean-local grid). Sampling cascades + foam noise at vDisplaced.xz
    // would couple the UV to wave motion (lambda chop shifts X/Z every
    // frame) — visible as foam patches and noise patterns swimming with
    // the waves. The vertex stage itself samples cascades at
    // morphedPosition.xz, so using the same here keeps fragment normals
    // and vertex displacement coherent.
    //
    // worldSurfaceXZ stays on the actual displaced world position because
    // it feeds fresnel distance-to-camera and viewDir — both of which
    // SHOULD track the rendered surface.
    const vDisplaced = vertexStageWGSL.vDisplacedPosition as unknown as ShaderNodeObject<Node>
    const vMorphed = vertexStageWGSL.vMorphedPosition as unknown as ShaderNodeObject<Node>
    const fragSurfaceXZ = vec2(vMorphed.x, vMorphed.z)
    const displacedView = modelViewMatrix.mul(vec4(vDisplaced, float(1)))
    const oceanDepth = displacedView.z.negate()
    const displacedWorld4 = modelWorldMatrix.mul(vec4(vDisplaced, float(1)))
    const displacedWorld = displacedWorld4.xyz
    const worldSurfaceXZ = vec2(displacedWorld4.x, displacedWorld4.z)

    return buildWaterproOceanMaterial({
      waveSim,
      gerstner,
      u: uniforms,
      gerstnerTime: vertexUniforms.gerstnerTime,
      sunDirUniform,
      sunDirLightUniform,
      sunIntensityUniform,
      depthTexture: depthTarget.texture,
      depthTextureEnabled: depthTextureEnabledUniform,
      envCubeTexture,
      foamTexture,
      positionNode,
      fragSurfaceXZ,
      worldSurfaceXZ,
      worldSurfacePos: displacedWorld,
      oceanDepth,
      oceanPositionWorld: displacedWorld,
      // Ocean-local STATIC position for foam tile UVs + turbulent-foam
      // y-depth. Using vMorphedPosition (pre-displacement) instead of
      // vDisplaced keeps surface/wave/shoreline foam patterns from swimming
      // with the waves. Plane caller leaves this undefined → TSL
      // positionWorld default → identical behaviour at origin.
      tilingPosition: vMorphed,
      // Exact ocean-local Y produced by the WGSL vertex stage (cascade +
      // gerstner + swell modulation). Tip foam reads this directly so it
      // aligns with actual wave peaks instead of cascade-sample drift.
      surfaceHeight: vDisplaced.y as unknown as ShaderNodeObject<Node>,
    })
  }, [
    useDiagnosticMaterial,
    waveSim,
    gerstner,
    uniforms,
    vertexUniforms,
    sunDirUniform,
    sunDirLightUniform,
    sunIntensityUniform,
    depthTarget,
    depthTextureEnabledUniform,
    envCubeTexture,
    foamTexture,
  ])

  // OceanChunkManager init.
  useEffect(() => {
    if (initializedRef.current) return
    if (waveSim == null || material == null) return

    let cancelled = false
    let createdOceanManager: OceanManager | null = null

    const init = async (): Promise<void> => {
      try {
        const oceanManager = new OceanChunkManager()
        createdOceanManager = oceanManager

        const waveGeneratorShim = {
          oceanSet: { add: () => ({ onChange: () => {} }) },
          params_: { gui: null },
        }

        const cam = camera as any
        await oceanManager.Init({
          scene: parent,
          camera,
          renderer: gl,
          sunpos: new Vector3(),
          waveGenerator: waveGeneratorShim,
          layer: 0,
          depthTexture: depthTarget.texture,
          viewportSize: new Vector2(size.width, size.height),
          cameraNear: cam.near ?? 1.0,
          cameraFar: cam.far ?? 1e8,
          gui: null,
          guiParams: {},
          numLayers,
          material,
        })

        if (cancelled) {
          oceanManager.Destroy?.()
          return
        }

        oceanManagerRef.current = oceanManager
        initializedRef.current = true
        onReadyRef.current?.({
          waveSim,
          gerstner: gerstner!,
          uniforms,
          vertexUniforms: {
            lodScale: vertexUniforms.lodScale,
            swellScale: vertexUniforms.swellScale,
            swellStrength: vertexUniforms.swellStrength,
            gerstnerWave0: vertexUniforms.gerstnerWave0,
            gerstnerWave1: vertexUniforms.gerstnerWave1,
            gerstnerWave2: vertexUniforms.gerstnerWave2,
            gerstnerSteepness: vertexUniforms.gerstnerSteepness,
          },
          oceanManager,
        })
      } catch (error) {
        console.error('OceanChunksWaterpro init failed:', error)
      }
    }

    void init()

    return () => {
      cancelled = true
      ;(oceanManagerRef.current ?? createdOceanManager)?.Destroy?.()
      oceanManagerRef.current = null
      initializedRef.current = false
    }
  }, [waveSim, gerstner, material, parent, camera, gl, uniforms, numLayers])

  // Linear-depth pre-pass.
  useFrame(() => {
    if (skipDepthPrepass) return
    const manager = oceanManagerRef.current as unknown as
      | { group?: Object3D }
      | null
    if (manager == null) return
    const r = renderer as any
    if (r == null) return

    const oceanGroup = manager.group
    const wasVisible = oceanGroup?.visible
    const prevBackground = defaultScene.background
    if (oceanGroup != null) oceanGroup.visible = false

    const overridden: Array<{ mesh: Mesh; mat: Material | Material[] }> = []
    defaultScene.traverse(obj => {
      const mesh = obj as unknown as Mesh
      const mat = (mesh as any).material
      if ((obj as any).isMesh && obj.visible && mat != null) {
        const mats = Array.isArray(mat) ? mat : [mat]
        if (mats.every((m: any) => m.transparent && !(m.alphaTest > 0))) return
        overridden.push({ mesh, mat })
        mesh.material = depthMaterial as unknown as Material
      }
    })

    try {
      defaultScene.background = null
      r.setRenderTarget(depthTarget)
      r.setClearColor(0xffffff, 1.0)
      r.clear()
      r.render(defaultScene, camera)
    } finally {
      r.setRenderTarget(null)
      r.setClearColor(0x000000, 1.0)
      defaultScene.background = prevBackground
      overridden.forEach(({ mesh, mat }) => {
        mesh.material = mat
      })
      if (oceanGroup != null && wasVisible !== undefined)
        oceanGroup.visible = wasVisible
    }
  }, DEPTH_PASS_PRIORITY)

  // Per-frame wave + sun + camera writes.
  const matrixECEFToWorld = useMemo(() => new Matrix4(), [])
  const worldSun = useMemo(() => new Vector3(), [])
  const cameraPosScratch = useMemo(() => new Vector3(), [])
  const clockRef = useRef({
    start: performance.now() / 1000,
    last: performance.now() / 1000,
  })

  useFrame((_, delta) => {
    if (oceanManagerRef.current == null || waveSim == null) return

    const now = performance.now() / 1000
    const dt = now - clockRef.current.last
    const t = now - clockRef.current.start
    clockRef.current.last = now
    waveSim.update(dt, t)
    vertexUniforms.time.value = t
    vertexUniforms.gerstnerTime.value = t

    camera.getWorldPosition(cameraPosScratch)
    vertexUniforms.cameraPositionUniform.value.copy(cameraPosScratch)

    // Sun direction — ECEF → world. World frame matches the WaterproAtmosphere
    // story exactly. At chunk scale the ocean-local-vs-world rotation is
    // sub-arcsec for normal camera distances; not worth deviating from the
    // tuned atmosphere setup.
    if (
      atmosphereContext?.sunDirectionECEF != null &&
      atmosphereContext.matrixWorldToECEF != null
    ) {
      matrixECEFToWorld
        .copy(atmosphereContext.matrixWorldToECEF.value)
        .invert()
      worldSun
        .copy(atmosphereContext.sunDirectionECEF.value)
        .transformDirection(matrixECEFToWorld)
      sunDirUniform.value.copy(worldSun)
      sunDirLightUniform.value.copy(worldSun).negate()
      oceanManagerRef.current.SetSunDirection?.(worldSun)
    }

    try {
      oceanManagerRef.current.Update_?.(delta * 1000)
    } catch (error) {
      console.error('OceanChunksWaterpro update failed:', error)
    }
  })

  return null
}
