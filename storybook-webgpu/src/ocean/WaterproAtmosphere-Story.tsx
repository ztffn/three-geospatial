// Atmosphere-driven variant of the WaterPro depth demo.
// Mirrors the material pattern from packages/ocean-ifft/src/ocean/ocean-material.js
// (MeshStandardNodeMaterial + colorSpace=SRGBColorSpace + colorNode = fully-shaded
// finalColor), and the atmosphere mount from Ocean-Basic-Story.tsx. The PBR
// pipeline applies AtmosphereLight + skyEnvironment IBL to the colorNode (acting
// as a natural radiance dim), which lets the post-pass's 0.55× scale + AgX
// exposure 10 land in the correct tonemap range — matching how the working
// ocean-material renders in Ocean-Basic-Story and GlobeOceanProto.
//
// Sibling to WaterproDepthDemo-Story.tsx — does NOT replace it. The depth demo
// keeps its MeshBasic + no-tonemap reference path.

import { OrbitControls } from '@react-three/drei'
import { extend, useFrame, useThree, type ThreeElement } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState, type FC } from 'react'
import {
  AgXToneMapping,
  Color,
  CubeTextureLoader,
  DoubleSide,
  HalfFloatType,
  LinearFilter,
  Matrix4,
  type Mesh,
  type Material,
  NearestFilter,
  PlaneGeometry,
  RenderTarget,
  RGBAFormat,
  SRGBColorSpace,
  TextureLoader,
  Vector2,
  Vector3,
  RepeatWrapping,
} from 'three'
import {
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  PostProcessing,
  type Renderer,
} from 'three/webgpu'
import {
  Fn,
  attribute,
  cameraPosition,
  cubeTexture,
  exp,
  float,
  mix,
  normalLocal,
  pass,
  positionView,
  cameraNear,
  cameraFar,
  reflect as tslReflect,
  toneMapping,
  uniform,
  vec2,
  vec3,
  vec4,
  modelWorldMatrix,
} from 'three/tsl'

import {
  getECIToECEFRotationMatrix,
  getMoonDirectionECI,
  getSunDirectionECI,
} from '@takram/three-atmosphere'
import {
  aerialPerspective,
  AtmosphereContextNode,
  AtmosphereLight,
  AtmosphereLightNode,
  skyEnvironment,
} from '@takram/three-atmosphere/webgpu'
import { dithering, lensFlare } from '@takram/three-geospatial/webgpu'

import type { StoryFC } from '../components/createStory'
import { WebGPUCanvas } from '../components/WebGPUCanvas'
import {
  localDateArgs,
  localDateArgTypes,
  useLocalDateControls,
  type LocalDateArgs,
} from '../controls/localDateControls'
import {
  locationArgs,
  locationArgTypes,
  useLocationControls,
  type LocationArgs,
} from '../controls/locationControls'
import {
  toneMappingArgs,
  toneMappingArgTypes,
  useToneMappingControls,
  type ToneMappingArgs,
} from '../controls/toneMappingControls'
import { useGuardedFrame } from '../hooks/useGuardedFrame'
import { useResource } from '../hooks/useResource'
import { useTransientControl } from '../hooks/useTransientControl'
import {
  WaveSimulation,
  GerstnerOverlay,
  DEFAULT_GERSTNER_WAVES,
  sampleWaveDisplacement,
  sampleWaveNormal,
  waterColorNode,
  surfaceFoamNode,
  waveFoamNode,
  shorelineFoamNode,
  fresnelDistanceNode,
  subSurfaceScatteringNode,
  sparkleNode,
  turbulentFoamNode,
  combineFoamNode,
  applyWaterproPreset,
  WATERPRO_PRESET_NAMES,
  type WaterproPresetName,
  type WaterproPresetUniformBag,
} from '../../../packages/ocean-ifft/src/waterpro/index.js'

declare module '@react-three/fiber' {
  interface ThreeElements {
    atmosphereLight: ThreeElement<typeof AtmosphereLight>
  }
}

extend({ AtmosphereLight })

const DEPTH_PASS_PRIORITY = 0.5
const PLANE_SIZE = 80
const PLANE_SEGMENTS = 256
const IFFT_RESOLUTION = 256
const GERSTNER_MAX_WAVES = 8

// Scene-radiance dim applied to colorNode before aerial perspective.
// GlobeOceanProto.tsx:513 uses 0.55 with ocean-material.js, whose WGSL
// fragment peaks around ~0.5 (waterColor + bounded reflection + small spec).
// The WaterPro composition here peaks roughly 2× higher (waterColor 0.8 +
// SSS 0.2-0.5 + sparkle glow + foam mix to 1.0), so 0.55 / 2 ≈ 0.28 lands
// the highlights in AgX's mid-range where contrast is preserved instead of
// rolling off to white.
const SCENE_RADIANCE_SCALE = 0.28

function createLinearDepthMaterial(): MeshBasicNodeMaterial {
  const mat = new MeshBasicNodeMaterial()
  mat.side = DoubleSide
  mat.colorNode = Fn(() => {
    const d = positionView.z.negate().sub(cameraNear).div(cameraFar.sub(cameraNear))
    return vec4(d, float(0), float(1), float(1))
  })()
  return mat
}

const loader = new TextureLoader()
const foamTexture = loader.load('/ocean-ifft-resources/textures/simplex-noise.png')
foamTexture.wrapS = RepeatWrapping
foamTexture.wrapT = RepeatWrapping

// Static sRGB sky cubemap for the in-shader sky-reflection mix. The WaterPro
// fragment math (and ocean-material.js, which is the working reference) was
// designed for an LDR sRGB cubemap input in roughly 0..1 range. Sampling the
// atmosphere-rendered HDR cube here instead pushes reflection values to
// 5-10× expected and the AgX tonemapper saturates the surface to flat white.
// SRGBColorSpace on the cube texture is required — JPG faces are sRGB-encoded.
const cubeLoader = new CubeTextureLoader()
const skyCubemap = cubeLoader.load(
  ['px', 'nx', 'py', 'ny', 'pz', 'nz'].map(
    f => `/ocean-ifft-resources/textures/cube/sky/${f}.jpg`
  )
)
skyCubemap.minFilter = LinearFilter
skyCubemap.magFilter = LinearFilter
skyCubemap.colorSpace = SRGBColorSpace

interface StoryArgs extends ToneMappingArgs, LocationArgs, LocalDateArgs {
  preset: WaterproPresetName | 'custom'
  skyReflection: boolean
  skyReflectionColor: string
  skyReflectionExposure: number
  skyReflectionScale: number
  sss: boolean
  sparkle: boolean
  surfaceFoam: boolean
  waveFoam: boolean
  turbulentFoam: boolean
  shorelineFoam: boolean
  fftAmplitude: number
  gerstnerAmplitude: number
  fresnelPower: number
  normalStrength: number
  sparkleIntensity: number
  sparkleFocusPower: number
  sssIntensity: number
  sssPower: number
  surfaceFoamCoverage: number
  surfaceFoamOpacity: number
  surfaceFoamSize: number
  waveFoamCoverage: number
  waveFoamOpacity: number
  waveFoamCrestCoverage: number
  shorelineBandRange: number
  shorelineBandCoverage: number
  shorelineBandOpacity: number
  shorelineTintRange: number
  shorelineTintCoverage: number
  shorelineTintOpacity: number
  turbulentIntensity: number
  depthFalloff: number
  waterDepth: number
}

const Content: FC = () => {
  const renderer = useThree<Renderer>(({ gl }) => gl as any)
  const scene = useThree(({ scene }) => scene)
  const camera = useThree(({ camera }) => camera)
  const { size } = useThree()
  const oceanMeshRef = useRef<Mesh>(null)
  const terrainMeshRef = useRef<Mesh>(null)
  const capsuleMeshRef = useRef<Mesh>(null)
  const depthMaterial = useMemo(() => createLinearDepthMaterial(), [])

  // Atmosphere context + sky environment. environmentNode is load-bearing: it
  // feeds IBL ambient into MeshStandard's PhysicalLightingModel so the ocean
  // doesn't collapse to black at low sun angles. (Without it, NdotL→0 zeroes
  // the diffuse term, the only thing left is sky reflection inside finalColor,
  // and the ocean reads as pink sand at sunset.)
  const context = useResource(() => new AtmosphereContextNode(), [])
  context.camera = camera
  const envNode = useResource(() => skyEnvironment(context), [context])
  scene.environmentNode = envNode as any

  // Wave simulation lifecycle.
  const [waveSim, setWaveSim] = useState<WaveSimulation | null>(null)
  const [gerstner, setGerstner] = useState<GerstnerOverlay | null>(null)
  const gerstnerTime = useMemo(() => uniform(0), [])
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

  // Depth render target — terrain pre-pass writes here, waterColorNode samples
  // it for shoreline-foam gating.
  const depthTargetRef = useRef<RenderTarget | null>(null)
  if (depthTargetRef.current == null) {
    depthTargetRef.current = new RenderTarget(
      Math.max(1, size.width),
      Math.max(1, size.height),
      {
        minFilter: NearestFilter,
        magFilter: NearestFilter,
        type: HalfFloatType,
        format: RGBAFormat,
        depthBuffer: true,
      }
    )
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

  const oceanGeometry = useMemo(() => {
    const g = new PlaneGeometry(PLANE_SIZE, PLANE_SIZE, PLANE_SEGMENTS, PLANE_SEGMENTS)
    g.rotateX(-Math.PI / 2)
    return g
  }, [])

  // Sun direction is driven from atmosphereContext.sunDirectionECEF per frame.
  // The local demo has identity matrixWorldToECEF (no globe), so the inverted-
  // transform is a no-op — we keep the indirection so this code copies cleanly
  // to a globe-scale setup (OceanChunks.tsx lines 234-239 use the same pattern).
  const sunDirUniform = useMemo(() => uniform(new Vector3(0, -1, 0)), [])
  const sunIntensityUniform = useMemo(() => uniform(1.0), [])
  const matrixECEFToWorld = useMemo(() => new Matrix4(), [])
  const worldSun = useMemo(() => new Vector3(), [])

  // Uniform bag — stable identity so useTransientControl writes into the same
  // objects the TSL graph references. Defaults match the depth-demo's tuned
  // values; preset selection overwrites a subset.
  const u = useMemo(
    () => ({
      // Toggles
      skyReflectionOn: uniform(1.0),
      // DIAGNOSTIC color input — what the reflection actually feeds into the
      // WaterPro mix. Storybook color picker is sRGB; transient control
      // converts to linear before writing here. Multiplied by skyReflectionScale.
      skyReflectionColor: uniform(new Vector3(0.3, 0.5, 0.8)),
      // Reflection tonemap exposure (kept for the live-cube path; unused
      // while skyReflectionColor diagnostic is wired).
      skyReflectionExposure: uniform(0.2),
      // Post-color scalar multiplier. 1.0 = use linear color as-is.
      skyReflectionScale: uniform(1.0),
      sssOn: uniform(1.0),
      sparkleOn: uniform(1.0),
      surfaceFoamOn: uniform(1.0),
      waveFoamOn: uniform(1.0),
      turbulentFoamOn: uniform(1.0),
      shorelineFoamOn: uniform(1.0),
      // Wave amplitude (preset-driven scalar multipliers)
      fftAmplitude: uniform(1.0),
      gerstnerAmplitude: uniform(1.0),
      // Fresnel
      fresnelPower: uniform(3.0),
      fresnelNormalStrength: uniform(0.1),
      // Sparkle
      sparkleIntensity: uniform(1.5),
      sparkleFocusPower: uniform(75.7),
      // SSS
      sssIntensity: uniform(0.5),
      sssPower: uniform(16.0),
      // Surface foam
      surfaceFoamColor: uniform(new Vector3(1, 1, 1)),
      surfaceFoamCoverage: uniform(0.02),
      surfaceFoamOpacity: uniform(0.25),
      surfaceFoamSize: uniform(20.0),
      // Wave foam
      waveFoamColor: uniform(new Vector3(1, 1, 1)),
      waveFoamCoverage: uniform(0.5),
      waveFoamOpacity: uniform(0.6),
      waveFoamCrestCoverage: uniform(0.3),
      waveFoamPeakIntensity: uniform(1.0),
      waveFoamRippleWeight: uniform(1.0),
      waveFoamWaveWeight: uniform(1.0),
      waveFoamWindBias: uniform(0.8),
      waveFoamWindStretch: uniform(0.5),
      waveFoamSize: uniform(20.0),
      // Shoreline — two layers; band is preset-driven, tint is fixed-knob
      shorelineFoamColor: uniform(new Vector3(1, 1, 1)),
      shorelineFoamCoverage: uniform(0.5),
      shorelineFoamOpacity: uniform(1.0),
      shorelineFoamRange: uniform(2.0),
      shorelineFoamSize: uniform(50.0),
      shorelineBandRange: uniform(2.0),
      shorelineBandCoverage: uniform(0.5),
      shorelineBandOpacity: uniform(1.0),
      shorelineTintRange: uniform(30.0),
      shorelineTintCoverage: uniform(0.5),
      shorelineTintOpacity: uniform(0.3),
      // Turbulent
      turbulentIntensity: uniform(0.2),
      // Water color
      shallowColor: uniform(new Vector3(0, 0.8, 0.8)),
      deepColor: uniform(new Vector3(0, 0.2, 0.4)),
      transmissionColor: uniform(new Vector3(0, 1, 0.8)),
      depthFalloff: uniform(50.0),
      waterDepth: uniform(20.0),
      // Fresnel + SSS internal distance fade is fed by these uniforms in the
      // depth demo, but in this story the atmosphere/aerialPerspective owns
      // distance attenuation. fadeStart/fadeEnd are pinned via local consts in
      // the material; the uniforms exist only so applyWaterproPreset's
      // fadeStart/fadePower writes have a destination (visual no-op).
      fadeStart: uniform(50.0),
      fadeEnd: uniform(200.0),
      fadePower: uniform(1.0),
    }),
    []
  )

  const presetBag: WaterproPresetUniformBag = useMemo(
    () => ({
      shallowColor: u.shallowColor,
      deepColor: u.deepColor,
      depthFalloff: u.depthFalloff,
      transmissionColor: u.transmissionColor,
      surfaceFoamColor: u.surfaceFoamColor,
      surfaceFoamCoverage: u.surfaceFoamCoverage,
      surfaceFoamOpacity: u.surfaceFoamOpacity,
      surfaceFoamSize: u.surfaceFoamSize,
      shorelineFoamColor: u.shorelineFoamColor,
      shorelineFoamCoverage: u.shorelineFoamCoverage,
      shorelineFoamOpacity: u.shorelineFoamOpacity,
      shorelineFoamRange: u.shorelineFoamRange,
      shorelineFoamSize: u.shorelineFoamSize,
      waveFoamColor: u.waveFoamColor,
      waveFoamCoverage: u.waveFoamCoverage,
      waveFoamCrestCoverage: u.waveFoamCrestCoverage,
      waveFoamOpacity: u.waveFoamOpacity,
      waveFoamPeakIntensity: u.waveFoamPeakIntensity,
      waveFoamRippleWeight: u.waveFoamRippleWeight,
      waveFoamWaveWeight: u.waveFoamWaveWeight,
      waveFoamWindBias: u.waveFoamWindBias,
      waveFoamWindStretch: u.waveFoamWindStretch,
      waveFoamSize: u.waveFoamSize,
      fresnelNormalStrength: u.fresnelNormalStrength,
      fresnelPower: u.fresnelPower,
      fadeStart: u.fadeStart,
      fadePower: u.fadePower,
      sparkleIntensity: u.sparkleIntensity,
      sparkleFocusPower: u.sparkleFocusPower,
      sssIntensity: u.sssIntensity,
      sssPower: u.sssPower,
      fftAmplitude: u.fftAmplitude,
      gerstnerAmplitude: u.gerstnerAmplitude,
    }),
    [u]
  )

  // Preset selector. Atmosphere/caustics/oceanFloor/postProcessing/fresnel.underwater/ssr
  // fields from the source presets are intentionally skipped — those belong on
  // the AtmosphereContextNode + post pass.
  useTransientControl(
    (args: StoryArgs) => args.preset,
    preset => {
      if (preset === 'custom') return
      applyWaterproPreset(preset, presetBag)
    }
  )

  useTransientControl(
    (args: StoryArgs) => args,
    args => {
      u.skyReflectionOn.value = args.skyReflection ? 1 : 0
      u.skyReflectionExposure.value = args.skyReflectionExposure
      u.skyReflectionScale.value = args.skyReflectionScale
      // Parse hex → linear vec3, write to uniform. Color.setStyle already
      // converts sRGB→linear via colorSpaceToWorking with three's default
      // workingColorSpace=LinearSRGBColorSpace. Do NOT call convertSRGBToLinear
      // again — it double-converts and crushes non-white values toward zero.
      const c = new Color().setStyle(args.skyReflectionColor)
      u.skyReflectionColor.value.set(c.r, c.g, c.b)
      u.sssOn.value = args.sss ? 1 : 0
      u.sparkleOn.value = args.sparkle ? 1 : 0
      u.surfaceFoamOn.value = args.surfaceFoam ? 1 : 0
      u.waveFoamOn.value = args.waveFoam ? 1 : 0
      u.turbulentFoamOn.value = args.turbulentFoam ? 1 : 0
      u.shorelineFoamOn.value = args.shorelineFoam ? 1 : 0
      u.fftAmplitude.value = args.fftAmplitude
      u.gerstnerAmplitude.value = args.gerstnerAmplitude
      u.fresnelPower.value = args.fresnelPower
      u.fresnelNormalStrength.value = args.normalStrength
      u.sparkleIntensity.value = args.sparkleIntensity
      u.sparkleFocusPower.value = args.sparkleFocusPower
      u.sssIntensity.value = args.sssIntensity
      u.sssPower.value = args.sssPower
      u.surfaceFoamCoverage.value = args.surfaceFoamCoverage
      u.surfaceFoamOpacity.value = args.surfaceFoamOpacity
      u.surfaceFoamSize.value = args.surfaceFoamSize
      u.waveFoamCoverage.value = args.waveFoamCoverage
      u.waveFoamOpacity.value = args.waveFoamOpacity
      u.waveFoamCrestCoverage.value = args.waveFoamCrestCoverage
      u.shorelineBandRange.value = args.shorelineBandRange
      u.shorelineBandCoverage.value = args.shorelineBandCoverage
      u.shorelineBandOpacity.value = args.shorelineBandOpacity
      u.shorelineTintRange.value = args.shorelineTintRange
      u.shorelineTintCoverage.value = args.shorelineTintCoverage
      u.shorelineTintOpacity.value = args.shorelineTintOpacity
      u.turbulentIntensity.value = args.turbulentIntensity
      u.depthFalloff.value = args.depthFalloff
      u.waterDepth.value = args.waterDepth
    }
  )

  // Location → world-to-ECEF matrix. Without this the atmosphere's "up" doesn't
  // match the scene's Y-up and the horizon tilts.
  useLocationControls(context.matrixWorldToECEF.value)

  useLocalDateControls(date => {
    const { matrixECIToECEF, sunDirectionECEF, moonDirectionECEF } = context
    const dateObj = new Date(date)
    getECIToECEFRotationMatrix(dateObj, matrixECIToECEF.value)
    getSunDirectionECI(dateObj, sunDirectionECEF.value).applyMatrix4(
      matrixECIToECEF.value
    )
    getMoonDirectionECI(dateObj, moonDirectionECEF.value).applyMatrix4(
      matrixECIToECEF.value
    )
  })

  // DEBUG: sphere material that visualizes the sky-environment cube. Samples
  // (envNode.renderTarget.texture) by the local outward normal so the sphere's
  // surface displays the cube's content directly. If the sphere shows a
  // gradient matching the sky, the cube is being populated. If it shows
  // uniform gray, SkyEnvironmentNode.updateBefore isn't firing (the cube
  // never gets rendered) and the ocean's reflection has no real data to
  // sample. Uses MeshBasicNodeMaterial so PBR lighting doesn't tint it.
  const skyDebugMaterial = useMemo(() => {
    if (envNode == null) return null
    const skyCubeTex = (envNode as any).renderTarget.texture
    const mat = new MeshBasicNodeMaterial()
    mat.colorNode = vec4(cubeTexture(skyCubeTex, normalLocal).rgb, float(1))
    ;(mat as any).colorSpace = SRGBColorSpace
    return mat
  }, [envNode])

  // Ocean material — mirrors ocean-material.js pattern:
  // MeshStandardNodeMaterial + colorSpace=SRGBColorSpace + colorNode = full
  // composed color. PhysicalLightingModel + AtmosphereLight + envNode IBL
  // multiply the colorNode (as albedo), dimming it to proper radiance scale
  // for the 0.55 × aerialPerspective × AgX exposure 10 chain.
  const oceanMaterial = useMemo(() => {
    if (waveSim == null || gerstner == null) return null

    // Vertex displacement (IFFT + Gerstner) — both scaled by preset amplitude.
    const localPos = vec3(attribute('position').x, attribute('position').y, attribute('position').z)
    const worldXZ = vec2(localPos.x, localPos.z)
    const { displacement: ifftDispRaw } = sampleWaveDisplacement(waveSim, { worldXZ })
    const ifftDisp = ifftDispRaw.mul(u.fftAmplitude)
    const gerstnerEvalVtx = gerstner.evaluate(worldXZ, gerstnerTime)
    const gerstnerDispVtx = gerstnerEvalVtx.displacement.mul(u.gerstnerAmplitude)
    const displacedLocal = localPos.add(ifftDisp).add(gerstnerDispVtx)

    // Fragment normals + Jacobian eigenvalues.
    const displacedWorld4 = modelWorldMatrix.mul(vec4(displacedLocal, float(1)))
    const fragWorldXZ = vec2(displacedWorld4.x, displacedWorld4.z)
    const cascadeSample = sampleWaveNormal(waveSim, { worldXZ: fragWorldXZ })
    const gerstnerFrag = gerstner.evaluate(fragWorldXZ, gerstnerTime)
    const surfaceNormal = vec3(
      cascadeSample.normal.x.add(gerstnerFrag.normal.x.mul(u.gerstnerAmplitude)),
      cascadeSample.normal.y.add(
        gerstnerFrag.normal.y.sub(float(1)).mul(u.gerstnerAmplitude)
      ),
      cascadeSample.normal.z.add(gerstnerFrag.normal.z.mul(u.gerstnerAmplitude)),
    )
    const eigen0 = cascadeSample.eigen0.sub(
      gerstnerFrag.folding.mul(u.gerstnerAmplitude)
    )
    const eigen1 = cascadeSample.eigen1

    // Program 4 (water-color).
    const { waterColor, waterColumnDepth, isObjectInFront, isDynamic } =
      waterColorNode({
        depthTexture: depthTarget.texture,
        depthTextureEnabled: uniform(1.0),
        waterDepth: u.waterDepth,
        depthFalloff: u.depthFalloff,
        shallowColor: u.shallowColor,
        deepColor: u.deepColor,
      })

    // Program 5 (surface foam).
    const surfaceFoam = surfaceFoamNode({
      foamTexture,
      enabled: u.surfaceFoamOn,
      size: u.surfaceFoamSize,
      coverage: u.surfaceFoamCoverage,
      opacity: u.surfaceFoamOpacity,
      foamColor: u.surfaceFoamColor,
    })

    // Program 7 (wave foam).
    const waveFoam = waveFoamNode({
      foamTexture,
      enabled: u.waveFoamOn,
      waveWeight: u.waveFoamWaveWeight,
      rippleWeight: u.waveFoamRippleWeight,
      crestCoverage: u.waveFoamCrestCoverage,
      windBias: u.waveFoamWindBias,
      size: u.waveFoamSize,
      windStretch: u.waveFoamWindStretch,
      coverage: u.waveFoamCoverage,
      opacity: u.waveFoamOpacity,
      peakIntensity: u.waveFoamPeakIntensity,
      foamColor: u.waveFoamColor,
      windDirection: uniform(new Vector2(1, 0)),
      eigen0,
      eigen1,
      hasJacobianFoam: uniform(1.0),
      surfaceNormal,
    })

    // Program 6 (shoreline foam) — two layers (matches depth-demo two-layer
    // setup): tight white band + soft shallow tint.
    const shorelineBand = shorelineFoamNode(waterColumnDepth, {
      foamTexture,
      enabled: u.shorelineFoamOn,
      range: u.shorelineBandRange,
      size: u.shorelineFoamSize,
      coverage: u.shorelineBandCoverage,
      opacity: u.shorelineBandOpacity,
      foamColor: u.shorelineFoamColor,
    })
    const shorelineTint = shorelineFoamNode(waterColumnDepth, {
      foamTexture,
      enabled: u.shorelineFoamOn,
      range: u.shorelineTintRange,
      size: u.shorelineFoamSize,
      coverage: u.shorelineTintCoverage,
      opacity: u.shorelineTintOpacity,
      foamColor: u.shorelineFoamColor,
    })
    const shorelineFoam = shorelineBand

    // Program 2 (fresnel only). distanceFade output discarded — atmospheric
    // attenuation comes from the aerialPerspective post-pass instead of an
    // in-shader blend to a sky-cube sample. Mixing finalColor toward the
    // atmosphere cube's horizon (which is uniformly pale haze) was washing
    // out the foam / highlights / water color — exactly what we want to keep
    // visible. fadeStart/fadeEnd inputs are pinned to large constants so the
    // node still compiles, but the distanceFade output it computes is unused.
    const noFadeStart = uniform(1e6)
    const noFadeEnd = uniform(1e6 + 1)
    const noFadePower = uniform(1.0)
    const fresnelOut = fresnelDistanceNode({
      interpolatedNormal: surfaceNormal,
      worldX: fragWorldXZ.x,
      worldZ: fragWorldXZ.y,
      fadeStart: noFadeStart,
      fadeEnd: noFadeEnd,
      fadePower: noFadePower,
      normalStrength: u.fresnelNormalStrength,
      power: u.fresnelPower,
    })
    const { fresnel: fresnelRaw, distanceToCamera } = fresnelOut
    // SSS short-range mask — artistic, kept at WaterPro defaults.
    const sssFadeStart = uniform(50.0)
    const sssFadeEnd = uniform(200.0)

    const viewDir = cameraPosition.sub(vec3(fragWorldXZ.x, float(0), fragWorldXZ.y)).normalize()

    // Program 3 (SSS).
    const sssOut = subSurfaceScatteringNode({
      viewDir,
      sunDir: sunDirUniform,
      waveNormal: surfaceNormal,
      waterColor,
      distanceToCamera,
      transmissionColor: u.transmissionColor,
      sunIntensity: sunIntensityUniform,
      fadeStart: sssFadeStart,
      fadeEnd: sssFadeEnd,
      enabled: u.sssOn,
      power: u.sssPower,
      intensity: u.sssIntensity,
    })

    // Program 1 (sparkle).
    const sparkleOut = sparkleNode({
      viewDir,
      sunDir: sunDirUniform,
      flippedNormal: surfaceNormal,
      enabled: u.sparkleOn,
      focusPower: u.sparkleFocusPower,
      intensity: u.sparkleIntensity,
      color: uniform(new Vector3(1.0, 0.97, 0.88)),
    })

    // Program 11 (turbulent foam).
    const turbulentFoam = turbulentFoamNode({
      sampleNormal: xz => sampleWaveNormal(waveSim, { worldXZ: xz }).normal,
      enabled: u.turbulentFoamOn,
      sampleEpsilon: uniform(2.0),
      depthAttenuation: uniform(0.5),
      intensity: u.turbulentIntensity,
      worldXZ: fragWorldXZ,
    })

    // AF.build composition.
    const combined = combineFoamNode({
      surfaceFoam,
      waveFoam,
      shorelineFoam,
      scene: { isObjectInFront, isDynamic, fresnel: fresnelRaw },
    })

    // DIAGNOSTIC: reflection is a flat user-controllable colour (sRGB picker,
    // converted to linear in the transient control above). Multiplied by
    // skyReflectionScale.
    const reflectDir = tslReflect(viewDir.negate(), fresnelOut.fresnelNormal)
    void reflectDir
    const skyReflection = u.skyReflectionColor.mul(u.skyReflectionScale)
    const gatedFresnel = fresnelRaw.mul(u.skyReflectionOn)

    // Composition (same layering as depth demo). Use the free `mix(a, b, t)`
    // function — chained `.mix()` in TSL treats the receiver as the BLEND
    // FACTOR (t), not the first source, which silently produces
    // `b*(1-receiver) + c*receiver` instead of the intended a*(1-t) + b*t.
    const waterColorLit = waterColor.add(sssOut.scattering)
    const waterColorLitGlow = waterColorLit.add(sparkleOut.glowColor)
    const reflectedWater = mix(waterColorLitGlow, skyReflection, gatedFresnel)
    const withCombined = mix(
      reflectedWater,
      combined.combinedFoamColor,
      combined.combinedFoamStrength,
    )
    const withTurbulent = withCombined.add(turbulentFoam.foam.mul(float(0.1)))
    const withTint = mix(withTurbulent, shorelineTint.color, shorelineTint.strength)
    const withShoreline = mix(
      withTint,
      combined.shorelineFoamTint,
      combined.shorelineFoamStrength,
    )
    // No in-shader horizon mix — keep the full water composition at all
    // distances; aerialPerspective in the post-pass handles atmospheric
    // attenuation.
    const finalColor = withShoreline

    // MeshStandardNodeMaterial — three's NodeMaterial assigns colorNode to
    // diffuseColor, which PhysicalLightingModel multiplies by
    // (NdotL × sunColor + IBL ambient from scene.environmentNode). This is
    // load-bearing for the post-pass calibration: it dims the otherwise-too-
    // bright sRGB-range composition into linear radiance the AgX-exposure-10
    // tonemap can land correctly.
    const mat = new MeshStandardNodeMaterial()
    mat.positionNode = displacedLocal
    mat.colorNode = vec4(finalColor, float(1))
    mat.side = DoubleSide
    // Tells the renderer the colorNode output is sRGB-encoded — converts to
    // linear before lighting. Matches ocean-material.js:193.
    ;(mat as any).colorSpace = SRGBColorSpace
    return mat
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waveSim, gerstner])

  // Post-processing — mirrors GlobeOceanProto.tsx and Ocean-Basic-Story.tsx.
  const [postProcessing, toneMappingNode] = useResource(
    manage => {
      const passNode = manage(pass(scene, camera, { samples: 0 }))
      const colorNode = passNode.getTextureNode('output')
      const depthNode = passNode.getTextureNode('depth')
      // colorNode.mul(SCENE_RADIANCE_SCALE) — matches GlobeOceanProto:513.
      const aerialNode = manage(
        aerialPerspective(context, colorNode.mul(SCENE_RADIANCE_SCALE), depthNode)
      )
      const lensFlareNode = manage(lensFlare(aerialNode))
      const toneMappingNode = manage(
        toneMapping(AgXToneMapping, uniform(0), lensFlareNode)
      )
      const post = new PostProcessing(renderer)
      post.outputNode = toneMappingNode.add(dithering)
      return [post, toneMappingNode]
    },
    [renderer, scene, camera, context]
  )

  useToneMappingControls(toneMappingNode, () => {
    postProcessing.needsUpdate = true
  })

  // Per-frame wave + sun-direction write.
  const clockRef = useRef({ start: performance.now() / 1000, last: performance.now() / 1000 })
  useFrame(() => {
    if (waveSim == null) return
    const now = performance.now() / 1000
    const dt = now - clockRef.current.last
    const t = now - clockRef.current.start
    clockRef.current.last = now
    waveSim.update(dt, t)
    gerstnerTime.value = t

    matrixECEFToWorld.copy(context.matrixWorldToECEF.value).invert()
    worldSun
      .copy(context.sunDirectionECEF.value)
      .applyMatrix4(matrixECEFToWorld)
      .normalize()
    sunDirUniform.value.copy(worldSun)
  }, 0)

  // Depth pre-pass — clear to white (R=1) so empty pixels decode to cameraFar
  // in the water-column-depth node. Black clear → terrainDepth=cameraNear
  // everywhere → max foam over the whole ocean (footgun documented in
  // depth_pass_webgpu_gotchas.md).
  useGuardedFrame(() => {
    const oceanMesh = oceanMeshRef.current
    const r = renderer as any
    const swapped: Array<{ mesh: Mesh; mat: Material | Material[] }> = []
    if (oceanMesh) oceanMesh.visible = false
    ;[terrainMeshRef.current, capsuleMeshRef.current].forEach(m => {
      if (m == null) return
      swapped.push({ mesh: m, mat: m.material as Material | Material[] })
      m.material = depthMaterial as unknown as Material
    })

    const prevBg = scene.background
    scene.background = null
    r.setRenderTarget(depthTarget)
    r.setClearColor(0xffffff, 1.0)
    r.clear()
    r.render(scene, camera)
    r.setRenderTarget(null)
    r.setClearColor(0x000000, 1.0)
    scene.background = prevBg

    swapped.forEach(({ mesh, mat }) => { mesh.material = mat })
    if (oceanMesh) oceanMesh.visible = true
  }, DEPTH_PASS_PRIORITY)

  useGuardedFrame(() => {
    postProcessing.render()
  }, 1)

  useFrame(() => {
    camera.layers.enableAll()
  })

  return (
    <>
      <atmosphereLight args={[context]} />
      <OrbitControls target={[0, 0, 0]} />

      <mesh ref={terrainMeshRef} position={[0, -15, 0]} rotation={[0.6, 0, 0]}>
        <boxGeometry args={[40, 2, 60]} />
        <meshStandardMaterial color="#5a7a3a" />
      </mesh>

      <mesh ref={capsuleMeshRef} position={[25, 0, 0]}>
        <capsuleGeometry args={[3, 4, 8, 24]} />
        <meshStandardMaterial color="#c04040" />
      </mesh>

      {/* DEBUG: sky-cube probe. Renders the SkyEnvironmentNode renderTarget on
          a sphere via cubeTexture(tex, normalLocal). Gradient = cube populated;
          flat gray = updateBefore not firing. Remove once diagnosed. */}
      {skyDebugMaterial != null && (
        <mesh position={[-20, 8, 0]} material={skyDebugMaterial}>
          <sphereGeometry args={[4, 32, 16]} />
        </mesh>
      )}

      {oceanMaterial != null && (
        <mesh ref={oceanMeshRef} geometry={oceanGeometry} material={oceanMaterial} />
      )}
    </>
  )
}

export const Story: StoryFC<{}, StoryArgs> = () => {
  return (
    <WebGPUCanvas
      camera={{ position: [0, 20, 40], fov: 50, near: 0.1, far: 500 }}
      renderer={{
        antialias: true,
        onInit: r => {
          r.library.addLight(AtmosphereLightNode, AtmosphereLight)
        },
      }}
    >
      <Content />
    </WebGPUCanvas>
  )
}

const range = (min: number, max: number, step = 0.01) => ({
  control: { type: 'range' as const, min, max, step },
})

Story.args = {
  ...toneMappingArgs({ toneMappingExposure: 10 }),
  ...locationArgs({ longitude: 30, latitude: 35, height: 300 }),
  ...localDateArgs({ dayOfYear: 0, timeOfDay: 9 }),
  preset: 'custom',
  skyReflection: true,
  skyReflectionColor: '#ffffff',
  skyReflectionExposure: 0.2,
  skyReflectionScale: 1.0,
  sss: true,
  sparkle: true,
  surfaceFoam: true,
  waveFoam: true,
  turbulentFoam: true,
  shorelineFoam: true,
  fftAmplitude: 1.0,
  gerstnerAmplitude: 1.0,
  fresnelPower: 3.0,
  normalStrength: 0.1,
  sparkleIntensity: 1.5,
  sparkleFocusPower: 75.7,
  sssIntensity: 0.5,
  sssPower: 16.0,
  surfaceFoamCoverage: 0.02,
  surfaceFoamOpacity: 0.25,
  surfaceFoamSize: 20.0,
  waveFoamCoverage: 0.5,
  waveFoamOpacity: 0.6,
  waveFoamCrestCoverage: 0.3,
  shorelineBandRange: 2.0,
  shorelineBandCoverage: 0.5,
  shorelineBandOpacity: 1.0,
  shorelineTintRange: 30.0,
  shorelineTintCoverage: 0.5,
  shorelineTintOpacity: 0.3,
  turbulentIntensity: 0.2,
  depthFalloff: 50.0,
  waterDepth: 20.0,
}

Story.argTypes = {
  ...toneMappingArgTypes(),
  ...locationArgTypes(),
  ...localDateArgTypes(),
  preset: {
    control: { type: 'select' },
    options: ['custom', ...WATERPRO_PRESET_NAMES],
    table: { category: 'Preset' },
  },
  skyReflection: { control: 'boolean', table: { category: 'Toggles' } },
  skyReflectionColor: {
    control: { type: 'color' },
    table: { category: 'Reflection' },
  },
  skyReflectionExposure: {
    ...range(0.01, 2, 0.01),
    table: { category: 'Reflection' },
  },
  skyReflectionScale: {
    ...range(0, 3, 0.05),
    table: { category: 'Reflection' },
  },
  sss: { control: 'boolean', table: { category: 'Toggles' } },
  sparkle: { control: 'boolean', table: { category: 'Toggles' } },
  surfaceFoam: { control: 'boolean', table: { category: 'Toggles' } },
  waveFoam: { control: 'boolean', table: { category: 'Toggles' } },
  turbulentFoam: { control: 'boolean', table: { category: 'Toggles' } },
  shorelineFoam: { control: 'boolean', table: { category: 'Toggles' } },

  fftAmplitude: { ...range(0, 2, 0.01), table: { category: 'Waves' } },
  gerstnerAmplitude: { ...range(0, 6, 0.01), table: { category: 'Waves' } },

  fresnelPower: { ...range(1, 8, 0.1), table: { category: 'Fresnel' } },
  normalStrength: { ...range(0, 1, 0.01), table: { category: 'Fresnel' } },

  sparkleIntensity: { ...range(0, 10, 0.1), table: { category: 'Sparkle' } },
  sparkleFocusPower: { ...range(1, 1000, 1), table: { category: 'Sparkle' } },

  sssIntensity: { ...range(0, 5, 0.05), table: { category: 'SSS' } },
  sssPower: { ...range(0.5, 64, 0.1), table: { category: 'SSS' } },

  surfaceFoamCoverage: { ...range(0, 1, 0.01), table: { category: 'Surface foam' } },
  surfaceFoamOpacity: { ...range(0, 1, 0.01), table: { category: 'Surface foam' } },
  surfaceFoamSize: { ...range(1, 250, 1), table: { category: 'Surface foam' } },

  waveFoamCoverage: { ...range(0, 1, 0.01), table: { category: 'Wave foam' } },
  waveFoamOpacity: { ...range(0, 1, 0.01), table: { category: 'Wave foam' } },
  waveFoamCrestCoverage: { ...range(0, 1, 0.01), table: { category: 'Wave foam' } },

  shorelineBandRange: { ...range(0.1, 100, 0.1), table: { category: 'Shoreline foam – band' } },
  shorelineBandCoverage: { ...range(0, 1, 0.01), table: { category: 'Shoreline foam – band' } },
  shorelineBandOpacity: { ...range(0, 1, 0.01), table: { category: 'Shoreline foam – band' } },
  shorelineTintRange: { ...range(1, 200, 1), table: { category: 'Shoreline foam – tint' } },
  shorelineTintCoverage: { ...range(0, 1, 0.01), table: { category: 'Shoreline foam – tint' } },
  shorelineTintOpacity: { ...range(0, 1, 0.01), table: { category: 'Shoreline foam – tint' } },

  turbulentIntensity: { ...range(0, 2, 0.05), table: { category: 'Turbulent foam' } },

  depthFalloff: { ...range(1, 300, 1), table: { category: 'Water color' } },
  waterDepth: { ...range(1, 100, 1), table: { category: 'Water color' } },
}
