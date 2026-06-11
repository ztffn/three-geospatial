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
import {
  TilesPlugin,
  TilesRenderer,
  TilesRendererContext
} from '3d-tiles-renderer/r3f'
import { button, levaStore, useControls } from 'leva'
import {
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FC,
} from 'react'
import {
  AgXToneMapping,
  ArrowHelper,
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
import { createCloudField, type CloudField } from './cloud-coverage'
import { useAtmosphereContextNode } from '../hooks/useAtmosphereContextNode'
import type { WaterproOceanUniforms } from './buildWaterproOceanMaterial'
import type { Node, UniformNode } from 'three/webgpu'


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
// Minimum fly-to landing distance for turbine-FREE sites (focus null, e.g. Oslo
// / Bergen). Their target sits at sea level (ellipsoid height 20), which is
// underground for an onshore city — a close zoom would bury the camera in the
// terrain (black). With no turbine to inspect, land at a city overview instead.
const overviewDistance = 1500
// 2275207 = Google Photorealistic 3D Tiles (color-baked photogrammetry).
// Asset 1 is Cesium World Terrain — elevation-only quantized mesh, no imagery,
// which is why TileMaterialReplacementPlugin's MeshBasicNodeMaterial rendered
// the terrain as flat white. Both require STORYBOOK_ION_API_TOKEN with the
// corresponding asset attached to the user's Ion account.
const globalTerrainAssetId = 2275207
const japanRegionalTerrainAssetId = 2767062

export const locationPresets = {
  Tokyo: { longitude: 139.7671, latitude: 35.6812, height: 20 },
  Oslo: { longitude: 10.7522, latitude: 59.9139, height: 20 },
  Bergen: { longitude: 5.3221, latitude: 60.3913, height: 20 },
  'New York': { longitude: -74.006, latitude: 40.7128, height: 20 },
  'Cape Town': { longitude: 18.4241, latitude: -33.9249, height: 20 },
  Sydney: { longitude: 151.2093, latitude: -33.8688, height: 20 },
  Reykjavik: { longitude: -21.9426, latitude: 64.1466, height: 20 },
  // 59°24'57.1"N 5°13'36.8"E — North Sea, ~10 km offshore W of Karmøy
  // (Utsira Nord offshore-wind area, Norway).
  Karmøy: { longitude: 5.206866, latitude: 59.427348, height: 20 },
  // Real offshore wind farms (fly-to POIs).
  'Hywind Tampen': { longitude: 2.7, latitude: 61.329972, height: 20 }, // floating, North Sea NW of Bergen
  // Hywind Demo / Unitech Zefyros — ~10 km SW of Karmøy. Approx: the marinelink
  // listing's own coords (63.0,7.0) contradict its "west of Karmøy" text.
  Zefyros: { longitude: 5.04, latitude: 59.16, height: 20 },
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
  cloudReflect?: (reflectDir: Node, originWorld: Node) => {
    color: Node
    blend: Node
  }
  cloudShadow?: (originWorld: Node) => Node
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
  cloudReflect,
  cloudShadow,
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
          cloudReflect={cloudReflect}
          cloudShadow={cloudShadow}
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
// Great-circle interpolation between two ECEF points: slerp the direction from
// the Earth's centre and lerp the radius, so a fly-to between far-apart POIs
// arcs over the globe instead of cutting a chord through it.
function geoSlerp(a: Vector3, b: Vector3, t: number, out: Vector3): Vector3 {
  const da = a.clone().normalize()
  const db = b.clone().normalize()
  let dot = MathUtils.clamp(da.dot(db), -1, 1)
  const omega = Math.acos(dot)
  const mag = MathUtils.lerp(a.length(), b.length(), t)
  if (omega < 1e-4) {
    out.copy(da).lerp(db, t)
  } else {
    const s = Math.sin(omega)
    const wa = Math.sin((1 - t) * omega) / s
    const wb = Math.sin(t * omega) / s
    out.copy(da).multiplyScalar(wa).addScaledVector(db, wb)
  }
  return out.normalize().multiplyScalar(mag)
}

const easeInOut = (t: number): number =>
  t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2

// Camera rig over the default OrbitControls. `focus` (hero engine) is the
// look-at anchor. Changing `target` (POI / location) triggers a smooth fly-to:
// the anchor slerps along the great circle while distance arcs out (more for
// farther jumps) and settles at `zoomDistance`. Between flights, a change to
// `zoomDistance` (the slider) eases the dolly distance to it — without fighting
// mouse-wheel zoom, which owns distance until the next slider change.
const CameraRig: FC<{
  target: Vector3
  focus?: Vector3 | null
  zoomDistance?: number
  // Reports the camera's live distance to the orbit target when at rest
  // (including after a mouse-wheel zoom), so a host slider can track it.
  // Suppressed mid-fly and mid-slider-ease to avoid fighting those commands.
  onDistance?: (distance: number) => void
}> = ({ target, focus, zoomDistance, onDistance }) => {
  const camera = useThree(({ camera }) => camera)
  const controls = useThree(({ controls }) => controls as any)

  const fly = useRef<{
    t: number
    dur: number
    fromAim: Vector3
    toAim: Vector3
    fromDist: number
    toDist: number
    bump: number
  } | null>(null)
  const appliedZoom = useRef<number | null>(null)
  const lastTarget = useRef<Vector3 | null>(null)
  const tmpAim = useRef(new Vector3())
  const lastEmitted = useRef(-1)

  // Initial placement and the fly's start anchor use the LOCATION (target). The
  // fly DESTINATION, however, is the hero engine (`focus`, the nacelle/axle) —
  // see the fly loop. `focus` lags a location change by ~1 frame (it's recomputed
  // from the new farm), but the slerp at t≈0 is dominated by the start anchor, so
  // reading it live there self-corrects without a visible mis-aim.
  const aimFor = useCallback(() => target.clone(), [target])

  const place = useCallback(
    (aim: Vector3, dist: number) => {
      const cam = new THREE.PerspectiveCamera()
      new PointOfView(dist, radians(heading), radians(pitch)).decompose(
        aim,
        cam.position,
        cam.quaternion,
        cam.up
      )
      camera.position.copy(cam.position)
      camera.quaternion.copy(cam.quaternion)
      camera.up.copy(cam.up)
      camera.updateProjectionMatrix()
      camera.updateMatrixWorld()
      if (controls?.target != null) {
        controls.target.copy(aim)
        controls.update?.()
      }
    },
    [camera, controls]
  )

  // Initial placement; afterwards, a target change starts a fly-to. Depends on
  // `controls` too: OrbitControls (makeDefault) often isn't registered on first
  // mount, and the initial placement must set controls.target — otherwise the
  // orbit centre stays at the earth's centre and the camera stares into the
  // planet (black) until something re-runs this. So wait for controls, then place.
  useLayoutEffect(() => {
    if (controls?.target == null) return
    const aim = aimFor()
    const dist = zoomDistance ?? distance
    if (lastTarget.current == null) {
      place(aim, dist)
      appliedZoom.current = dist
    } else if (!lastTarget.current.equals(target)) {
      const fromAim = controls?.target?.clone() ?? lastTarget.current.clone()
      const fromDist =
        controls?.target != null
          ? camera.position.distanceTo(controls.target)
          : dist
      // Angular separation drives how far the camera pulls out mid-arc.
      const sep = Math.acos(
        MathUtils.clamp(
          fromAim.clone().normalize().dot(aim.clone().normalize()),
          -1,
          1
        )
      )
      fly.current = {
        t: 0,
        dur: 1.6 + (sep / Math.PI) * 1.8,
        fromAim,
        toAim: aim,
        fromDist,
        toDist: dist,
        bump: (sep / Math.PI) * 1.2e7 // up to ~globe scale for antipodal jumps
      }
      appliedZoom.current = dist
    }
    lastTarget.current = target.clone()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, controls])

  useFrame((_, dt) => {
    if (controls?.target == null) return

    if (fly.current != null) {
      const f = fly.current
      f.t = Math.min(1, f.t + dt / f.dur)
      const e = easeInOut(f.t)
      // Destination is the hero engine (`focus`, the nacelle/axle), not the sea-
      // level location. Framing on the focus means a close zoom lands the right
      // distance from the nacelle — not stranded ~80 m below it at the surface,
      // which (nearly radially under the hub) drives OrbitControls into a
      // degenerate pole and shows the planet interior. Read live so the ~1-frame
      // `focus` lag self-corrects; fall back to the surface target if the site
      // has no turbines (focus null).
      const destAim = focus ?? f.toAim
      const aim = geoSlerp(f.fromAim, destAim, e, tmpAim.current)
      // Turbine-free sites (focus null) land at a city overview, never the close
      // zoom — their target is underground onshore (see overviewDistance).
      const landDist =
        focus != null ? f.toDist : Math.max(f.toDist, overviewDistance)
      const dist =
        MathUtils.lerp(f.fromDist, landDist, e) + f.bump * Math.sin(Math.PI * e)
      // place() copies `aim` into controls.target, so at t=1 the orbit centre is
      // the focus — no separate post-landing recentre needed.
      place(aim, dist)
      if (f.t >= 1) {
        controls.update?.()
        fly.current = null
      }
      return
    }

    // Slider zoom: ease distance toward zoomDistance only when it changed, so
    // mouse-wheel zoom is left alone between slider moves.
    if (zoomDistance != null && zoomDistance !== appliedZoom.current) {
      const dir = camera.position.clone().sub(controls.target)
      const cur = dir.length()
      if (cur > 1e-6) {
        const next = MathUtils.damp(cur, zoomDistance, 6, dt)
        camera.position
          .copy(controls.target)
          .addScaledVector(dir.normalize(), next)
        controls.update?.()
        if (Math.abs(next - zoomDistance) < zoomDistance * 0.01) {
          appliedZoom.current = zoomDistance
        }
      }
      return
    }

    // At rest (includes mouse-wheel zoom): report the live distance so a host
    // slider can track it. Throttled to meaningful change to avoid per-frame
    // host re-renders. Not reached mid-fly or mid-slider-ease (both return
    // above), so this never fights an in-flight command.
    if (onDistance != null) {
      const live = camera.position.distanceTo(controls.target)
      if (Math.abs(live - lastEmitted.current) > Math.max(0.5, live * 0.004)) {
        lastEmitted.current = live
        onDistance(live)
      }
    }
  })

  // Hero engine resolves after load → recentre orbit without re-placing camera.
  useLayoutEffect(() => {
    if (fly.current == null && controls?.target != null && focus != null) {
      controls.target.copy(focus)
      controls.update?.()
    }
  }, [controls, focus])

  return null
}

// Keeps the camera from dropping below the 3D terrain tiles. Rendered as a
// child of <TilesRenderer> so it can read the tile group from context and
// raycast it. Only LAND (terrain standing above sea level) acts as a floor —
// over open ocean the tile sits at sea level, so the camera is free to descend
// into the water. The IFFT ocean is a separate object and never raycast here.
const _clampRay = new THREE.Raycaster()
const TerrainClamp: FC<{ seaLevelRadius: number }> = ({ seaLevelRadius }) => {
  const camera = useThree(({ camera }) => camera)
  const controls = useThree(({ controls }) => controls as any)
  const tiles = useContext(TilesRendererContext) as { group?: THREE.Group } | null
  const frameRef = useRef(0)
  const up = useRef(new Vector3())

  useFrame(() => {
    const group = tiles?.group
    if (group == null || controls?.target == null) return
    // Throttle: terrain raycasts are not free; every other frame is plenty.
    frameRef.current = (frameRef.current + 1) % 2
    if (frameRef.current !== 0) return

    const cam = camera.position
    up.current.copy(cam).normalize() // ECEF up at the camera
    const probe = 12000
    _clampRay.firstHitOnly = true
    _clampRay.set(
      cam.clone().addScaledVector(up.current, probe),
      up.current.clone().negate()
    )
    _clampRay.far = probe * 3
    const hit = _clampRay.intersectObject(group, true)[0]
    if (hit == null) return

    const terrainR = hit.point.length()
    // Don't clamp at/under sea level — that's water, which is passable.
    if (terrainR <= seaLevelRadius + 5) return
    const floor = terrainR + 2
    if (cam.length() < floor) {
      cam.setLength(floor)
      controls.update?.()
    }
  })

  return null
}

// Index of the grid slot nearest the centre, in a roughly square (optionally
// staggered) layout of `count` cells. That slot is pinned to the fly-to target
// and gets the hero turbine, so zooming straight in lands on a turbine.
function centreSlotIndex(count: number, stagger: boolean): number {
  const cols = Math.ceil(Math.sqrt(count))
  const rows = Math.ceil(count / cols)
  let idx = 0
  let best = Infinity
  for (let i = 0; i < count; i++) {
    const r = Math.floor(i / cols)
    const c = i % cols
    const ex = c + (stagger ? (r % 2) * 0.5 : 0) - (cols - 1) / 2
    const nz = r - (rows - 1) / 2
    const d = ex * ex + nz * nz
    if (d < best) {
      best = d
      idx = i
    }
  }
  return idx
}

// Reference rotor diameter (V164-class 8 MW offshore turbine, matching the
// deploy's turbineModel.ts). Wake-aware array spacing is expressed in multiples
// of this so the layout reads as physically plausible offshore engineering.
const ROTOR_DIAMETER_M = 164

// Local east/north/up basis at an ECEF point (fresh allocation per call).
function enuBasis(point: Vector3): {
  east: Vector3
  north: Vector3
  up: Vector3
} {
  const east = new Vector3()
  const north = new Vector3()
  const up = new Vector3()
  Ellipsoid.WGS84.getEastNorthUpVectors(point, east, north, up)
  return { east, north, up }
}

// Horizontal unit vector for a compass bearing (0 = North, 90 = East) in the
// given ENU basis. east/north are orthonormal, so the result is unit-length.
function bearingVector(deg: number, east: Vector3, north: Vector3): Vector3 {
  const rad = MathUtils.degToRad(deg)
  return north
    .clone()
    .multiplyScalar(Math.cos(rad))
    .addScaledVector(east, Math.sin(rad))
}

// Wind-turbine farm at the fly-to target — a staggered grid of `count` clones.
// The centre slot uses the detailed "hero" GLB (turbine-demo3, with its base,
// rig, axle and toggleable wall/cover); the rest use the lightweight
// turbine-demo. Cloning with clone(true)
// SHARES geometry + materials by reference, so the light turbines cost ~N× draw
// calls but 1× GPU memory (cheap at farm sizes ~15; switch to InstancedMesh only
// if scaling to hundreds). Each clone is laid out on the local East-North tangent
// plane at `target`, oriented so local +Y (tower up) aligns with the surface
// normal, and spins its "Windwings" rotor on local Y. Participates in the depth
// pre-pass via normal traversal, so shoreline foam still develops at each base.
const TurbineFarm: FC<{
  target: Vector3
  scale: number
  heightOffset: number
  // FIXED layout bearing (deg, from North, clockwise) the array's wake-aware
  // spacing axes orient to. Real farms are built in place — this must NOT track
  // live wind, or the turbines (and the camera focus pinned to one) would drift.
  layoutHeadingDeg: number
  // LIVE wind bearing the turbine models yaw to face (stand-in for a separate
  // nacelle node until the model has one). Deploy feeds live MET wind.
  yawHeadingDeg: number
  // Per-model rotor-facing calibration added to yawHeadingDeg — the GLB's rotor
  // axis isn't guaranteed to sit at bearing 0. 0 vs 180 flips upwind/downwind.
  yawOffsetDeg: number
  spin: boolean
  spinSpeed: number
  count: number
  // Wake-aware anisotropic spacing (metres on the tangent plane): turbines sit
  // farther apart along the wind (downwind wake recovery) than across it.
  crosswindSpacing: number
  downwindSpacing: number
  stagger: boolean // offset alternate downwind rows by half the crosswind pitch
  // When provided (deploy's wind model), every rotor turns at this rate instead
  // of the leva spinSpeed — converting rpm to rad/s. 0 rpm = parked/cut-out, so
  // the blades visibly stop. null falls back to spinSpeed (Storybook default).
  rotorRpm?: number | null
  // Master rotor on/off (deploy). false ramps the spin smoothly to a halt and
  // back, rather than cutting it. Undefined = on (Storybook).
  wingsEnabled?: boolean
  // Reports the hero turbine's engine (axle origin) world position so the camera
  // can orbit/zoom to the nacelle rather than the base at sea level. null when
  // the site has no turbines (e.g. Oslo) — so the camera clears any stale focus.
  onHeroFocus?: (pos: Vector3 | null) => void
  // Hero-only "cover" visibility toggle (only the hero GLB carries this node).
  // Undefined = visible (the model's natural state). The "base-wall" node is
  // always hidden on the hero (no control) so the engine reads clean.
  heroCover?: boolean
}> = ({
  target,
  scale,
  heightOffset,
  layoutHeadingDeg,
  yawHeadingDeg,
  yawOffsetDeg,
  spin,
  spinSpeed,
  count,
  crosswindSpacing,
  downwindSpacing,
  stagger,
  rotorRpm,
  wingsEnabled,
  onHeroFocus,
  heroCover
}) => {
  const gltfFarm = useGLTF('public/turbine-demo_compressed.glb')
  const gltfHero = useGLTF('public/turbine-demo3_compressed.glb')
  const angleRef = useRef(0)
  const spinGainRef = useRef(1) // 0..1, lerps so on/off ramps in/out

  // One cloned scene per farm slot; clones share geometry/materials. The grid's
  // centre-most slot gets the detailed hero model, the rest the light one. Each
  // clone's "Windwings" rotor is cached for per-frame spin; the hero also caches
  // its "Axle" (spun with the wings) plus the toggleable "base-wall" / "cover"
  // nodes. Rebuilt only when a model, the count, or the stagger changes.
  const instances = useMemo(() => {
    const heroIndex = centreSlotIndex(count, stagger)
    return Array.from({ length: count }, (_, i) => {
      const isHero = i === heroIndex
      const scene = (isHero ? gltfHero.scene : gltfFarm.scene).clone(true)
      if (isHero) {
        // base-wall is always hidden (no control) so the engine reads clean.
        const wall = scene.getObjectByName('base-wall')
        if (wall != null) wall.visible = false
      }
      return {
        scene,
        wings: scene.getObjectByName('Windwings') ?? null,
        axle: isHero ? (scene.getObjectByName('Axle') ?? null) : null,
        cover: isHero ? (scene.getObjectByName('cover') ?? null) : null,
        hero: isHero
      }
    })
  }, [gltfFarm.scene, gltfHero.scene, count, stagger])

  // Apply the hero "cover" toggle. Undefined leaves it visible (the model's
  // natural state); a deploy/leva `false` hides it. Re-runs on toggle and on
  // rebuild (the clones are fresh, so visibility must be reset).
  useEffect(() => {
    for (const inst of instances) {
      if (inst.cover != null) inst.cover.visible = heroCover !== false
    }
  }, [instances, heroCover])

  // FIXED lattice — the array layout does NOT rotate with the wind (real farms
  // are built in place; rotating it also dragged the camera, which is pinned to
  // the hero). Positions derive from the stable layout bearing; only the turbine
  // models yaw to live wind (see `modelQuaternion`). Anisotropic, optionally
  // staggered grid centred on the target. Returns the hero base + surface up so
  // a stable, yaw-independent camera focus can be derived.
  const layout = useMemo(() => {
    const { east, north, up } = enuBasis(target)

    // Array axes locked to the FIXED layout bearing: along-wind line carries the
    // wide downwind spacing, the crosswind axis the tighter pitch. (Sign is
    // irrelevant — they're spacing directions.)
    const alongWind = bearingVector(layoutHeadingDeg, east, north)
    const crossWind = bearingVector(layoutHeadingDeg + 90, east, north)

    const cols = Math.ceil(Math.sqrt(count)) // crosswind columns
    const rows = Math.ceil(count / cols) // downwind rows
    const positions: Array<[number, number, number]> = []
    for (let i = 0; i < count; i++) {
      const r = Math.floor(i / cols) // downwind row index
      const c = i % cols // crosswind column index
      // Regular staggered lattice; alternate downwind rows offset half a
      // crosswind cell to keep turbines out of the row-ahead's direct wake. The
      // hero is NOT pinned to centre; the camera lands on it via `heroFocus`.
      const cross =
        (c + (stagger ? (r % 2) * 0.5 : 0) - (cols - 1) / 2) * crosswindSpacing
      const along = (r - (rows - 1) / 2) * downwindSpacing
      const pos = target
        .clone()
        .addScaledVector(crossWind, cross)
        .addScaledVector(alongWind, along)
        .addScaledVector(up, heightOffset)
      positions.push(pos.toArray() as [number, number, number])
    }
    const heroPos = new Vector3().fromArray(
      positions[centreSlotIndex(count, stagger)]
    )
    return { positions, heroPos, up: up.clone() }
  }, [
    target,
    heightOffset,
    layoutHeadingDeg,
    count,
    crosswindSpacing,
    downwindSpacing,
    stagger,
  ])

  // Shared model orientation — tracks the LIVE wind so the whole turbine yaws to
  // face it (stand-in until the nacelle is a separate node). Explicit ENU basis
  // so the heading is compass-accurate: tower (local +Y) → surface up; rotor
  // axis (local −Z) → wind-from bearing. yawOffsetDeg calibrates the GLB's
  // intrinsic rotor heading. Decoupled from `layout`, so re-yawing never moves a
  // turbine's position — and the camera focus can't drift.
  const modelQuaternion = useMemo(() => {
    const { east, north, up } = enuBasis(target)
    const faceDir = bearingVector(yawHeadingDeg + yawOffsetDeg, east, north)
    const zImg = faceDir.negate() // local +Z image (rotor faces local −Z)
    const xImg = new Vector3().crossVectors(up, zImg).normalize()
    const zOrtho = new Vector3().crossVectors(xImg, up) // re-orthonormalise
    return new Quaternion()
      .setFromRotationMatrix(new Matrix4().makeBasis(xImg, up, zOrtho))
      .toArray() as [number, number, number, number]
  }, [target, yawHeadingDeg, yawOffsetDeg])

  // Hero engine (axle origin) offset within the model, in the model's own frame.
  const heroHubLocal = useMemo(() => {
    const w =
      gltfHero.scene.getObjectByName('Axle') ??
      gltfHero.scene.getObjectByName('Windwings')
    if (w == null) return null
    gltfHero.scene.updateMatrixWorld(true)
    return w.getWorldPosition(new Vector3())
  }, [gltfHero.scene])

  // Camera focus = the hero base lifted to hub height along the surface up.
  // Built from the STABLE layout (not the live model yaw), so the orbit target
  // never drifts as the turbines re-yaw. The hub's small horizontal offset is
  // dropped — negligible for framing and the source of the would-be drift.
  const heroFocus = useMemo(() => {
    if (heroHubLocal == null) return null
    return layout.heroPos
      .clone()
      .addScaledVector(layout.up, heroHubLocal.y * scale)
  }, [heroHubLocal, layout, scale])

  useEffect(() => {
    // Always report (incl. null) so a turbine-free site clears the prior focus.
    onHeroFocus?.(heroFocus)
  }, [onHeroFocus, heroFocus])

  useFrame((_, dt) => {
    if (!spin) return
    // Blender's local +Y (rotor shaft) → glTF local -Z after the Z-up→Y-up axis
    // conversion. One shared angle (all turbines see the same wind); a per-index
    // phase offset avoids an unnaturally phase-locked look.
    //   undefined (Storybook): manual leva spinSpeed.
    //   number  (deploy):      modelled rpm → rad/s, so the rotor matches the HUD.
    //   null    (deploy, no wind data): idle — never the fast fallback.
    const rate =
      rotorRpm === undefined
        ? spinSpeed
        : ((rotorRpm ?? 0) * Math.PI * 2) / 60
    // Ramp to a halt / back up when toggled, instead of an instant cut.
    spinGainRef.current = MathUtils.damp(
      spinGainRef.current,
      wingsEnabled === false ? 0 : 1,
      4,
      dt
    )
    angleRef.current += rate * spinGainRef.current * dt
    for (let i = 0; i < instances.length; i++) {
      const z = angleRef.current + i * 0.37
      const wings = instances[i].wings
      if (wings != null) wings.rotation.z = z
      // Hero's axle shares the rotor shaft: same angle, same axis as the wings.
      const axle = instances[i].axle
      if (axle != null) axle.rotation.z = z
    }
  })

  return (
    <>
      {instances.map((inst, i) => (
        <group
          key={i}
          position={layout.positions[i]}
          quaternion={modelQuaternion}
          scale={scale}
        >
          <primitive object={inst.scene} />
        </group>
      ))}
    </>
  )
}

// Single ship GLB anchored at a fixed geodetic point (Karmøy), placed on the
// local East-North-Up tangent plane with local +Y aligned to the surface
// normal — the same ENU placement math as TurbineFarm. A GLB's modelling
// origin rarely sits at the waterline or faces a useful heading, so scale,
// waterline height, east/north position and yaw are leva-tunable to seat the
// hull on the ocean. The caller gates this behind the ocean stage + Suspense
// (the model is ~7.7 MB, so it must not compete with stage-1 LUT compute).
const ShipModel: FC<{
  url: string
  anchor: Vector3
  scale: number
  heightOffset: number
  eastOffset: number
  northOffset: number
  yawDeg: number
}> = ({ url, anchor, scale, heightOffset, eastOffset, northOffset, yawDeg }) => {
  const gltf = useGLTF(url)
  const scene = useMemo(() => gltf.scene.clone(true), [gltf.scene])
  const { position, quaternion } = useMemo(() => {
    const { east, north, up } = enuBasis(anchor)
    const yawQ = new Quaternion().setFromAxisAngle(
      new Vector3(0, 1, 0),
      MathUtils.degToRad(yawDeg)
    )
    const alignQ = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), up)
    const q = alignQ
      .multiply(yawQ)
      .toArray() as [number, number, number, number]
    const pos = anchor
      .clone()
      .addScaledVector(east, eastOffset)
      .addScaledVector(north, northOffset)
      .addScaledVector(up, heightOffset)
      .toArray() as [number, number, number]
    return { position: pos, quaternion: q }
  }, [anchor, heightOffset, eastOffset, northOffset, yawDeg])

  return (
    <group position={position} quaternion={quaternion} scale={scale}>
      <primitive object={scene} />
    </group>
  )
}

// Debug-only wind arrow: a large ArrowHelper on the tangent plane at `target`,
// pointing in the direction the wind BLOWS TOWARD (downwind = windHeadingDeg +
// 180°). Use it to sanity-check that the turbine array's long axis runs along
// the arrow and every rotor faces INTO the wind (opposite the arrow tip).
const WindArrow: FC<{
  target: Vector3
  windHeadingDeg: number
  lengthM: number
}> = ({ target, windHeadingDeg, lengthM }) => {
  const arrow = useMemo(() => new ArrowHelper(), [])
  useMemo(() => {
    const { east, north, up } = enuBasis(target)
    // Points the way the wind blows TOWARD (downwind = wind-from + 180°).
    const dir = bearingVector(windHeadingDeg + 180, east, north)
    arrow.position.copy(target).addScaledVector(up, lengthM * 0.05)
    arrow.setDirection(dir)
    arrow.setLength(lengthM, lengthM * 0.18, lengthM * 0.09)
    arrow.setColor(0x33ccff)
  }, [arrow, target, windHeadingDeg, lengthM])
  return <primitive object={arrow} />
}

// One ship's debug rig: a leva folder (visibility, scale, waterline, east/north
// offset, yaw) + a "Fly to ship" button that snaps the orbit camera to frame
// the hull. The ship is pinned to a fixed geodetic anchor; its ENU world
// position is held in a ref so the (once-captured) button reads live offsets.
// Returns the live controls; the caller mounts <ShipModel> from def.url.
interface ShipDef {
  folder: string
  url: string
  scale: number
  heightOffset: number
  eastOffset: number
  northOffset: number
}

function useShip(
  def: ShipDef,
  anchor: Vector3,
  orbitControlsRef: { current: any }
): {
  visible: boolean
  scale: number
  heightOffset: number
  eastOffset: number
  northOffset: number
  yawDeg: number
} {
  const controls = useControls(def.folder, {
    visible: { value: true },
    scale: { value: def.scale, min: 0.01, max: 200, step: 0.01 },
    heightOffset: {
      value: def.heightOffset,
      min: -100,
      max: 100,
      step: 0.1,
      label: 'Waterline (m)',
    },
    eastOffset: {
      value: def.eastOffset,
      min: -5000,
      max: 5000,
      step: 5,
      label: 'East (m)',
    },
    northOffset: {
      value: def.northOffset,
      min: -5000,
      max: 5000,
      step: 5,
      label: 'North (m)',
    },
    yawDeg: { value: 0, min: -180, max: 180, step: 1, label: 'Yaw (°)' },
  })
  const worldRef = useRef(new Vector3())
  useEffect(() => {
    const { east, north, up } = enuBasis(anchor)
    worldRef.current
      .copy(anchor)
      .addScaledVector(east, controls.eastOffset)
      .addScaledVector(north, controls.northOffset)
      .addScaledVector(up, controls.heightOffset)
  }, [anchor, controls.eastOffset, controls.northOffset, controls.heightOffset])
  useControls(def.folder, {
    'Fly to ship': button(() => {
      const oc = orbitControlsRef.current
      if (oc?.target == null) return
      const p = worldRef.current
      const { east, north, up } = enuBasis(p)
      oc.object.position
        .copy(p)
        .addScaledVector(up, 250)
        .addScaledVector(east, 350)
        .addScaledVector(north, -350)
      oc.target.copy(p)
      oc.update?.()
    }),
  })
  return controls
}

const SHIP_DEFS: ShipDef[] = [
  {
    folder: 'Ship',
    url: 'public/ship-demo-compressed.glb',
    scale: 2,
    heightOffset: 26,
    eastOffset: 0,
    northOffset: 0,
  },
  {
    folder: 'Ship 2',
    url: 'public/ship-demo-small-compressed.glb',
    scale: 0.8,
    heightOffset: 28.3,
    eastOffset: -10,
    northOffset: -20,
  },
]

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
  // Surfaces the active location (preset or custom) to a host page so a DOM
  // overlay outside the R3F tree — e.g. the deploy's live conditions HUD — can
  // fetch real weather/ocean data for the point currently in view. Additive;
  // Storybook ignores it.
  onLocationChange?: (longitude: number, latitude: number, name: string) => void
  // Modelled rotor speed (rpm) from the deploy's wind model; drives the turbine
  // blade spin so the visible rotor turns at the real, forecast-derived rate.
  // Undefined in Storybook, where the leva spinSpeed governs instead.
  turbineRpm?: number | null
  // Wind bearing (deg the wind blows FROM) from the deploy's live MET feed.
  // Orients the turbine array's wake-aware spacing and yaws every rotor into
  // the wind. null/undefined → the leva 'Wind from' slider governs (Storybook).
  windHeading?: number | null
  // Wind speed (m/s) from the deploy's live MET feed. Drives the calm↔storm
  // wave-strength blend. null/undefined → the leva 'Wind speed' slider governs.
  windSpeed?: number | null
  // Absolute UTC instant (ms) the scene's sun/moon should depict — the deploy's
  // forecast scrubber time. When set, it overrides the leva day/time sliders so
  // the lighting tracks the scrubbed forecast hour. Undefined in Storybook.
  clockMs?: number | null
  // Surfaces the leva-controlled turbine farm size to the host page so the HUD
  // inspector can show a farm total. Additive; Storybook ignores it.
  onTurbineCountChange?: (count: number) => void
  // Deploy camera controls (ControlsPanel). All optional; when omitted the leva
  // Camera panel governs (Storybook).
  //   flyTo: a POI to smoothly fly to (changing it triggers the CameraRig fly).
  //   autoRotate / zoomDistance: override the leva autoOrbit / orbit distance.
  //   wingsEnabled: master on/off for rotor spin (lerps to a halt).
  flyTo?: { longitude: number; latitude: number; name: string } | null
  autoRotate?: boolean
  zoomDistance?: number
  // Live orbit distance reported back each frame when the camera is at rest, so
  // the deploy's zoom slider tracks mouse-wheel zoom. Additive; Storybook omits.
  onZoomChange?: (distance: number) => void
  wingsEnabled?: boolean
  // Hero "cover" visibility override from the deploy. When omitted, the leva
  // Turbine panel governs (Storybook). false hides the cover.
  heroCover?: boolean
  // Per-site farm size from the deploy; overrides the leva Turbine count.
  // Undefined in Storybook, where the leva count governs.
  farmCount?: number
}> = ({
  onReadinessRefs,
  disableOcean = false,
  onLocationChange,
  turbineRpm,
  windHeading,
  windSpeed,
  clockMs,
  onTurbineCountChange,
  flyTo,
  autoRotate,
  zoomDistance,
  onZoomChange,
  wingsEnabled,
  heroCover,
  farmCount
}) => {
  const renderer = useThree<Renderer>(({ gl }) => gl as any)
  const scene = useThree(({ scene }) => scene)
  const camera = useThree(({ camera }) => camera)
  // Live OrbitControls handle (for the 'Dump view' button below).
  const orbitControlsRef = useRef<any>(null)
  orbitControlsRef.current = useThree(({ controls }) => controls)
  const [oceanManager, setOceanManager] = useState<any>(null)
  // Hero turbine engine position, reported by the farm; the camera orbits it.
  const [heroFocus, setHeroFocus] = useState<Vector3 | null>(null)
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

  useEffect(() => {
    onLocationChange?.(
      activeLocation.longitude,
      activeLocation.latitude,
      String(locationControls.preset)
    )
  }, [
    onLocationChange,
    activeLocation.longitude,
    activeLocation.latitude,
    locationControls.preset
  ])

  // Deploy POI fly-to: push the requested location into the leva Location
  // control, which moves `target` and triggers the CameraRig fly animation.
  useEffect(() => {
    if (flyTo == null) return
    if (Object.prototype.hasOwnProperty.call(locationPresets, flyTo.name)) {
      setLocation({ preset: flyTo.name })
    } else {
      setLocation({
        preset: 'Custom',
        longitude: flyTo.longitude,
        latitude: flyTo.latitude
      })
    }
  }, [flyTo, setLocation])

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
    // Analytic effects on the ocean (shared coverage; no extra passes).
    reflectionStrength: { value: 0.05, min: 0, max: 1, step: 0.01 },
    shadowStrength: { value: 0.6, min: 0, max: 1, step: 0.01 },
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

  // Shared cloud field — ONE coverage model feeding the shell, the ocean's
  // cloud reflection, and the ocean's cloud shadow. Rebuilt only when the
  // source toggles; synced from leva each render so slider tweaks update all
  // three with no graph rebuild.
  const cloudField: CloudField = useMemo(
    () =>
      createCloudField({
        source: cloudControls.source as 'procedural' | 'live',
        sunDirection: context.sunDirectionECEF as any,
      }),
    [cloudControls.source, context]
  )
  useEffect(() => () => cloudField.dispose(), [cloudField])
  cloudField.sync({
    altitude: cloudControls.altitude,
    opacity: cloudControls.opacity,
    coverage: cloudControls.coverage,
    windSpeed: cloudControls.windSpeed,
    tiles: cloudControls.tiles,
    dayColor: cloudControls.dayColor,
    nightAmbient: cloudControls.nightAmbient,
    density: cloudControls.density,
    intensity: cloudControls.intensity,
    contrast: cloudControls.contrast,
    reflectionStrength: cloudControls.reflectionStrength,
    shadowStrength: cloudControls.shadowStrength,
  })
  const cloudEffectsEnabled = cloudControls.enabled

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
    preset: { value: 'choppy', options: presetOptions },
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
    spin: { value: true },
    spinSpeed: { value: 2.0, min: 0, max: 20, step: 0.1 },
    count: { value: 15, min: 1, max: 60, step: 1, label: 'Farm count' },
    // Wake-aware spacing in rotor diameters (D = 164 m). Offshore arrays sit
    // ~7–10 D apart along the wind, ~4–5 D across it.
    downwindD: { value: 8, min: 3, max: 15, step: 0.5, label: 'Downwind (D)' },
    crosswindD: { value: 5, min: 2, max: 12, step: 0.5, label: 'Crosswind (D)' },
    stagger: { value: true, label: 'Offset rows' },
    // Manual wind bearing for Storybook (no MET feed); the deploy overrides this
    // with live MET wind via the windHeading prop.
    windDir: { value: 225, min: 0, max: 359, step: 1, label: 'Wind from (°)' },
    yawOffset: {
      value: 0,
      min: -180,
      max: 180,
      step: 1,
      label: 'Rotor offset (°)',
    },
    cover: { value: true, label: 'Hero: cover' },
  })

  const debugControls = useControls('Debug', {
    windArrow: { value: true, label: 'Wind arrow' },
    windArrowKm: {
      value: 3,
      min: 0.5,
      max: 20,
      step: 0.5,
      label: 'Arrow length (km)',
    },
  })

  useEffect(() => {
    onTurbineCountChange?.(turbineControls.count)
  }, [onTurbineCountChange, turbineControls.count])

  // Ships pinned to the Karmøy site (independent of the active fly-to target, so
  // they stay put while the camera roams). Each gets a debug leva folder +
  // "Fly to ship" button via useShip; tune offsets/scale/yaw there.
  const shipAnchor = useTargetECEF(
    locationPresets.Karmøy.longitude,
    locationPresets.Karmøy.latitude,
    locationPresets.Karmøy.height
  )
  const ship0Controls = useShip(SHIP_DEFS[0], shipAnchor, orbitControlsRef)
  const ship1Controls = useShip(SHIP_DEFS[1], shipAnchor, orbitControlsRef)
  const ships = [
    { url: SHIP_DEFS[0].url, controls: ship0Controls },
    { url: SHIP_DEFS[1].url, controls: ship1Controls },
  ]

  const cameraControls = useControls('Camera', {
    minDistance: { value: 1, min: 0.1, max: 5000, step: 0.1 },
    maxDistance: { value: 100000, min: 1000, max: 50_000_000, step: 100_000 },
    autoOrbit: { value: true },
    orbitSpeed: { value: 0.3, min: -5, max: 5, step: 0.05 },
    // After a full load, frame the view you want, then click this. It logs +
    // copies the exact camera pose so it can be hardcoded as the start view.
    dumpView: button(() => {
      const tgt = orbitControlsRef.current?.target
      const data = {
        position: camera.position.toArray(),
        quaternion: camera.quaternion.toArray(),
        up: camera.up.toArray(),
        target: tgt != null ? tgt.toArray() : null,
        distance: tgt != null ? camera.position.distanceTo(tgt) : null
      }
      const json = JSON.stringify(data, null, 2)
      // eslint-disable-next-line no-console
      console.log('[camera dump]\n' + json)
      void navigator.clipboard?.writeText(json)
    }),
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

  // Couple the sea STRENGTH to the wind: blend wave amplitude from calm → storm
  // by wind speed. (Wave DIRECTION is intentionally NOT wind-coupled — the IFFT
  // spectrum has no proper wind-direction tie-in yet, and rotating it spun the
  // whole water surface; revisit when the spectrum supports it.) When off, the
  // manual Waves/Swell controls govern (unchanged behaviour). Storm endpoints
  // are the operator-tuned heavy-condition values; calm endpoints are defaults.
  const windWaveControls = useControls('Wind → Waves', {
    enabled: { value: true, label: 'Couple to wind' },
    windSpeed: { value: 10, min: 0, max: 30, step: 0.5, label: 'Wind speed (m/s)' },
    calmWind: { value: 4, min: 0, max: 15, step: 0.5, label: 'Calm at (m/s)' },
    stormWind: { value: 22, min: 5, max: 30, step: 0.5, label: 'Storm at (m/s)' },
  })
  // Effective wind speed: live MET in the deploy, else the leva slider.
  const effWindSpeed = windSpeed ?? windWaveControls.windSpeed
  // 0 = calm, 1 = storm.
  const stormT = windWaveControls.enabled
    ? MathUtils.clamp(
        (effWindSpeed - windWaveControls.calmWind) /
          Math.max(1e-3, windWaveControls.stormWind - windWaveControls.calmWind),
        0,
        1
      )
    : 0

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
    // Deploy: the scrubber supplies a real UTC instant — depict the sun/moon at
    // exactly that time. Storybook: derive from the leva day/time sliders.
    if (clockMs != null) return new Date(clockMs)
    return getLocalDate(
      activeLocation.longitude,
      atmosphereControls.dayOfYear,
      atmosphereControls.timeOfDay,
      atmosphereControls.year
    )
  }, [
    clockMs,
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
    // Wind-coupled: blend calm → storm wave amplitude by wind speed. Else the
    // manual Waves panel governs.
    oceanUniforms.fftAmplitude.value = windWaveControls.enabled
      ? MathUtils.lerp(1.0, 1.51, stormT)
      : waveControls.fftAmplitude
    oceanUniforms.gerstnerAmplitude.value = windWaveControls.enabled
      ? MathUtils.lerp(1.0, 1.8, stormT)
      : waveControls.gerstnerAmplitude
  }, [oceanUniforms, waveControls, windWaveControls.enabled, stormT])

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
    vertexUniforms.swellStrength.value = windWaveControls.enabled
      ? MathUtils.lerp(0.5, 0.57, stormT)
      : swellControls.swellStrength
    vertexUniforms.swellScale.value = windWaveControls.enabled
      ? MathUtils.lerp(800, 3460, stormT)
      : swellControls.swellScale
  }, [vertexUniforms, swellControls, windWaveControls.enabled, stormT])

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

  // Preset selector — writes water-only fields. Atmosphere / postProcessing /
  // oceanFloor / ssr fields are intentionally skipped (handled elsewhere).
  // MUST be defined AFTER the per-slider effects above: on mount all these
  // effects fire in definition order, and the slider effects write many of the
  // same uniforms (water colour, fft/sss, foam, fresnel…). Defined earlier, the
  // preset would be applied first and then clobbered by the slider defaults, so
  // the starting water looked brighter than any preset selection. Running last,
  // the active preset wins on mount — matching what picking a preset yields.
  // (Slider edits still win afterwards: they fire their own effect; this one
  // only re-runs when the preset or the material rebuilds.)
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
        <CloudLayer field={cloudField} altitude={cloudControls.altitude} />
      )}
      <OrbitControls
        makeDefault
        enableDamping
        minDistance={cameraControls.minDistance}
        maxDistance={cameraControls.maxDistance}
        autoRotate={autoRotate ?? cameraControls.autoOrbit}
        autoRotateSpeed={cameraControls.orbitSpeed}
      />
      <CameraRig
        target={target}
        focus={heroFocus}
        zoomDistance={zoomDistance}
        onDistance={onZoomChange}
      />
      {/* Wind-turbine farm centred on the fly-to target (staggered grid of
          cloned GLBs). Layer 0 (default) so each participates in the depth
          pre-pass for shoreline-foam gating.
          Loaded eagerly: the compressed GLBs are small (~440 KB / ~3.8 MB,
          Draco-decoded off-thread), so they're ready by reveal without starving
          the atmosphere-LUT compute. NOTE: if you add a LARGE model here again,
          re-gate it behind `{!disableOcean && (...)}` (as the ocean is) so its
          download/parse doesn't compete with the stage-1 LUT pipeline — an
          uncompressed 43 MB hero here once stalled that compute for ~80 s. */}
      <TurbineFarm
        target={target}
        scale={turbineControls.scale}
        heightOffset={turbineControls.heightOffset}
        layoutHeadingDeg={turbineControls.windDir}
        yawHeadingDeg={windHeading ?? turbineControls.windDir}
        yawOffsetDeg={turbineControls.yawOffset}
        spin={turbineControls.spin}
        spinSpeed={turbineControls.spinSpeed}
        count={farmCount ?? turbineControls.count}
        crosswindSpacing={turbineControls.crosswindD * ROTOR_DIAMETER_M}
        downwindSpacing={turbineControls.downwindD * ROTOR_DIAMETER_M}
        stagger={turbineControls.stagger}
        rotorRpm={turbineRpm}
        wingsEnabled={wingsEnabled}
        heroCover={heroCover ?? turbineControls.cover}
        onHeroFocus={setHeroFocus}
      />
      {debugControls.windArrow && (
        <WindArrow
          target={target}
          windHeadingDeg={windHeading ?? turbineControls.windDir}
          lengthM={debugControls.windArrowKm * 1000}
        />
      )}
      {/* Karmøy ship. Gated behind the ocean stage (so its ~7.7 MB
          download/parse doesn't compete with the stage-1 atmosphere-LUT
          compute) and isolated in its own Suspense so loading can't blank the
          rest of the scene. */}
      {ships.map(
        ({ url, controls }) =>
          controls.visible &&
          !disableOcean && (
            <Suspense key={url} fallback={null}>
              <ShipModel
                url={url}
                anchor={shipAnchor}
                scale={controls.scale}
                heightOffset={controls.heightOffset}
                eastOffset={controls.eastOffset}
                northOffset={controls.northOffset}
                yawDeg={controls.yawDeg}
              />
            </Suspense>
          )
      )}
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
        <TerrainClamp seaLevelRadius={target.length()} />
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
          cloudReflect={cloudEffectsEnabled ? cloudField.reflect : undefined}
          cloudShadow={cloudEffectsEnabled ? cloudField.shadow : undefined}
          onUniformsReady={setOceanUniforms}
          onVertexUniformsReady={setVertexUniforms}
          onOceanManagerReady={setOceanManager}
        />
      )}
    </>
  )
}

interface StoryArgs {}

// Staged load. Mounting the atmosphere, the (heavy, cloud-reflection/shadow-
// augmented) ocean, and the cloud shell all on the first frame makes the ocean
// pipeline compile race the atmosphere LUT compute — the LUT loses and the sky
// never resolves (permanent black/white). So keep the ocean UNMOUNTED until the
// LUT has finished, then mount it. Readiness is polled from real state
// (lutNode.currentVersion / .updating), not a timer — mirrors the standalone
// (examples/ocean-globe-waterpro-demo/main.tsx) and the project's no-timer rule.
// The 8 s fallback is only a safety net so a stuck probe can't hide the ocean
// forever; it warns rather than failing silently.
const ATMOSPHERE_STABLE_FRAMES = 5
const STAGE_FALLBACK_MS = 8000

export const Story: StoryFC<{}, StoryArgs> = () => {
  const [phase, setPhase] = useState<'atmosphere' | 'ready'>('atmosphere')
  const refsRef = useRef<ContentReadinessRefs | null>(null)
  const handleRefs = useCallback((r: ContentReadinessRefs) => {
    refsRef.current = r
  }, [])

  useEffect(() => {
    if (phase !== 'atmosphere') return
    let cancelled = false
    let stable = 0
    let raf = 0
    const tick = (): void => {
      if (cancelled) return
      const lut = (refsRef.current?.atmosphereContext as any)?.lutNode
      const ready =
        lut != null && lut.currentVersion != null && lut.updating === false
      stable = ready ? stable + 1 : 0
      if (stable >= ATMOSPHERE_STABLE_FRAMES) {
        setPhase('ready')
        return
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    const fallback = setTimeout(() => {
      if (cancelled) return
      console.warn(
        '[GlobeWaterproOcean] atmosphere LUT readiness not detected in ' +
          `${STAGE_FALLBACK_MS} ms; mounting ocean anyway.`
      )
      setPhase('ready')
    }, STAGE_FALLBACK_MS)
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      clearTimeout(fallback)
    }
  }, [phase])

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
      <Content
        disableOcean={phase === 'atmosphere'}
        onReadinessRefs={handleRefs}
      />
    </WebGPUCanvas>
  )
}

Story.args = {}
Story.argTypes = {}
