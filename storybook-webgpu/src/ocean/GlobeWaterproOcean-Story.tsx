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
import { button, levaStore, useControls } from 'leva'
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
  MathUtils,
  Matrix4,
  Mesh,
  Quaternion,
  Raycaster,
  RepeatWrapping,
  Scene,
  SRGBColorSpace,
  TextureLoader,
  Vector2,
  Vector3,
  type Group,
  type Object3D,
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
  AtmosphereContext,
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
import { CloudLayer } from './CloudLayer'
import {
  CLOUD_PRESETS,
  CLOUD_PRESET_NAMES,
  type CloudPresetName,
} from './cloud-presets'
import { useAtmosphereContextNode } from '../hooks/useAtmosphereContextNode'
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
import { useGLTF } from '../hooks/useGLTF'

declare module '@react-three/fiber' {
  interface ThreeElements {
    atmosphereLight: ThreeElement<typeof AtmosphereLight>
  }
}

extend({ AtmosphereLight })

const heading = 180
const pitch = -20
const distance = 400
// 2275207 = Google Photorealistic 3D Tiles (color-baked photogrammetry).
// Asset 1 is Cesium World Terrain — elevation-only quantized mesh, no imagery,
// which is why TileMaterialReplacementPlugin's MeshBasicNodeMaterial rendered
// the terrain as flat white. Both require STORYBOOK_ION_API_TOKEN with the
// corresponding asset attached to the user's Ion account.
const globalTerrainAssetId = 2275207
const japanRegionalTerrainAssetId = 2767062

const locationPresets = {
  Tokyo: { longitude: 139.7671, latitude: 35.6812, height: 20 },
  Oslo: { longitude: 10.7522, latitude: 59.9139, height: 20 },
  'New York': { longitude: -74.006, latitude: 40.7128, height: 20 },
  'Cape Town': { longitude: 18.4241, latitude: -33.9249, height: 20 },
  Sydney: { longitude: 151.2093, latitude: -33.8688, height: 20 },
  Reykjavik: { longitude: -21.9426, latitude: 64.1466, height: 20 },
  // 59°24'57.1"N 5°13'36.8"E — North Sea, ~10 km offshore W of Karmøy
  // (Utsira Nord offshore-wind area, Norway).
  Karmøy: { longitude: 5.206866, latitude: 59.427348, height: 20 },
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
  atmosphereContext: AtmosphereContext
  envCubeTexture: THREE.CubeTexture
  onUniformsReady: (uniforms: WaterproOceanUniforms) => void
  onVertexUniformsReady: (vu: VertexUniformsBag) => void
  onOceanManagerReady: (oceanManager: any) => void
  seaLevelOffset: number
  oceanScale: number
  numLayers: number
  useDiagnosticMaterial: boolean
  skipDepthPrepass: boolean
  depthPrepassStage: number
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
  depthPrepassStage,
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
          depthPrepassStage={depthPrepassStage}
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

// Wind turbine probe at the fly-to target — replaces the capsule depth-foam
// probe. Orients the model so its local +Y (tower up) aligns with the ECEF
// surface normal at `target` (geocentric up — close enough to the geodetic
// normal for visual placement). Spins the GLB child named "Windwings" on
// local Y. Participates in the depth pre-pass via normal scene traversal,
// so shoreline foam still develops around the waterline.
const TurbineProbe: FC<{
  target: Vector3
  scale: number
  heightOffset: number
  yawDeg: number
  spin: boolean
  spinSpeed: number
}> = ({ target, scale, heightOffset, yawDeg, spin, spinSpeed }) => {
  const gltf = useGLTF('public/turbine-demo.glb')
  const groupRef = useRef<Group>(null)
  const wingsRef = useRef<Object3D | null>(null)

  useEffect(() => {
    wingsRef.current = gltf.scene.getObjectByName('Windwings') ?? null
  }, [gltf.scene])

  const { position, quaternion } = useMemo(() => {
    const up = target.clone().normalize()
    // Yaw is applied in local frame first (around local Y), then align rotates
    // local Y onto the ECEF surface normal. q1*q2 applies q2 first to a vector,
    // so yaw goes on the right.
    const yawQ = new Quaternion().setFromAxisAngle(
      new Vector3(0, 1, 0),
      MathUtils.degToRad(yawDeg)
    )
    const alignQ = new Quaternion().setFromUnitVectors(
      new Vector3(0, 1, 0),
      up
    )
    const q = alignQ.multiply(yawQ)
    const pos = target.clone().add(up.multiplyScalar(heightOffset))
    return { position: pos, quaternion: q }
  }, [target, heightOffset, yawDeg])

  useFrame((_, dt) => {
    if (spin && wingsRef.current) {
      // Blender's local +Y (rotor shaft) → glTF local -Z after the
      // Z-up→Y-up axis conversion the exporter applies.
      wingsRef.current.rotation.z += spinSpeed * dt
    }
  })

  return (
    <group
      ref={groupRef}
      position={position.toArray()}
      quaternion={quaternion.toArray() as [number, number, number, number]}
      scale={scale}
    >
      <primitive object={gltf.scene} />
    </group>
  )
}

// SCENE_RADIANCE_SCALE — matches WaterproAtmosphere-Story.tsx:145. The
// WaterPro composition peaks ~2× higher than the legacy WGSL fragment, so
// 0.28 is the calibrated value for AgX exposure 10 (PORT-STATUS §13). Using
// 0.55 (legacy ocean-material.js value) over-brightens highlights into the
// AgX tonemap rolloff and reads as flat / washed-out.
const SCENE_RADIANCE_SCALE = 0.28

// Optional probe hook for standalone-deploy readiness gating (no-op in
// Storybook). Fires once the atmosphere context + ocean manager refs are
// available so a host page can poll their compute/build state and decide
// when to reveal the scene. See examples/ocean-globe-waterpro-demo/main.tsx.
export interface ContentReadinessRefs {
  atmosphereContext: AtmosphereContext
  getOceanManager: () => any | null
}

export const Content: FC<{
  onReadinessRefs?: (refs: ContentReadinessRefs) => void
  // When true, the ocean surface is NOT mounted — atmosphere + terrain only.
  // Used by the standalone deploy's phased load: stage 1 lets the atmosphere
  // LUT compute pipeline finish without competing for GPU/CPU with ocean
  // chunk-builder workers and wave-simulation compute. Stage 2 flips this to
  // false to bring the ocean in. Defaults to false so Storybook mounts the
  // full scene as it always has.
  disableOcean?: boolean
}> = ({ onReadinessRefs, disableOcean = false }) => {
  const renderer = useThree<Renderer>(({ gl }) => gl as any)
  const scene = useThree(({ scene }) => scene)
  const camera = useThree(({ camera }) => camera)
  const [oceanManager, setOceanManager] = useState<any>(null)
  const [oceanUniforms, setOceanUniforms] =
    useState<WaterproOceanUniforms | null>(null)
  const [vertexUniforms, setVertexUniforms] =
    useState<VertexUniformsBag | null>(null)
  const overlayScene = useMemo(() => new Scene(), [])
  const context = useMemo(() => new AtmosphereContext(), [])
  context.camera = camera
  useAtmosphereContextNode(context)

  // Surface the context + a live getter for the ocean manager once, so a
  // host page (standalone deploy) can poll readiness without re-reading
  // through React state.
  const oceanManagerRef = useRef<any>(null)
  oceanManagerRef.current = oceanManager
  const readinessReportedRef = useRef(false)
  useEffect(() => {
    if (readinessReportedRef.current || onReadinessRefs == null) return
    readinessReportedRef.current = true
    onReadinessRefs({
      atmosphereContext: context,
      getOceanManager: () => oceanManagerRef.current
    })
  }, [context, onReadinessRefs])

  // PBR IBL via the atmosphere's sky environment cube. Load-bearing — without
  // it, MeshStandardNodeMaterial collapses to ~black at low sun angles (NdotL
  // → 0 zeroes the diffuse term, leaving only emissive). PORT-STATUS §11
  // documents this. Mirrors WaterproAtmosphere-Story.tsx:232-235.
  const envNode = useMemo(() => skyEnvironment(), [])
  useEffect(() => {
    scene.environmentNode = envNode as any
    return () => {
      scene.environmentNode = null
    }
  }, [scene, envNode])

  // Function-form `useControls` returns [values, set]; we use `setLocation` from
  // the picker handler to programmatically reposition the fly-to target.
  const [locationControls, setLocation] = useControls('Location', () => ({
    preset: {
      value: 'Karmøy',
      options: [...Object.keys(locationPresets), 'Custom'],
      label: 'Fly to',
    },
    longitude: {
      value: locationPresets.Karmøy.longitude,
      min: -180,
      max: 180,
      step: 0.0001,
    },
    latitude: {
      value: locationPresets.Karmøy.latitude,
      min: -90,
      max: 90,
      step: 0.0001,
    },
    height: {
      value: locationPresets.Karmøy.height,
      min: -500,
      max: 5000,
      step: 1,
    },
  }))
  const activeLocation =
    locationControls.preset === 'Custom'
      ? locationControls
      : locationPresets[
          locationControls.preset as keyof typeof locationPresets
        ] ?? locationPresets.Karmøy
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

  // Function-form useControls so a preset selection can push values back into
  // the sliders via `setCloudControls`. Slider defaults match the 'fair' preset.
  const [cloudControls, setCloudControls] = useControls('Clouds', () => ({
    enabled: { value: true },
    source: { value: 'procedural', options: ['procedural', 'live'] },
    preset: { value: 'fair' as CloudPresetName, options: CLOUD_PRESET_NAMES },
    altitude: { value: 4000, min: 500, max: 12000, step: 100 },
    opacity: { value: 0.85, min: 0, max: 1, step: 0.01 },
    coverage: { value: 0.5, min: 0, max: 1, step: 0.01 },
    windSpeed: { value: 0.004, min: 0, max: 0.05, step: 0.001 },
    tiles: { value: 69, min: 1, max: 100, step: 1 },
    dayColor: '#ffffff',
    nightAmbient: { value: 0.03, min: 0, max: 0.5, step: 0.01 },
    density: { value: 0.1, min: 0, max: 1, step: 0.01 },
    intensity: { value: 2.5, min: 0, max: 6, step: 0.1 },
    contrast: { value: 1, min: 0.5, max: 5, step: 0.1 },
  }))

  // Apply a preset's field bag to the sliders when the selector changes.
  // (Manual slider edits afterward just override live; the selector label
  // stays on the last-chosen preset — a scaffold simplification.)
  const prevCloudPresetRef = useRef<CloudPresetName>(cloudControls.preset)
  useEffect(() => {
    if (cloudControls.preset === prevCloudPresetRef.current) return
    prevCloudPresetRef.current = cloudControls.preset
    // CloudPresetFields keys all match the Clouds leva control keys.
    setCloudControls({ ...CLOUD_PRESETS[cloudControls.preset] })
  }, [cloudControls.preset, setCloudControls])

  const oceanFrameControls = useControls('Ocean Frame', {
    seaLevelOffset: {
      value: 29,
      min: -500,
      max: 5000,
      step: 1,
      label: 'Sea level offset',
    },
    oceanScale: {
      value: 0.5,
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

  const turbineControls = useControls('Turbine', {
    scale: { value: 0.5, min: 0.1, max: 50, step: 0.1 },
    heightOffset: { value: 2.5, min: -200, max: 200, step: 0.5 },
    yawDeg: { value: 180, min: -180, max: 180, step: 1, label: 'Yaw (°)' },
    spin: { value: true },
    spinSpeed: { value: 2.0, min: 0, max: 20, step: 0.1 },
  })

  const cameraControls = useControls('Camera', {
    minDistance: { value: 50, min: 1, max: 5000, step: 1 },
    maxDistance: { value: 100000, min: 1000, max: 50_000_000, step: 100_000 },
    autoOrbit: { value: false },
    orbitSpeed: { value: 0.3, min: -5, max: 5, step: 0.05 },
  })

  // Snapshot button — dumps every leva value (across all panels) as JSON to
  // the console + clipboard. Use it to capture your current scene tweaks and
  // paste them back into the source-code defaults.
  useControls('Snapshot', {
    copyDefaults: button(() => {
      const data = levaStore.getData()
      const out: Record<string, Record<string, unknown>> = {}
      for (const [path, entry] of Object.entries(data)) {
        if (
          entry == null ||
          typeof entry !== 'object' ||
          !('value' in (entry as any))
        ) {
          continue
        }
        const parts = path.split('.')
        const key = parts.pop() as string
        const folder = parts.length > 0 ? parts.join('.') : '_root'
        ;(out[folder] ??= {})[key] = (entry as any).value
      }
      const json = JSON.stringify(out, null, 2)
      console.log('[snapshot]\n' + json)
      void navigator.clipboard?.writeText(json).catch(() => {})
    }),
  })

  const pickControls = useControls('Pick', {
    enabled: { value: false, label: 'Click → reposition fly-to' },
    keepHeight: {
      value: true,
      label: 'Keep current height',
    },
  })

  // Raycast-pick on click. When enabled, a stationary mouse click on any
  // visible scene geometry (terrain tiles, ocean, turbine) repositions the
  // fly-to target (longitude/latitude, optionally height) to the clicked
  // point and switches the location preset to 'Custom'. Browser fires `click`
  // only for un-dragged press-release pairs, so OrbitControls drags don't
  // trigger it.
  useEffect(() => {
    if (!pickControls.enabled) return
    const dom = (renderer as any)?.domElement as HTMLCanvasElement | undefined
    if (dom == null) return
    const raycaster = new Raycaster()
    const ndc = new Vector2()
    const geodetic = new Geodetic()
    const handler = (e: MouseEvent): void => {
      const rect = dom.getBoundingClientRect()
      ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
      ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
      raycaster.setFromCamera(ndc, camera)
      const hits = raycaster.intersectObject(scene, true)
      if (hits.length === 0) {
        console.log('[pick] no hit')
        return
      }
      try {
        geodetic.setFromECEF(hits[0].point)
      } catch (err) {
        console.log('[pick] outside ellipsoid', err)
        return
      }
      const lonDeg = MathUtils.radToDeg(geodetic.longitude)
      const latDeg = MathUtils.radToDeg(geodetic.latitude)
      const objName = hits[0].object.name || hits[0].object.type
      console.log(
        `[pick] lon=${lonDeg.toFixed(6)}° lat=${latDeg.toFixed(6)}° height=${geodetic.height.toFixed(2)} m (hit=${objName})`
      )
      const next: Record<string, number | string> = {
        preset: 'Custom',
        longitude: lonDeg,
        latitude: latDeg,
      }
      if (!pickControls.keepHeight) {
        next.height = geodetic.height
      }
      setLocation(next)
    }
    dom.addEventListener('click', handler)
    return () => dom.removeEventListener('click', handler)
  }, [
    pickControls.enabled,
    pickControls.keepHeight,
    renderer,
    camera,
    scene,
    setLocation,
  ])

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
      // Default OFF — the pre-pass works as of the envNode-strip fix.
      // Flip on as a fallback if a future regression breaks it.
      value: false,
      label: 'Skip depth pre-pass',
    },
    depthPrepassStage: {
      value: 4,
      min: 1,
      max: 4,
      step: 1,
      label: 'Pre-pass stage (1-4)',
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
      <atmosphereLight />
      {cloudControls.enabled && (
        <CloudLayer
          altitude={cloudControls.altitude}
          opacity={cloudControls.opacity}
          coverage={cloudControls.coverage}
          windSpeed={cloudControls.windSpeed}
          tiles={cloudControls.tiles}
          sunDirection={context.sunDirectionECEF as any}
          dayColor={cloudControls.dayColor}
          nightAmbient={cloudControls.nightAmbient}
          density={cloudControls.density}
          intensity={cloudControls.intensity}
          contrast={cloudControls.contrast}
          source={cloudControls.source as 'procedural' | 'live'}
        />
      )}
      <OrbitControls
        makeDefault
        enableDamping
        minDistance={cameraControls.minDistance}
        maxDistance={cameraControls.maxDistance}
        autoRotate={cameraControls.autoOrbit}
        autoRotateSpeed={cameraControls.orbitSpeed}
      />
      <CameraSetup target={target} />
      {/* Wind turbine probe at the fly-to target — replaces the prior capsule
          depth-foam probe. Layer 0 (default) so it participates in the depth
          pre-pass for shoreline-foam gating. */}
      <TurbineProbe
        target={target}
        scale={turbineControls.scale}
        heightOffset={turbineControls.heightOffset}
        yawDeg={turbineControls.yawDeg}
        spin={turbineControls.spin}
        spinSpeed={turbineControls.spinSpeed}
      />
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
      {oceanDebugParams.enableOcean && !disableOcean && (
        <OceanSurface
          target={target}
          atmosphereContext={context}
          envCubeTexture={(envNode as any).renderTarget.texture}
          seaLevelOffset={oceanFrameControls.seaLevelOffset}
          oceanScale={oceanFrameControls.oceanScale}
          numLayers={oceanDebugParams.numLayers}
          useDiagnosticMaterial={oceanDebugParams.useDiagnosticMaterial}
          skipDepthPrepass={oceanDebugParams.skipDepthPrepass}
          depthPrepassStage={oceanDebugParams.depthPrepassStage}
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
