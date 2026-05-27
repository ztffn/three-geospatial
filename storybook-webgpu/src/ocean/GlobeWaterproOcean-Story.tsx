// G-C: storybook mount of the globe-scale ocean scene with the WaterPro TSL
// fragment composition replacing the legacy chunk material. Composition mirrors
// localhost:5173 (atmosphere + 3D-tiles terrain + tiled IFFT ocean) but the
// chunk material is now built by buildWaterproChunkMaterial + WaveSimulation,
// driven via OceanChunksWaterpro. Legacy WaveGenerator + OceanChunks are no
// longer instantiated by this story.

'use client'

import { OrbitControls } from '@react-three/drei'
import {
  extend,
  useFrame,
  useThree,
  type ThreeElement,
} from '@react-three/fiber'
import { CesiumIonAuthPlugin } from '3d-tiles-renderer/plugins'
import { TilesPlugin, TilesRenderer } from '3d-tiles-renderer/r3f'
import { useControls } from 'leva'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FC,
} from 'react'
import {
  AgXToneMapping,
  Matrix4,
  Mesh,
  RepeatWrapping,
  Scene,
  SRGBColorSpace,
  TextureLoader,
  Vector3,
} from 'three'
import { pass, toneMapping, uniform } from 'three/tsl'
import * as THREE from 'three/webgpu'
import {
  MeshLambertNodeMaterial,
  PostProcessing,
  type Renderer,
} from 'three/webgpu'

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
  StarsNode,
} from '@takram/three-atmosphere/webgpu'
import {
  Ellipsoid,
  Geodetic,
  PointOfView,
  radians,
} from '@takram/three-geospatial'
import { dithering, lensFlare } from '@takram/three-geospatial/webgpu'

import {
  applyWaterproPreset,
  WATERPRO_PRESET_NAMES,
  type WaterproPresetName,
  type WaterproPresetUniformBag,
} from '../../../packages/ocean-ifft/src/waterpro/index.js'
import { Color } from 'three'

import OceanChunksWaterpro from './OceanChunksWaterpro'
import type { WaterproOceanUniforms } from './buildWaterproOceanMaterial'
import type { UniformNode } from 'three/webgpu'

// WGSL-vertex-stage uniform handles exposed by OceanChunksWaterpro.onReady.
// Story-side controls (Swell, future LOD slider, etc.) write through these.
type VertexUniformsBag = {
  lodScale: UniformNode<number>
  swellScale: UniformNode<number>
  swellStrength: UniformNode<number>
  gerstnerWave0: UniformNode<THREE.Vector4>
  gerstnerWave1: UniformNode<THREE.Vector4>
  gerstnerWave2: UniformNode<THREE.Vector4>
  gerstnerSteepness: UniformNode<number>
}

import type { StoryFC } from '../components/createStory'
import { WebGPUCanvas } from '../components/WebGPUCanvas'

declare module '@react-three/fiber' {
  interface ThreeElements {
    atmosphereLight: ThreeElement<typeof AtmosphereLight>
  }
}

extend({ AtmosphereLight })

const heading = 180
const pitch = -20
const distance = 3500
const globalTerrainAssetId = 1
const japanRegionalTerrainAssetId = 2767062

const locationPresets = {
  Tokyo: { longitude: 139.7671, latitude: 35.6812, height: 20 },
  Oslo: { longitude: 10.7522, latitude: 59.9139, height: 20 },
  'New York': { longitude: -74.006, latitude: 40.7128, height: 20 },
  'Cape Town': { longitude: 18.4241, latitude: -33.9249, height: 20 },
  Sydney: { longitude: 151.2093, latitude: -33.8688, height: 20 },
  Reykjavik: { longitude: -21.9426, latitude: 64.1466, height: 20 },
} satisfies Record<
  string,
  { longitude: number; latitude: number; height: number }
>

function getLocalDate(
  longitudeDegrees: number,
  dayOfYear: number,
  timeOfDay: number,
  year: number
): Date {
  const epoch = Date.UTC(year, 0, 1, 0, 0, 0, 0)
  const offset = longitudeDegrees / 15
  return new Date(
    epoch + ((dayOfYear - 1) * 24 + timeOfDay - offset) * 3600000
  )
}

function isInsideJapanRegionalTerrain(
  longitudeDegrees: number,
  latitudeDegrees: number
): boolean {
  return (
    longitudeDegrees >= 122 &&
    longitudeDegrees <= 154 &&
    latitudeDegrees >= 20 &&
    latitudeDegrees <= 46
  )
}

interface TilesEventTarget {
  addEventListener: (
    type: string,
    listener: (event: { scene: THREE.Object3D }) => void
  ) => void
  removeEventListener: (
    type: string,
    listener: (event: { scene: THREE.Object3D }) => void
  ) => void
  group: THREE.Group
}

class TileMaterialReplacementPlugin {
  private tiles?: TilesEventTarget

  init(tiles: TilesEventTarget): void {
    this.tiles = tiles
    tiles.group.traverse(object => {
      replaceMaterial(object)
    })
    tiles.addEventListener('load-model', this.handleLoadModel)
    tiles.addEventListener('dispose-model', this.handleDisposeModel)
  }

  dispose(): void {
    this.tiles?.removeEventListener('load-model', this.handleLoadModel)
    this.tiles?.removeEventListener('dispose-model', this.handleDisposeModel)
  }

  private readonly handleLoadModel = ({
    scene,
  }: {
    scene: THREE.Object3D
  }): void => {
    if (this.tiles == null) return
    scene.traverse(object => {
      replaceMaterial(object)
    })
  }

  private readonly handleDisposeModel = ({
    scene,
  }: {
    scene: THREE.Object3D
  }): void => {
    if (this.tiles == null) return
    scene.traverse(object => {
      if (object instanceof Mesh) {
        object.material.dispose()
      }
    })
  }
}

function replaceMaterial(object: THREE.Object3D): void {
  if (!(object instanceof Mesh)) return
  const sourceMaterial = object.material
  if (Array.isArray(sourceMaterial)) return

  object.geometry.computeVertexNormals()

  const material = new MeshLambertNodeMaterial({
    color: '#6f7f68',
  })
  if ('map' in sourceMaterial && sourceMaterial.map != null) {
    material.map = sourceMaterial.map.clone()
  }
  object.material = material
  sourceMaterial.dispose()
}

function useTargetECEF(
  longitudeDegrees: number,
  latitudeDegrees: number,
  targetHeight: number
): Vector3 {
  return useMemo(
    () =>
      new Geodetic(
        radians(longitudeDegrees),
        radians(latitudeDegrees),
        targetHeight
      ).toECEF(),
    [latitudeDegrees, longitudeDegrees, targetHeight]
  )
}

// Static ocean textures — loaded once outside the component tree so React
// fast-refresh / control changes don't re-fetch from the storybook static
// dir each frame.
const oceanTextureLoader = new TextureLoader()
const foamTexture = oceanTextureLoader.load(
  '/ocean-ifft-resources/textures/simplex-noise.png'
)
foamTexture.wrapS = RepeatWrapping
foamTexture.wrapT = RepeatWrapping

const OceanSurface: FC<{
  target: Vector3
  atmosphereContext: AtmosphereContextNode
  envCubeTexture: THREE.CubeTexture
  onUniformsReady: (uniforms: WaterproOceanUniforms) => void
  onVertexUniformsReady: (vu: VertexUniformsBag) => void
  onOceanManagerReady: (oceanManager: any) => void
  seaLevelOffset: number
  oceanScale: number
  numLayers: number
  useDiagnosticMaterial: boolean
  skipDepthPrepass: boolean
}> = ({
  target,
  atmosphereContext,
  envCubeTexture,
  onUniformsReady,
  onVertexUniformsReady,
  onOceanManagerReady,
  seaLevelOffset,
  oceanScale,
  numLayers,
  useDiagnosticMaterial,
  skipDepthPrepass,
}) => {
  const [oceanParent, setOceanParent] = useState<THREE.Group | null>(null)
  const handleOceanParent = useCallback((group: THREE.Group | null) => {
    setOceanParent(group)
  }, [])
  const matrix = useMemo(() => {
    const east = new Vector3()
    const north = new Vector3()
    const up = new Vector3()
    Ellipsoid.WGS84.getEastNorthUpVectors(target, east, north, up)

    const result = new Matrix4().makeBasis(
      east.multiplyScalar(oceanScale),
      up,
      north.multiplyScalar(oceanScale)
    )
    result.setPosition(target.clone().addScaledVector(up, seaLevelOffset))
    return result
  }, [oceanScale, seaLevelOffset, target])

  useLayoutEffect(() => {
    if (oceanParent == null) return
    oceanParent.matrix.copy(matrix)
    oceanParent.matrixWorldNeedsUpdate = true
    oceanParent.updateMatrixWorld(true)
  }, [matrix, oceanParent])

  return (
    <>
      <group ref={handleOceanParent} matrixAutoUpdate={false} />
      {oceanParent != null ? (
        <OceanChunksWaterpro
          parent={oceanParent}
          atmosphereContext={atmosphereContext}
          envCubeTexture={envCubeTexture}
          foamTexture={foamTexture}
          numLayers={numLayers}
          useDiagnosticMaterial={useDiagnosticMaterial}
          skipDepthPrepass={skipDepthPrepass}
          onReady={({ uniforms, vertexUniforms, oceanManager }) => {
            onUniformsReady(uniforms)
            onVertexUniformsReady(vertexUniforms)
            onOceanManagerReady(oceanManager)
          }}
        />
      ) : null}
    </>
  )
}

// Simple camera placement: position the perspective camera at the given target
// (no fly-to animation — that's a localhost:5173 nice-to-have, not load-bearing
// for the scaffold). Re-runs whenever target changes (location preset switch).
const CameraSetup: FC<{ target: Vector3 }> = ({ target }) => {
  const camera = useThree(({ camera }) => camera)
  const controls = useThree(({ controls }) => controls as any)

  useLayoutEffect(() => {
    const nextCamera = new THREE.PerspectiveCamera()
    new PointOfView(distance, radians(heading), radians(pitch)).decompose(
      target,
      nextCamera.position,
      nextCamera.quaternion,
      nextCamera.up
    )
    camera.position.copy(nextCamera.position)
    camera.quaternion.copy(nextCamera.quaternion)
    camera.up.copy(nextCamera.up)
    camera.updateProjectionMatrix()
    camera.updateMatrixWorld()
    if (controls?.target != null) {
      controls.target.copy(target)
      controls.update?.()
    }
  }, [camera, controls, target])

  return null
}

// SCENE_RADIANCE_SCALE — matches WaterproAtmosphere-Story.tsx:145. The
// WaterPro composition peaks ~2× higher than the legacy WGSL fragment, so
// 0.28 is the calibrated value for AgX exposure 10 (PORT-STATUS §13). Using
// 0.55 (legacy ocean-material.js value) over-brightens highlights into the
// AgX tonemap rolloff and reads as flat / washed-out.
const SCENE_RADIANCE_SCALE = 0.28

const Content: FC = () => {
  const renderer = useThree<Renderer>(({ gl }) => gl as any)
  const scene = useThree(({ scene }) => scene)
  const camera = useThree(({ camera }) => camera)
  const [oceanManager, setOceanManager] = useState<any>(null)
  const [oceanUniforms, setOceanUniforms] =
    useState<WaterproOceanUniforms | null>(null)
  const [vertexUniforms, setVertexUniforms] =
    useState<VertexUniformsBag | null>(null)
  const overlayScene = useMemo(() => new Scene(), [])
  const context = useMemo(() => new AtmosphereContextNode(), [])

  // PBR IBL via the atmosphere's sky environment cube. Load-bearing — without
  // it, MeshStandardNodeMaterial collapses to ~black at low sun angles (NdotL
  // → 0 zeroes the diffuse term, leaving only emissive). PORT-STATUS §11
  // documents this. Mirrors WaterproAtmosphere-Story.tsx:232-235.
  const envNode = useMemo(() => skyEnvironment(context), [context])
  useEffect(() => {
    scene.environmentNode = envNode as any
    return () => {
      scene.environmentNode = null
    }
  }, [scene, envNode])

  const locationControls = useControls('Location', {
    preset: {
      value: 'Tokyo',
      options: [...Object.keys(locationPresets), 'Custom'],
      label: 'Fly to',
    },
    longitude: {
      value: locationPresets.Tokyo.longitude,
      min: -180,
      max: 180,
      step: 0.0001,
    },
    latitude: {
      value: locationPresets.Tokyo.latitude,
      min: -90,
      max: 90,
      step: 0.0001,
    },
    height: {
      value: locationPresets.Tokyo.height,
      min: -500,
      max: 5000,
      step: 1,
    },
  })
  const activeLocation =
    locationControls.preset === 'Custom'
      ? locationControls
      : locationPresets[
          locationControls.preset as keyof typeof locationPresets
        ] ?? locationPresets.Tokyo
  const target = useTargetECEF(
    activeLocation.longitude,
    activeLocation.latitude,
    activeLocation.height
  )

  const atmosphereControls = useControls('Atmosphere', {
    exposure: { value: 10, min: 0, max: 30, step: 0.25 },
    dayOfYear: { value: 152, min: 0, max: 364, step: 1 },
    timeOfDay: { value: 12, min: 0, max: 24, step: 0.1, label: 'Local time' },
    year: { value: 2025, min: 2000, max: 2050, step: 1 },
    showGround: { value: true },
    showSun: { value: true },
    showMoon: { value: true },
    showStars: { value: true },
    moonIntensity: { value: 25, min: 0, max: 100, step: 1 },
    starsIntensity: { value: 20, min: 0, max: 100, step: 1 },
  })

  const oceanFrameControls = useControls('Ocean Frame', {
    seaLevelOffset: {
      value: 50,
      min: -500,
      max: 5000,
      step: 1,
      label: 'Sea level offset',
    },
    oceanScale: {
      value: 1,
      min: 0.1,
      max: 5,
      step: 0.05,
      label: 'Ocean scale',
    },
  })

  const oceanMaterialParams = useControls('Ocean Material', {
    wireframe: { value: false },
  })

  // Full WaterPro control set — mirrors WaterproAtmosphere-Story.tsx
  // Story.args / argTypes. Same defaults, same ranges, just leva-formatted.
  const presetOptions = useMemo<string[]>(
    () => ['custom', ...WATERPRO_PRESET_NAMES],
    []
  )
  const presetControls = useControls('Ocean Preset', {
    preset: { value: 'custom', options: presetOptions },
  })

  const toggleControls = useControls('Ocean Toggles', {
    skyReflection: { value: true },
    sss: { value: true, label: 'SSS' },
    sparkle: { value: true },
    surfaceFoam: { value: true },
    waveFoam: { value: true },
    turbulentFoam: { value: true },
    shorelineFoam: { value: true },
  })

  const waveControls = useControls('Waves', {
    fftAmplitude: { value: 1.0, min: 0, max: 2, step: 0.01 },
    gerstnerAmplitude: { value: 1.0, min: 0, max: 6, step: 0.01 },
  })

  const reflectionControls = useControls('Reflection', {
    skyReflectionColor: '#ffffff',
    skyReflectionExposure: { value: 0.2, min: 0.01, max: 2, step: 0.01 },
    skyReflectionScale: { value: 1.0, min: 0, max: 3, step: 0.05 },
  })

  const fresnelControls = useControls('Fresnel', {
    fresnelPower: { value: 3.0, min: 1, max: 8, step: 0.1 },
    normalStrength: { value: 0.1, min: 0, max: 1, step: 0.01 },
  })

  const sparkleControls = useControls('Sparkle', {
    sparkleIntensity: { value: 1.5, min: 0, max: 10, step: 0.1 },
    sparkleFocusPower: { value: 75.7, min: 1, max: 1000, step: 1 },
  })

  const sssControls = useControls('SSS', {
    sssIntensity: { value: 0.5, min: 0, max: 5, step: 0.05 },
    sssPower: { value: 16.0, min: 0.5, max: 64, step: 0.1 },
  })

  const surfaceFoamControls = useControls('Surface Foam', {
    surfaceFoamCoverage: { value: 0.02, min: 0, max: 1, step: 0.01 },
    surfaceFoamOpacity: { value: 0.25, min: 0, max: 1, step: 0.01 },
    surfaceFoamSize: { value: 20.0, min: 1, max: 250, step: 1 },
    regionEnabled: { value: true, label: 'Blob mask' },
    regionScale: {
      value: 1500.0,
      min: 200,
      max: 8000,
      step: 50,
      label: 'Blob scale (m)',
    },
    regionThreshold: {
      value: 0.5,
      min: 0,
      max: 1,
      step: 0.01,
      label: 'Blob coverage',
    },
    regionDrift: {
      value: 0.0005,
      min: 0,
      max: 0.01,
      step: 0.0001,
      label: 'Blob drift (tex/s)',
    },
  })

  const waveFoamControls = useControls('Wave Foam', {
    waveFoamCoverage: { value: 0.5, min: 0, max: 1, step: 0.01 },
    waveFoamOpacity: { value: 0.6, min: 0, max: 1, step: 0.01 },
    waveFoamCrestCoverage: { value: 0.3, min: 0, max: 1, step: 0.01 },
  })

  const swellControls = useControls('Swell Variance', {
    swellStrength: {
      value: 0.5,
      min: 0,
      max: 1,
      step: 0.01,
      label: 'Strength (0=uniform)',
    },
    swellScale: {
      value: 800,
      min: 50,
      max: 5000,
      step: 10,
      label: 'Variance scale (m)',
    },
  })

  const tipFoamControls = useControls('Tip Foam', {
    enabled: { value: true },
    intensity: { value: 1.0, min: 0, max: 5, step: 0.05 },
    heightThreshold: {
      value: 0.6,
      min: 0,
      max: 5,
      step: 0.05,
      label: 'Height threshold (m)',
    },
    softness: {
      value: 0.4,
      min: 0.05,
      max: 2,
      step: 0.05,
      label: 'Threshold softness (m)',
    },
    rarity: {
      value: 0.65,
      min: 0,
      max: 1,
      step: 0.01,
      label: 'Rarity (1=rare)',
    },
    size: { value: 8.0, min: 1, max: 100, step: 0.5, label: 'Tile size (m)' },
  })

  const shorelineFoamControls = useControls('Shoreline Foam', {
    shorelineBandRange: { value: 2.0, min: 0.1, max: 100, step: 0.1 },
    shorelineBandCoverage: { value: 0.5, min: 0, max: 1, step: 0.01 },
    shorelineBandOpacity: { value: 1.0, min: 0, max: 1, step: 0.01 },
    shorelineTintRange: { value: 30.0, min: 1, max: 200, step: 1 },
    shorelineTintCoverage: { value: 0.5, min: 0, max: 1, step: 0.01 },
    shorelineTintOpacity: { value: 0.3, min: 0, max: 1, step: 0.01 },
  })

  const turbulentFoamControls = useControls('Turbulent Foam', {
    turbulentIntensity: { value: 0.2, min: 0, max: 2, step: 0.05 },
  })

  const waterColorControls = useControls('Water Color', {
    depthFalloff: { value: 50.0, min: 1, max: 300, step: 1 },
    waterDepth: { value: 20.0, min: 1, max: 100, step: 1 },
    // sRGB hex equivalents of the linear (0,0.8,0.8) / (0,0.2,0.4) defaults
    shallowColor: '#00e7e7',
    deepColor: '#007baa',
  })
  const oceanDebugParams = useControls('Ocean Debug', {
    numLayers: {
      value: 3,
      min: 1,
      max: 15,
      step: 1,
      label: 'Quadtree LOD layers',
    },
    enableOcean: {
      value: true,
      label: 'Enable ocean',
    },
    useDiagnosticMaterial: {
      value: false,
      label: 'Diagnostic material (flat blue)',
    },
    skipDepthPrepass: {
      // Default ON for now — the pre-pass is corrupting renderer state in
      // storybook (cause TBD; legacy OceanChunks pre-pass works fine in
      // localhost:5173, so the issue is specific to this wiring). Skipping
      // it disables shoreline foam / water-column depth but keeps the rest
      // of the WaterPro composition working.
      value: true,
      label: 'Skip depth pre-pass',
    },
  })

  const terrainControls = useControls('Terrain', {
    source: {
      value: 'Auto',
      options: ['Auto', 'Global', 'Japan Regional'],
    },
  })
  const terrainAssetId =
    terrainControls.source === 'Japan Regional' ||
    (terrainControls.source === 'Auto' &&
      isInsideJapanRegionalTerrain(
        activeLocation.longitude,
        activeLocation.latitude
      ))
      ? japanRegionalTerrainAssetId
      : globalTerrainAssetId

  // Post-processing chain — mirrors GlobeOceanProto.tsx:504-547.
  // pass → colorNode.mul(0.55) → aerialPerspective → optional stars/sun/moon
  // routed via skyNode → lensFlare → AgX tonemap → dithering.
  const postProcessingData = useMemo(() => {
    context.camera = camera

    const passNode = pass(scene, camera, { samples: 0 })
    const colorNode = passNode.getTextureNode('output')
    const depthNode = passNode.getTextureNode('depth')

    const aerialNode = aerialPerspective(
      context,
      colorNode.mul(SCENE_RADIANCE_SCALE),
      depthNode
    )
    const skyNode = (aerialNode as any).skyNode
    if (skyNode != null) {
      skyNode.showSun = atmosphereControls.showSun
      skyNode.showMoon = atmosphereControls.showMoon
      if (skyNode.moonNode != null) {
        skyNode.moonNode.intensity.value = atmosphereControls.moonIntensity
      }
      if (atmosphereControls.showStars) {
        const starsNode = new StarsNode(
          context,
          new URL(
            '../../../packages/atmosphere/assets/stars.bin',
            import.meta.url
          ).href
        )
        starsNode.intensity.value = atmosphereControls.starsIntensity
        skyNode.starsNode = starsNode
      }
    }
    const lensFlareNode = lensFlare(aerialNode)
    const toneMappingNode = toneMapping(
      AgXToneMapping,
      uniform(atmosphereControls.exposure),
      lensFlareNode
    )
    const overlayPassNode = pass(overlayScene, camera, {
      samples: 0,
      depthBuffer: false,
    })

    const result = new PostProcessing(renderer)
    result.outputNode = toneMappingNode
      .add(dithering)
      .mul(overlayPassNode.a.oneMinus())
      .add(overlayPassNode)
    return { postProcessing: result, skyNode }
  }, [
    atmosphereControls.exposure,
    atmosphereControls.moonIntensity,
    atmosphereControls.showMoon,
    atmosphereControls.showStars,
    atmosphereControls.showSun,
    atmosphereControls.starsIntensity,
    camera,
    context,
    overlayScene,
    renderer,
    scene,
  ])

  const atmosphereDate = useMemo(() => {
    return getLocalDate(
      activeLocation.longitude,
      atmosphereControls.dayOfYear,
      atmosphereControls.timeOfDay,
      atmosphereControls.year
    )
  }, [
    activeLocation.longitude,
    atmosphereControls.dayOfYear,
    atmosphereControls.timeOfDay,
    atmosphereControls.year,
  ])

  // (lodScale slider removed — it's a WGSL-vertex-stage uniform local to
  // OceanChunksWaterpro, not in the shared WaterproOceanUniforms bag.)

  useEffect(() => {
    if (oceanManager?.material_ == null) return
    oceanManager.material_.wireframe = oceanMaterialParams.wireframe
  }, [oceanManager, oceanMaterialParams.wireframe])

  // Preset bag: map from preset field names to the uniforms the bag holds.
  // Identical structure to WaterproAtmosphere-Story.tsx:386-423.
  const presetBag = useMemo<WaterproPresetUniformBag | null>(() => {
    if (oceanUniforms == null) return null
    const u = oceanUniforms
    return {
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
    }
  }, [oceanUniforms])

  // Snapshot the factory defaults the first time presetBag is available, so
  // we can restore them when switching back to 'custom'. applyWaterproPreset
  // writes to MANY uniforms (transmissionColor, foam colours, foam sizes,
  // wave-foam weights, fade ranges, etc.) that have no slider — without this
  // snapshot, switching preset→custom would leave the last preset's values
  // wherever the sliders don't reach.
  const defaultsSnapshotRef = useRef<Record<string, any> | null>(null)
  useEffect(() => {
    if (presetBag == null || defaultsSnapshotRef.current != null) return
    const snap: Record<string, any> = {}
    for (const [key, uni] of Object.entries(presetBag)) {
      const v = (uni as any).value
      snap[key] = v && typeof v === 'object' && 'clone' in v ? v.clone() : v
    }
    defaultsSnapshotRef.current = snap
  }, [presetBag])

  // Preset selector — writes water-only fields. Atmosphere / postProcessing
  // / oceanFloor / ssr fields are intentionally skipped (handled elsewhere).
  useEffect(() => {
    if (presetBag == null) return
    const snap = defaultsSnapshotRef.current
    if (snap != null) {
      // Restore factory defaults to every preset-bag field first. This
      // guarantees switching preset → custom (or preset A → preset B) starts
      // from a known baseline; without it, fields only the leaving preset
      // wrote would persist into the next state.
      for (const [key, uni] of Object.entries(presetBag)) {
        const saved = snap[key]
        const target = (uni as any).value
        if (saved == null) continue
        if (target && typeof target === 'object' && 'copy' in target) {
          target.copy(saved)
        } else {
          ;(uni as any).value = saved
        }
      }
    }
    if (presetControls.preset === 'custom') return
    applyWaterproPreset(
      presetControls.preset as WaterproPresetName,
      presetBag
    )
  }, [presetBag, presetControls.preset])

  // Per-slider writes — same wiring as WaterproAtmosphere-Story.tsx:436-483
  // but expressed as useEffects over leva values instead of the storybook
  // useTransientControl pattern.
  useEffect(() => {
    if (oceanUniforms == null) return
    const u = oceanUniforms
    u.skyReflectionOn.value = toggleControls.skyReflection ? 1 : 0
    u.sssOn.value = toggleControls.sss ? 1 : 0
    u.sparkleOn.value = toggleControls.sparkle ? 1 : 0
    u.surfaceFoamOn.value = toggleControls.surfaceFoam ? 1 : 0
    u.waveFoamOn.value = toggleControls.waveFoam ? 1 : 0
    u.turbulentFoamOn.value = toggleControls.turbulentFoam ? 1 : 0
    u.shorelineFoamOn.value = toggleControls.shorelineFoam ? 1 : 0
  }, [oceanUniforms, toggleControls])

  useEffect(() => {
    if (oceanUniforms == null) return
    oceanUniforms.fftAmplitude.value = waveControls.fftAmplitude
    oceanUniforms.gerstnerAmplitude.value = waveControls.gerstnerAmplitude
  }, [oceanUniforms, waveControls])

  useEffect(() => {
    if (oceanUniforms == null) return
    // Color.setStyle does sRGB→linear already; DO NOT chain
    // convertSRGBToLinear (PORT-STATUS footgun).
    const c = new Color().setStyle(reflectionControls.skyReflectionColor)
    oceanUniforms.skyReflectionColor.value.set(c.r, c.g, c.b)
    oceanUniforms.skyReflectionExposure.value =
      reflectionControls.skyReflectionExposure
    oceanUniforms.skyReflectionScale.value =
      reflectionControls.skyReflectionScale
  }, [oceanUniforms, reflectionControls])

  useEffect(() => {
    if (oceanUniforms == null) return
    oceanUniforms.fresnelPower.value = fresnelControls.fresnelPower
    oceanUniforms.fresnelNormalStrength.value = fresnelControls.normalStrength
  }, [oceanUniforms, fresnelControls])

  useEffect(() => {
    if (oceanUniforms == null) return
    oceanUniforms.sparkleIntensity.value = sparkleControls.sparkleIntensity
    oceanUniforms.sparkleFocusPower.value = sparkleControls.sparkleFocusPower
  }, [oceanUniforms, sparkleControls])

  useEffect(() => {
    if (oceanUniforms == null) return
    oceanUniforms.sssIntensity.value = sssControls.sssIntensity
    oceanUniforms.sssPower.value = sssControls.sssPower
  }, [oceanUniforms, sssControls])

  useEffect(() => {
    if (oceanUniforms == null) return
    oceanUniforms.surfaceFoamCoverage.value =
      surfaceFoamControls.surfaceFoamCoverage
    oceanUniforms.surfaceFoamOpacity.value =
      surfaceFoamControls.surfaceFoamOpacity
    oceanUniforms.surfaceFoamSize.value = surfaceFoamControls.surfaceFoamSize
    oceanUniforms.surfaceFoamRegionEnabled.value =
      surfaceFoamControls.regionEnabled ? 1 : 0
    oceanUniforms.surfaceFoamRegionScale.value =
      surfaceFoamControls.regionScale
    oceanUniforms.surfaceFoamRegionThreshold.value =
      surfaceFoamControls.regionThreshold
    oceanUniforms.surfaceFoamRegionDrift.value =
      surfaceFoamControls.regionDrift
  }, [oceanUniforms, surfaceFoamControls])

  useEffect(() => {
    if (oceanUniforms == null) return
    oceanUniforms.waveFoamCoverage.value = waveFoamControls.waveFoamCoverage
    oceanUniforms.waveFoamOpacity.value = waveFoamControls.waveFoamOpacity
    oceanUniforms.waveFoamCrestCoverage.value =
      waveFoamControls.waveFoamCrestCoverage
  }, [oceanUniforms, waveFoamControls])

  useEffect(() => {
    if (vertexUniforms == null) return
    vertexUniforms.swellStrength.value = swellControls.swellStrength
    vertexUniforms.swellScale.value = swellControls.swellScale
  }, [vertexUniforms, swellControls])

  useEffect(() => {
    if (oceanUniforms?.tipFoamEnabled == null) return
    oceanUniforms.tipFoamEnabled.value = tipFoamControls.enabled ? 1 : 0
    oceanUniforms.tipFoamIntensity.value = tipFoamControls.intensity
    oceanUniforms.tipFoamHeightThreshold.value = tipFoamControls.heightThreshold
    oceanUniforms.tipFoamSoftness.value = tipFoamControls.softness
    oceanUniforms.tipFoamRarity.value = tipFoamControls.rarity
    oceanUniforms.tipFoamSize.value = tipFoamControls.size
  }, [oceanUniforms, tipFoamControls])

  useEffect(() => {
    if (oceanUniforms == null) return
    oceanUniforms.shorelineBandRange.value =
      shorelineFoamControls.shorelineBandRange
    oceanUniforms.shorelineBandCoverage.value =
      shorelineFoamControls.shorelineBandCoverage
    oceanUniforms.shorelineBandOpacity.value =
      shorelineFoamControls.shorelineBandOpacity
    oceanUniforms.shorelineTintRange.value =
      shorelineFoamControls.shorelineTintRange
    oceanUniforms.shorelineTintCoverage.value =
      shorelineFoamControls.shorelineTintCoverage
    oceanUniforms.shorelineTintOpacity.value =
      shorelineFoamControls.shorelineTintOpacity
  }, [oceanUniforms, shorelineFoamControls])

  useEffect(() => {
    if (oceanUniforms == null) return
    oceanUniforms.turbulentIntensity.value =
      turbulentFoamControls.turbulentIntensity
  }, [oceanUniforms, turbulentFoamControls])

  useEffect(() => {
    if (oceanUniforms == null) return
    oceanUniforms.depthFalloff.value = waterColorControls.depthFalloff
    oceanUniforms.waterDepth.value = waterColorControls.waterDepth
    const cs = new Color().setStyle(waterColorControls.shallowColor)
    oceanUniforms.shallowColor.value.set(cs.r, cs.g, cs.b)
    const cd = new Color().setStyle(waterColorControls.deepColor)
    oceanUniforms.deepColor.value.set(cd.r, cd.g, cd.b)
  }, [oceanUniforms, waterColorControls])

  useEffect(() => {
    context.showGround = atmosphereControls.showGround
    postProcessingData.postProcessing.needsUpdate = true
  }, [atmosphereControls.showGround, context, postProcessingData])

  useEffect(() => {
    return () => {
      context.dispose()
    }
  }, [context])

  // Per-frame: sun/moon direction from atmosphereDate, then post-processing.
  useFrame(() => {
    camera.updateMatrixWorld()
    const matrixECIToECEF = getECIToECEFRotationMatrix(
      atmosphereDate,
      context.matrixECIToECEF.value
    )
    getSunDirectionECI(
      atmosphereDate,
      context.sunDirectionECEF.value
    ).applyMatrix4(matrixECIToECEF)
    getMoonDirectionECI(
      atmosphereDate,
      context.moonDirectionECEF.value
    ).applyMatrix4(matrixECIToECEF)
  })

  useFrame(() => {
    postProcessingData.postProcessing.render()
  }, 1)

  const ionToken =
    import.meta.env.STORYBOOK_ION_API_TOKEN ??
    import.meta.env.VITE_CESIUM_ION_TOKEN

  return (
    <>
      <atmosphereLight args={[context]} />
      <OrbitControls
        makeDefault
        enableDamping
        minDistance={500}
        maxDistance={100000}
      />
      <CameraSetup target={target} />
      {/* Depth-foam probe — capsule at the fly-to target so the depth pre-pass
          has visible geometry for the ocean material to sample. Layer 0
          (default) so it's included in the depth pre-pass. */}
      <mesh position={target.toArray()}>
        <capsuleGeometry args={[80, 600, 8, 24]} />
        <meshBasicMaterial color='#ff6b3d' />
      </mesh>
      <TilesRenderer key={terrainAssetId}>
        <TilesPlugin
          plugin={CesiumIonAuthPlugin}
          args={{
            apiToken: ionToken,
            assetId: terrainAssetId,
            autoRefreshToken: true,
          }}
        />
        <TilesPlugin plugin={TileMaterialReplacementPlugin} />
      </TilesRenderer>
      {oceanDebugParams.enableOcean && (
        <OceanSurface
          target={target}
          atmosphereContext={context}
          envCubeTexture={(envNode as any).renderTarget.texture}
          seaLevelOffset={oceanFrameControls.seaLevelOffset}
          oceanScale={oceanFrameControls.oceanScale}
          numLayers={oceanDebugParams.numLayers}
          useDiagnosticMaterial={oceanDebugParams.useDiagnosticMaterial}
          skipDepthPrepass={oceanDebugParams.skipDepthPrepass}
          onUniformsReady={setOceanUniforms}
          onVertexUniformsReady={setVertexUniforms}
          onOceanManagerReady={setOceanManager}
        />
      )}
    </>
  )
}

interface StoryArgs {}

export const Story: StoryFC<{}, StoryArgs> = () => {
  return (
    <WebGPUCanvas
      camera={{ fov: 45, near: 1, far: 1e8 }}
      style={{ background: '#101820' }}
      renderer={{
        antialias: true,
        // Globe-scale terrain needs log depth to avoid z-fighting between
        // far terrain (~1e7 m) and near ocean chunks at cameraFar = 1e8.
        logarithmicDepthBuffer: true,
        onInit: r => {
          r.outputColorSpace = SRGBColorSpace
          r.toneMapping = THREE.NoToneMapping
          r.library.addLight(AtmosphereLightNode, AtmosphereLight)
        },
      }}
    >
      <Content />
    </WebGPUCanvas>
  )
}

Story.args = {}
Story.argTypes = {}
