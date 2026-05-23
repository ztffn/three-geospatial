// Faithful port of the decompiled WaterPro pipeline into TSL.
// Pieces in play (matching decompiled class names):
//   - SF cascade simulation   → WaveSimulation (3-cascade IFFT)
//   - Gerstner overlay        → GerstnerOverlay
//   - program 4 (water color) → waterColorNode
//   - program 5 (surface foam)→ surfaceFoamNode
//   - program 6 (shoreline)   → shorelineFoamNode
//   - program 7 (wave foam)   → waveFoamNode
//   - program 11 (turbulent)  → turbulentFoamNode
//   - program 1 (sparkle)     → sparkleNode
//   - program 2 (fresnel)     → fresnelDistanceNode
//   - program 3 (SSS)         → subSurfaceScatteringNode
//   - AF.build compositor     → combineFoamNode
//
// All feature toggles + tuning knobs are exposed via Storybook args at the
// bottom of this file (see Story.args / Story.argTypes). Args drive TSL
// uniforms via useTransientControl, so the material is built exactly once.

import { OrbitControls } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState, type FC } from 'react'
import {
  Color,
  CubeTextureLoader,
  DoubleSide,
  HalfFloatType,
  LinearFilter,
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
import { MeshBasicNodeMaterial } from 'three/webgpu'
import {
  Fn,
  attribute,
  cameraPosition,
  cubeTexture,
  float,
  positionView,
  cameraNear,
  cameraFar,
  reflect as tslReflect,
  uniform,
  vec2,
  vec3,
  vec4,
  modelWorldMatrix,
} from 'three/tsl'

import type { StoryFC } from '../components/createStory'
import { WebGPUCanvas } from '../components/WebGPUCanvas'
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
} from '../../../packages/ocean-ifft/src/waterpro/index.js'

const DEPTH_PASS_PRIORITY = 0.5
const RENDER_PRIORITY = 1
const PLANE_SIZE = 80
const PLANE_SEGMENTS = 256
const IFFT_RESOLUTION = 256
const GERSTNER_MAX_WAVES = 8

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

const cubeLoader = new CubeTextureLoader()
const skyCubemap = cubeLoader.load(
  ['px', 'nx', 'py', 'ny', 'pz', 'nz'].map(
    f => `/ocean-ifft-resources/textures/cube/sky/${f}.jpg`
  )
)
skyCubemap.minFilter = LinearFilter
skyCubemap.magFilter = LinearFilter
skyCubemap.colorSpace = SRGBColorSpace

function colorVec3Uniform(color: Color): any {
  return uniform(new Vector3(color.r, color.g, color.b))
}

// ── Storybook arg shape (consumed inside Content via useTransientControl) ─────
interface StoryArgs {
  // Feature toggles
  skyReflection: boolean
  sss: boolean
  sparkle: boolean
  surfaceFoam: boolean
  waveFoam: boolean
  turbulentFoam: boolean
  shorelineFoam: boolean
  distanceFade: boolean
  // Sliders
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
  // Shoreline foam is now two layers: a tight white band at the waterline + a
  // wider faint tint over shallow water.
  shorelineBandRange: number
  shorelineBandCoverage: number
  shorelineBandOpacity: number
  shorelineTintRange: number
  shorelineTintCoverage: number
  shorelineTintOpacity: number
  turbulentIntensity: number
  depthFalloff: number
  waterDepth: number
  fadeStart: number
  fadeEnd: number
}

const Content: FC = () => {
  const { gl, scene, camera, size } = useThree()
  useEffect(() => {
    const prev = scene.background
    scene.background = skyCubemap
    return () => {
      scene.background = prev
    }
  }, [scene])
  const oceanMeshRef = useRef<Mesh>(null)
  const terrainMeshRef = useRef<Mesh>(null)
  const capsuleMeshRef = useRef<Mesh>(null)
  const depthMaterial = useMemo(() => createLinearDepthMaterial(), [])

  // ── Wave simulation lifecycle ─────────────────────────────────────────────
  const [waveSim, setWaveSim] = useState<WaveSimulation | null>(null)
  const [gerstner, setGerstner] = useState<GerstnerOverlay | null>(null)
  const gerstnerTime = useMemo(() => uniform(0), [])
  useEffect(() => {
    if (gl == null) return
    const sim = new WaveSimulation({
      renderer: gl,
      resolution: IFFT_RESOLUTION,
    })
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
  }, [gl])

  // ── Depth render target ───────────────────────────────────────────────────
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

  // ── Uniforms tied to Storybook args ───────────────────────────────────────
  // Stable identity across material rebuilds so useTransientControl can write
  // into the same uniform object the TSL graph holds a reference to.
  const u = useMemo(
    () => ({
      // Toggles (0|1)
      skyReflectionOn: uniform(1.0),
      sssOn: uniform(1.0),
      sparkleOn: uniform(1.0),
      surfaceFoamOn: uniform(1.0),
      waveFoamOn: uniform(1.0),
      turbulentFoamOn: uniform(1.0),
      shorelineFoamOn: uniform(1.0),
      distanceFadeOn: uniform(1.0),
      // Fresnel / normal
      fresnelPower: uniform(3.0),
      normalStrength: uniform(0.1),
      // Sparkle
      sparkleIntensity: uniform(1.5),
      sparkleFocusPower: uniform(75.7),
      // SSS
      sssIntensity: uniform(0.5),
      sssPower: uniform(16.0),
      // Surface foam
      surfaceFoamCoverage: uniform(0.02),
      surfaceFoamOpacity: uniform(0.25),
      surfaceFoamSize: uniform(20.0),
      // Wave foam
      waveFoamCoverage: uniform(0.5),
      waveFoamOpacity: uniform(0.6),
      waveFoamCrestCoverage: uniform(0.3),
      // Shoreline foam — two layers: tight white band + soft shallow tint
      shorelineBandRange: uniform(2.0),
      shorelineBandCoverage: uniform(0.5),
      shorelineBandOpacity: uniform(1.0),
      shorelineTintRange: uniform(30.0),
      shorelineTintCoverage: uniform(0.5),
      shorelineTintOpacity: uniform(0.3),
      // Turbulent
      turbulentIntensity: uniform(0.2),
      // Water color
      depthFalloff: uniform(50.0),
      waterDepth: uniform(20.0),
      // Distance fade
      fadeStart: uniform(50.0),
      fadeEnd: uniform(200.0),
    }),
    []
  )

  // Storybook → uniforms.
  useTransientControl(
    (args: StoryArgs) => args,
    args => {
      u.skyReflectionOn.value = args.skyReflection ? 1 : 0
      u.sssOn.value = args.sss ? 1 : 0
      u.sparkleOn.value = args.sparkle ? 1 : 0
      u.surfaceFoamOn.value = args.surfaceFoam ? 1 : 0
      u.waveFoamOn.value = args.waveFoam ? 1 : 0
      u.turbulentFoamOn.value = args.turbulentFoam ? 1 : 0
      u.shorelineFoamOn.value = args.shorelineFoam ? 1 : 0
      u.distanceFadeOn.value = args.distanceFade ? 1 : 0
      u.fresnelPower.value = args.fresnelPower
      u.normalStrength.value = args.normalStrength
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
      u.fadeStart.value = args.fadeStart
      u.fadeEnd.value = args.fadeEnd
    }
  )

  // ── Ocean material (built once when wave sim is ready) ────────────────────
  const oceanMaterial = useMemo(() => {
    if (waveSim == null || gerstner == null) return null

    // Vertex displacement: IFFT + Gerstner.
    const localPos = vec3(attribute('position').x, attribute('position').y, attribute('position').z)
    const worldXZ = vec2(localPos.x, localPos.z)
    const { displacement: ifftDisp } = sampleWaveDisplacement(waveSim, { worldXZ })
    const gerstnerEval = gerstner.evaluate(worldXZ, gerstnerTime)
    const displacedLocal = localPos.add(ifftDisp).add(gerstnerEval.displacement)

    // Fragment normals + Jacobian eigenvalues.
    const displacedWorld4 = modelWorldMatrix.mul(vec4(displacedLocal, float(1)))
    const fragWorldXZ = vec2(displacedWorld4.x, displacedWorld4.z)
    const cascadeSample = sampleWaveNormal(waveSim, { worldXZ: fragWorldXZ })
    const gerstnerFrag = gerstner.evaluate(fragWorldXZ, gerstnerTime)
    const surfaceNormal = vec3(
      cascadeSample.normal.x.add(gerstnerFrag.normal.x),
      cascadeSample.normal.y.add(gerstnerFrag.normal.y.sub(float(1))),
      cascadeSample.normal.z.add(gerstnerFrag.normal.z),
    )
    const eigen0 = cascadeSample.eigen0.sub(gerstnerFrag.folding)
    const eigen1 = cascadeSample.eigen1

    // Program 4 (water-color).
    const shallowColor = colorVec3Uniform(new Color(0x00cccc))
    const deepColor = colorVec3Uniform(new Color(0x003366))
    const { waterColor, waterColumnDepth, isObjectInFront, isDynamic } =
      waterColorNode({
        depthTexture: depthTarget.texture,
        depthTextureEnabled: uniform(1.0),
        waterDepth: u.waterDepth,
        depthFalloff: u.depthFalloff,
        shallowColor,
        deepColor,
      })

    // Program 5 (surface foam) — `enabled` from arg toggle.
    const surfaceFoam = surfaceFoamNode({
      foamTexture,
      enabled: u.surfaceFoamOn,
      size: u.surfaceFoamSize,
      coverage: u.surfaceFoamCoverage,
      opacity: u.surfaceFoamOpacity,
      foamColor: colorVec3Uniform(new Color(0xffffff)),
    })

    // Program 7 (wave foam).
    const waveFoam = waveFoamNode({
      foamTexture,
      enabled: u.waveFoamOn,
      waveWeight: uniform(1.0),
      rippleWeight: uniform(1.0),
      crestCoverage: u.waveFoamCrestCoverage,
      windBias: uniform(0.8),
      size: u.surfaceFoamSize, // share the demo's tile size
      windStretch: uniform(0.5),
      coverage: u.waveFoamCoverage,
      opacity: u.waveFoamOpacity,
      peakIntensity: uniform(1.0),
      foamColor: colorVec3Uniform(new Color(0xffffff)),
      windDirection: uniform(new Vector2(1, 0)),
      eigen0,
      eigen1,
      hasJacobianFoam: uniform(1.0),
      surfaceNormal,
    })

    // Program 6 (shoreline foam) — TWO layers:
    //   1. shorelineBand: tight (~1-2m) band right at the waterline; high
    //      opacity → reads as a crisp white foam line where the wedge meets
    //      the ocean surface.
    //   2. shorelineTint: softer (~15m) faint white shimmer over the wider
    //      shallow zone; layered behind the band.
    // Both use the same node; they layer because foam strength is
    // independent per node (each computes its own zoneMask from `range`).
    const shorelineBand = shorelineFoamNode(waterColumnDepth, {
      foamTexture,
      enabled: u.shorelineFoamOn,
      range: u.shorelineBandRange,
      size: uniform(50.0),
      coverage: u.shorelineBandCoverage,
      opacity: u.shorelineBandOpacity,
      foamColor: colorVec3Uniform(new Color(0xffffff)),
    })
    const shorelineTint = shorelineFoamNode(waterColumnDepth, {
      foamTexture,
      enabled: u.shorelineFoamOn,
      range: u.shorelineTintRange,
      size: uniform(50.0),
      coverage: u.shorelineTintCoverage,
      opacity: u.shorelineTintOpacity,
      foamColor: colorVec3Uniform(new Color(0xffffff)),
    })
    // AF.build's shoreline channel still expects a single contribution. Pass
    // the band (sharper / brighter) so the foam compositor's effectiveFresnel
    // modulation tracks the visible waterline.
    const shorelineFoam = shorelineBand

    // Program 2 (fresnel + distance fade).
    const fresnelOut = fresnelDistanceNode({
      interpolatedNormal: surfaceNormal,
      worldX: fragWorldXZ.x,
      worldZ: fragWorldXZ.y,
      fadeStart: u.fadeStart,
      fadeEnd: u.fadeEnd,
      fadePower: uniform(1.0),
      normalStrength: u.normalStrength,
      power: u.fresnelPower,
    })
    const { fresnel: fresnelRaw, distanceToCamera, distanceFade: distanceFadeRaw } = fresnelOut

    // Program 3 (SSS).
    const sunDir = uniform(new Vector3(-0.4, -0.7, -0.3).normalize())
    const viewDir = cameraPosition.sub(vec3(fragWorldXZ.x, float(0), fragWorldXZ.y)).normalize()
    const sssOut = subSurfaceScatteringNode({
      viewDir,
      sunDir,
      waveNormal: surfaceNormal,
      waterColor,
      distanceToCamera,
      transmissionColor: colorVec3Uniform(new Color(0x00ffcc)),
      sunIntensity: uniform(1.0),
      fadeStart: u.fadeStart,
      fadeEnd: u.fadeEnd,
      enabled: u.sssOn,
      power: u.sssPower,
      intensity: u.sssIntensity,
    })

    // Program 1 (sparkle).
    const sparkleOut = sparkleNode({
      viewDir,
      sunDir,
      flippedNormal: surfaceNormal,
      enabled: u.sparkleOn,
      focusPower: u.sparkleFocusPower,
      intensity: u.sparkleIntensity,
      color: colorVec3Uniform(new Color(1.0, 0.97, 0.88)),
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

    // AF.build composition (fresnel passed through whether on/off — the
    // foam-fresnel coupling needs a value but the visible reflection is gated
    // separately).
    const combined = combineFoamNode({
      surfaceFoam,
      waveFoam,
      shorelineFoam,
      scene: { isObjectInFront, isDynamic, fresnel: fresnelRaw },
    })

    // Sky reflection (gated by sky toggle uniform via fresnel multiplier).
    const reflectDir = tslReflect(viewDir.negate(), fresnelOut.fresnelNormal)
    const skyReflection = cubeTexture(skyCubemap, reflectDir).rgb
    const gatedFresnel = fresnelRaw.mul(u.skyReflectionOn)

    // ── Compositing ──────────────────────────────────────────────────────────
    // Each layer's contribution strength is already gated (via the node's
    // `enabled` uniform or a multiplicand). The graph stays the same shape.
    const waterColorLit = waterColor.add(sssOut.scattering)
    const waterColorLitGlow = waterColorLit.add(sparkleOut.glowColor)
    const reflectedWater = waterColorLitGlow.mix(skyReflection, gatedFresnel)
    const withCombined = reflectedWater.mix(
      combined.combinedFoamColor,
      combined.combinedFoamStrength
    )
    const withTurbulent = withCombined.add(turbulentFoam.foam.mul(float(0.1)))
    // Shoreline composition: tint layer first (broader, faint), band layer on
    // top (tight, bright). Layered mix → tint subtly brightens the shallow
    // zone, then the band paints a crisp white line at the waterline.
    const withTint = withTurbulent.mix(
      shorelineTint.color,
      shorelineTint.strength,
    )
    const withShoreline = withTint.mix(
      combined.shorelineFoamTint,
      combined.shorelineFoamStrength,
    )
    const horizonSample = cubeTexture(skyCubemap, viewDir.negate()).rgb
    const gatedFade = distanceFadeRaw.mul(u.distanceFadeOn)
    const finalColor = withShoreline.mix(horizonSample, gatedFade)

    const mat = new MeshBasicNodeMaterial()
    mat.positionNode = displacedLocal
    mat.colorNode = vec4(finalColor, float(1))
    mat.side = DoubleSide
    return mat
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waveSim, gerstner])

  // Per-frame wave update.
  const clockRef = useRef({ start: performance.now() / 1000, last: performance.now() / 1000 })
  useFrame(() => {
    if (waveSim == null) return
    const now = performance.now() / 1000
    const dt = now - clockRef.current.last
    const t = now - clockRef.current.start
    clockRef.current.last = now
    waveSim.update(dt, t)
    gerstnerTime.value = t
  }, 0)

  // Depth pre-pass.
  useFrame(() => {
    const oceanMesh = oceanMeshRef.current
    const renderer = gl as any
    const swapped: Array<{ mesh: Mesh; mat: Material | Material[] }> = []
    if (oceanMesh) oceanMesh.visible = false
    ;[terrainMeshRef.current, capsuleMeshRef.current].forEach(m => {
      if (m == null) return
      swapped.push({ mesh: m, mat: m.material as Material | Material[] })
      m.material = depthMaterial as unknown as Material
    })

    renderer.setRenderTarget(depthTarget)
    renderer.setClearColor(0xffffff, 1.0)
    renderer.clear()
    renderer.render(scene, camera)
    renderer.setRenderTarget(null)
    renderer.setClearColor(0x000000, 1.0)

    swapped.forEach(({ mesh, mat }) => { mesh.material = mat })
    if (oceanMesh) oceanMesh.visible = true
  }, DEPTH_PASS_PRIORITY)

  useFrame(() => {
    ;(gl as any).render(scene, camera)
  }, RENDER_PRIORITY)

  return (
    <>
      <OrbitControls target={[0, 0, 0]} />
      <ambientLight intensity={0.4} />
      <directionalLight position={[10, 20, 10]} intensity={1.2} />

      <mesh ref={terrainMeshRef} position={[0, -15, 0]} rotation={[0.6, 0, 0]}>
        <boxGeometry args={[40, 2, 60]} />
        <meshStandardMaterial color="#5a7a3a" />
      </mesh>

      <mesh ref={capsuleMeshRef} position={[25, 0, 0]}>
        <capsuleGeometry args={[3, 4, 8, 24]} />
        <meshStandardMaterial color="#c04040" />
      </mesh>

      {oceanMaterial != null && (
        <mesh
          ref={oceanMeshRef}
          geometry={oceanGeometry}
          material={oceanMaterial}
        />
      )}
    </>
  )
}

export const Story: StoryFC<{}, StoryArgs> = () => {
  return (
    <WebGPUCanvas camera={{ position: [0, 20, 40], fov: 50, near: 0.1, far: 500 }}>
      <Content />
    </WebGPUCanvas>
  )
}

const range = (min: number, max: number, step = 0.01) => ({
  control: { type: 'range' as const, min, max, step },
})

Story.args = {
  // Toggles — default everything ON so the demo shows the full pipeline.
  skyReflection: true,
  sss: true,
  sparkle: true,
  surfaceFoam: true,
  waveFoam: true,
  turbulentFoam: true,
  shorelineFoam: true,
  distanceFade: true,
  // Sliders default to the tuned values from the prior iteration.
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
  fadeStart: 50.0,
  fadeEnd: 200.0,
}

Story.argTypes = {
  skyReflection: { control: 'boolean', table: { category: 'Toggles' } },
  sss: { control: 'boolean', table: { category: 'Toggles' } },
  sparkle: { control: 'boolean', table: { category: 'Toggles' } },
  surfaceFoam: { control: 'boolean', table: { category: 'Toggles' } },
  waveFoam: { control: 'boolean', table: { category: 'Toggles' } },
  turbulentFoam: { control: 'boolean', table: { category: 'Toggles' } },
  shorelineFoam: { control: 'boolean', table: { category: 'Toggles' } },
  distanceFade: { control: 'boolean', table: { category: 'Toggles' } },

  fresnelPower: { ...range(1, 8, 0.1), table: { category: 'Fresnel' } },
  normalStrength: { ...range(0, 1, 0.01), table: { category: 'Fresnel' } },

  sparkleIntensity: { ...range(0, 10, 0.1), table: { category: 'Sparkle' } },
  sparkleFocusPower: { ...range(1, 200, 1), table: { category: 'Sparkle' } },

  sssIntensity: { ...range(0, 5, 0.05), table: { category: 'SSS' } },
  sssPower: { ...range(1, 64, 1), table: { category: 'SSS' } },

  surfaceFoamCoverage: { ...range(0, 1, 0.01), table: { category: 'Surface foam' } },
  surfaceFoamOpacity: { ...range(0, 1, 0.01), table: { category: 'Surface foam' } },
  surfaceFoamSize: { ...range(1, 200, 1), table: { category: 'Surface foam' } },

  waveFoamCoverage: { ...range(0, 1, 0.01), table: { category: 'Wave foam' } },
  waveFoamOpacity: { ...range(0, 1, 0.01), table: { category: 'Wave foam' } },
  waveFoamCrestCoverage: { ...range(0, 1, 0.01), table: { category: 'Wave foam' } },

  shorelineBandRange: { ...range(0.1, 20, 0.1), table: { category: 'Shoreline foam – band' } },
  shorelineBandCoverage: { ...range(0, 1, 0.01), table: { category: 'Shoreline foam – band' } },
  shorelineBandOpacity: { ...range(0, 1, 0.01), table: { category: 'Shoreline foam – band' } },
  shorelineTintRange: { ...range(1, 200, 1), table: { category: 'Shoreline foam – tint' } },
  shorelineTintCoverage: { ...range(0, 1, 0.01), table: { category: 'Shoreline foam – tint' } },
  shorelineTintOpacity: { ...range(0, 1, 0.01), table: { category: 'Shoreline foam – tint' } },

  turbulentIntensity: { ...range(0, 2, 0.05), table: { category: 'Turbulent foam' } },

  depthFalloff: { ...range(1, 200, 1), table: { category: 'Water color' } },
  waterDepth: { ...range(1, 100, 1), table: { category: 'Water color' } },

  fadeStart: { ...range(1, 500, 1), table: { category: 'Distance fade' } },
  fadeEnd: { ...range(1, 1000, 1), table: { category: 'Distance fade' } },
}
