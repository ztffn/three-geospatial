// G-C: storybook mount of the globe-scale ocean scene with the WaterPro TSL
// fragment composition replacing the legacy chunk material. Composition mirrors
// localhost:5173 (atmosphere + 3D-tiles terrain + tiled IFFT ocean) but the
// chunk material is now built by buildWaterproChunkMaterial + WaveSimulation,
// driven via OceanChunksWaterpro. Legacy WaveGenerator + OceanChunks are no
// longer instantiated by this story.

'use client'

import { Html, OrbitControls } from '@react-three/drei'
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
import { pass, toneMapping, uniform, uv, vec4 } from 'three/tsl'
import * as THREE from 'three/webgpu'
import {
  MeshLambertNodeMaterial,
  PostProcessing,
  type Renderer,
} from 'three/webgpu'
// Fat (wide, optionally dashed) screen-space lines for the AIS overlays. These
// are the WebGPURenderer variants — `Line2NodeMaterial` reads the viewport for
// pixel-width + dashing automatically (no manual resolution).
import { LineGeometry } from 'three/addons/lines/LineGeometry.js'
import { Line2 } from 'three/addons/lines/webgpu/Line2.js'

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
import {
  cameraFar,
  cameraNear,
  depthToViewZ,
  dithering,
  inverseProjectionMatrix,
  lensFlare,
  projectionMatrix,
  screenToPositionView,
} from '@takram/three-geospatial/webgpu'

import {
  applyWaterproPreset,
  WATERPRO_PRESET_NAMES,
  type WaterproPresetName,
  type WaterproPresetUniformBag,
  createUnderwaterUniforms,
  underwaterPostNode,
  UNDERWATER_DEFAULTS,
} from '../../../packages/ocean-ifft/src/waterpro/index.js'
import { sampleGerstnerUniformsCPU } from '../../../packages/ocean-ifft/src/ocean/gerstner-cpu'
import { Color } from 'three'

import OceanChunksWaterpro, {
  type VertexUniformsBag,
} from './OceanChunksWaterpro'
import { enuBasis, bearingVector } from './enu'
import {
  SHIP_DEFS,
  ShipModel,
  useShip,
  type ShipMotionControls,
} from './ShipModel'
import { TurbineCables, type CableBakeSnapshot } from './TurbineCables'
import { CABLE_BAKE } from './cable-bake'
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
// Scroll-zoom rate: new orbit distance = current × e^(wheelDeltaY × this). ~17%
// per typical mouse notch (deltaY ≈ 120). Positive deltaY (scroll down) → larger
// distance (zoom out). Fed into the damped distance ease for a soft stop.
const WHEEL_ZOOM_RATE = 0.0013
// Damp rates (1/s) for the distance ease. The wheel responds snappily to direct
// scrolling (still decelerating to a soft stop); the slider stays gentle.
const WHEEL_ZOOM_LAMBDA = 12
const SLIDER_ZOOM_LAMBDA = 6
// Scratch for the per-frame dolly direction (avoids an allocation each glide
// frame). Single CameraRig instance, used+discarded synchronously per frame.
const _dollyDir = new Vector3()
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
  // At sea ~7 km NW of Bodø (patrol-ship scenario anchor).
  'Bodø': { longitude: 14.25, latitude: 67.3, height: 20 },
  // Open Vestfjorden / Norwegian Sea, ~50 km out from Bodø (platform scenario).
  'Norwegian Sea': { longitude: 13.2, latitude: 67.5, height: 20 },
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

// Ocean-local frame: X = east·oceanScale, Y = up (unit), Z = north·oceanScale,
// origin at target + up·seaLevelOffset. Computed at the story level (not
// inside OceanSurface) because ship buoyancy probes map world positions into
// this frame via its inverse to sample the wave field phase-exactly.
function computeOceanMatrix(
  target: Vector3,
  seaLevelOffset: number,
  oceanScale: number
): Matrix4 {
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
}

const OceanSurface: FC<{
  matrix: Matrix4
  atmosphereContext: AtmosphereContext
  envCubeTexture: THREE.CubeTexture
  onUniformsReady: (uniforms: WaterproOceanUniforms) => void
  onVertexUniformsReady: (vu: VertexUniformsBag) => void
  onOceanManagerReady: (oceanManager: any) => void
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
  matrix,
  atmosphereContext,
  envCubeTexture,
  onUniformsReady,
  onVertexUniformsReady,
  onOceanManagerReady,
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
  // Explicit camera destination (scenario sub-viewpoints: ship, underwater).
  // Overrides the default destination (focus/target), and a CHANGE to it
  // triggers a fly even when the location target is unchanged — same-site
  // viewpoint hops without moving the farm. Null → default behaviour.
  aim?: Vector3 | null
  // Slider-commanded orbit distance. Eased ONLY when it actually changes (the
  // user moved the slider) — never used as a fly target, so a programmatic
  // fly-to can't race it into a pre-fly snap.
  zoomDistance?: number
  // Target orbit distance for the CURRENT fly-to (scenario/viewpoint). The fly
  // animates fromDist→flyDistance as one motion; omitted → keep current distance.
  flyDistance?: number
  // Per-viewpoint camera attitude (scenario presets). Omitted → the module
  // defaults (heading 180, pitch -20). Like the defaults, applied for the
  // whole fly — the camera snaps to the new attitude at fly start.
  headingDeg?: number
  pitchDeg?: number
  // Land exactly at zoomDistance even with no turbine focus: the fly-to
  // carried an explicit aim height (deliberately placed on/above terrain),
  // so the turbine-free overview clamp would be wrong.
  landExact?: boolean
  // Gentle recenter: keep the CURRENT distance (no zoom change) and skip the
  // great-circle pull-out bump — a smooth pan of the orbit centre.
  gentleRecenter?: boolean
  // Reports the camera's live distance to the orbit target when at rest
  // (including after a mouse-wheel zoom), so a host slider can track it.
  // Suppressed mid-fly and mid-slider-ease to avoid fighting those commands.
  onDistance?: (distance: number) => void
}> = ({
  target,
  focus,
  aim = null,
  zoomDistance,
  flyDistance,
  headingDeg,
  pitchDeg,
  landExact = false,
  gentleRecenter = false,
  onDistance
}) => {
  const camera = useThree(({ camera }) => camera)
  const controls = useThree(({ controls }) => controls as any)
  const domElement = useThree(({ gl }) => gl.domElement)

  const fly = useRef<{
    t: number
    dur: number
    fromAim: Vector3
    toAim: Vector3
    fromDist: number
    toDist: number
    bump: number
  } | null>(null)
  // Slider-zoom ease is EDGE-triggered: when zoomDistance changes (user moved
  // the slider) we latch it as easeTarget and damp toward it until reached.
  // A fly-to never changes zoomDistance, so it can't arm this — which is what
  // killed the pre-fly "snap". prevZoom detects the change edge.
  const prevZoom = useRef<number | undefined>(zoomDistance)
  const easeTarget = useRef<number | null>(null)
  // Damp rate for the current ease — set by whichever input armed easeTarget
  // (wheel = snappy, slider = gentle), so the two interactions feel distinct.
  const easeLambda = useRef(SLIDER_ZOOM_LAMBDA)
  const lastTarget = useRef<Vector3 | null>(null)
  const lastAim = useRef<Vector3 | null>(null)
  const tmpAim = useRef(new Vector3())
  const lastEmitted = useRef(-1)

  // Soft scroll-zoom. OrbitControls' own dolly is undamped (the `scale` is applied
  // and reset every frame — see three-stdlib), so the wheel stops dead. Instead we
  // disable its zoom (enableZoom={false}) and feed each wheel delta into the same
  // damped distance ease the slider uses (easeTarget → MathUtils.damp), so the
  // zoom glides to a stop. Multiplicative per delta + clamped to the orbit limits;
  // accumulates across rapid scrolls. (Also disables pinch-zoom — desktop demo.)
  useEffect(() => {
    if (controls?.target == null) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const base =
        easeTarget.current ?? camera.position.distanceTo(controls.target)
      const next = MathUtils.clamp(
        base * Math.exp(e.deltaY * WHEEL_ZOOM_RATE),
        controls.minDistance ?? 1,
        controls.maxDistance ?? Infinity
      )
      easeTarget.current = next
      easeLambda.current = WHEEL_ZOOM_LAMBDA
    }
    domElement.addEventListener('wheel', onWheel, { passive: false })
    return () => domElement.removeEventListener('wheel', onWheel)
  }, [domElement, controls, camera])

  // Initial placement and the fly's start anchor use the LOCATION (target). The
  // fly DESTINATION, however, is the hero engine (`focus`, the nacelle/axle) —
  // see the fly loop. `focus` lags a location change by ~1 frame (it's recomputed
  // from the new farm), but the slerp at t≈0 is dominated by the start anchor, so
  // reading it live there self-corrects without a visible mis-aim.
  const aimFor = useCallback(() => target.clone(), [target])

  const place = useCallback(
    (aim: Vector3, dist: number) => {
      const cam = new THREE.PerspectiveCamera()
      new PointOfView(
        dist,
        radians(headingDeg ?? heading),
        radians(pitchDeg ?? pitch)
      ).decompose(aim, cam.position, cam.quaternion, cam.up)
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
    [camera, controls, headingDeg, pitchDeg]
  )

  // Initial placement; afterwards, a target change starts a fly-to. Depends on
  // `controls` too: OrbitControls (makeDefault) often isn't registered on first
  // mount, and the initial placement must set controls.target — otherwise the
  // orbit centre stays at the earth's centre and the camera stares into the
  // planet (black) until something re-runs this. So wait for controls, then place.
  useLayoutEffect(() => {
    if (controls?.target == null) return
    const startAim = aimFor()
    const dist = zoomDistance ?? distance
    // An explicit-aim change (same-site viewpoint hop) starts a fly even when
    // the location target is unchanged.
    const aimChanged =
      (lastAim.current == null) !== (aim == null) ||
      (lastAim.current != null && aim != null && !lastAim.current.equals(aim))
    if (lastTarget.current == null) {
      place(startAim, dist)
    } else if (!lastTarget.current.equals(target) || aimChanged) {
      const fromAim = controls?.target?.clone() ?? lastTarget.current.clone()
      const fromDist =
        controls?.target != null
          ? camera.position.distanceTo(controls.target)
          : dist
      // Angular separation drives how far the camera pulls out mid-arc.
      const sep = Math.acos(
        MathUtils.clamp(
          fromAim.clone().normalize().dot(startAim.clone().normalize()),
          -1,
          1
        )
      )
      // Distance is owned by the fly: animate from the TRUE current distance to
      // the fly's target (flyDistance) whenever one is given — including a gentle
      // recenter, so a marker focus descends straight to its zoom with no pull-
      // out arc (gentle still zeroes the bump below). No flyDistance → hold the
      // current distance. The slider channel is untouched, so no ease races this.
      const toDist = flyDistance ?? fromDist
      fly.current = {
        t: 0,
        dur: 1.6 + (sep / Math.PI) * 1.8,
        fromAim,
        toAim: startAim,
        fromDist,
        toDist,
        bump: gentleRecenter ? 0 : (sep / Math.PI) * 1.2e7 // ~globe scale for antipodal
      }
    }
    lastTarget.current = target.clone()
    lastAim.current = aim?.clone() ?? null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, aim, controls])

  useFrame((_, dt) => {
    if (controls?.target == null) return

    // Edge-detect a slider move and latch it as the ease target. Done every
    // frame (not in an effect) so it's caught even mid-fly and applied after.
    if (zoomDistance !== prevZoom.current) {
      prevZoom.current = zoomDistance
      if (zoomDistance != null) {
        easeTarget.current = zoomDistance
        easeLambda.current = SLIDER_ZOOM_LAMBDA
      }
    }

    if (fly.current != null) {
      const f = fly.current
      f.t = Math.min(1, f.t + dt / f.dur)
      const e = easeInOut(f.t)
      // Destination precedence: explicit aim (scenario sub-viewpoint) > hero
      // engine (`focus`, the nacelle/axle) > the sea-level location. Framing on
      // the focus means a close zoom lands the right distance from the nacelle —
      // not stranded ~80 m below it at the surface, which (nearly radially under
      // the hub) drives OrbitControls into a degenerate pole and shows the
      // planet interior. Read live so the ~1-frame `focus` lag self-corrects;
      // fall back to the surface target if the site has no turbines (focus null).
      const destAim = aim ?? focus ?? f.toAim
      const curAim = geoSlerp(f.fromAim, destAim, e, tmpAim.current)
      // Turbine-free sites (focus null) land at a city overview, never the close
      // zoom — their target is underground onshore (see overviewDistance).
      // Unless the fly carries an explicit aim or aim height (landExact): then
      // the aim is deliberately placed and the commanded distance is
      // authoritative.
      const landDist =
        aim != null || focus != null || landExact
          ? f.toDist
          : Math.max(f.toDist, overviewDistance)
      const dist =
        MathUtils.lerp(f.fromDist, landDist, e) + f.bump * Math.sin(Math.PI * e)
      // place() copies the current aim into controls.target, so at t=1 the
      // orbit centre is the destination — no separate post-landing recentre.
      place(curAim, dist)
      if (f.t >= 1) {
        controls.update?.()
        fly.current = null
      }
      return
    }

    // Ease toward a latched slider target (set above on a slider move). Mouse-
    // wheel zoom is left alone — it doesn't change zoomDistance, so nothing is
    // latched. Cleared when reached.
    if (easeTarget.current != null) {
      const goal = easeTarget.current
      const dir = _dollyDir.copy(camera.position).sub(controls.target)
      const cur = dir.length()
      if (cur > 1e-6) {
        const next = MathUtils.damp(cur, goal, easeLambda.current, dt)
        camera.position
          .copy(controls.target)
          .addScaledVector(dir.normalize(), next)
        controls.update?.()
        if (Math.abs(next - goal) < goal * 0.01) {
          easeTarget.current = null
        }
      } else {
        easeTarget.current = null
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

// First-person free-fly rig (deploy 'fps' camera mode). WASD moves on the
// local ENU tangent plane relative to the view heading, Space/C move along
// the surface normal, Shift sprints, left-drag looks around. No gravity and
// no terrain collision by design — coupling movement to raycasts against the
// streamed photogrammetry (±30 m noise) would judder; spawns are placed at
// safe heights instead. The ENU basis is re-derived from the camera position
// every frame, so long walks stay tangent to the globe.
//
// Platform riding: when a `platform` (the ship's buoyancy-animated group) is
// provided and the camera is near it, the platform's frame-to-frame world
// transform delta is applied to the camera — standing on the deck, you heave
// and tilt with the hull instead of watching it move through you. The ride
// weight fades with distance so walking away never pops.
// Person scale relative to real-world metres. The scene's meshes (ship GLB at
// its tuned scale) read ~2× larger than their nominal metre size, so a "real"
// 1.7 m eye height felt like a giant — shrink the whole person (eye height +
// speeds together, they're one scale cue) to match the meshes. Tune this one
// number if the human scale still feels off.
const FPS_PERSON_SCALE = 0.5
const FPS_WALK_SPEED = 2.5 * FPS_PERSON_SCALE // m/s — human walking pace
const FPS_SPRINT_MULT = 5
const FPS_LOOK_SPEED = 0.25 // deg per px dragged
// m above the surface the spawn raycast finds
const FPS_EYE_HEIGHT = 1.7 * FPS_PERSON_SCALE
const FPS_FOV = 70 // human-feeling vertical FOV; orbit fov restored on exit
const FPS_RIDE_NEAR = 90 // full ride within this distance of the platform (m)
const FPS_RIDE_FAR = 140 // no ride beyond this (smoothstep falloff between)
const fpsTmpMove = new Vector3()
const fpsTmpLook = new Vector3()
const fpsTmpRide = new Vector3()
const fpsTmpM1 = new Matrix4()
const fpsTmpM2 = new Matrix4()
const fpsSpawnRay = new THREE.Raycaster()

// The single list of FPS deck-spawn/ride platform ids — the ship registry's
// `platformId`s, the live-group setters, and a scenario's `spawn.platform` all
// key off this, so adding a deck-capable vessel can't silently miss a setter.
const FPS_PLATFORM_IDS = ['ship', 'patrolship', 'platform'] as const
type FpsPlatformId = (typeof FPS_PLATFORM_IDS)[number]

const FpsRig: FC<{
  active: boolean
  // Spawn pose. Applied when the rig activates and whenever the spawn changes
  // (scenario switch while in FPS mode); `nonce` forces a respawn on demand.
  // `position` is an absolute ECEF spawn; `platformOffsetENU` + `platformId`
  // instead spawn relative to that structure's LIVE anchor (e.g. on a ship
  // deck) — placement waits for the platform to mount.
  spawn: {
    position: Vector3 | null
    platformId?: string
    platformOffsetENU?: [number, number, number]
    headingDeg: number
    pitchDeg: number
    nonce: number
  } | null
  // Rideable platforms (ship/structure groups) keyed by id. Their transforms
  // are rewritten every frame by the buoyancy loops; we consume position +
  // delta here — the camera rides whichever placed platform is nearest.
  platforms?: Record<string, Object3D | null>
}> = ({ active, spawn, platforms }) => {
  const camera = useThree(({ camera }) => camera)
  const gl = useThree(({ gl }) => gl)
  const headingRef = useRef(0)
  const pitchRef = useRef(0)
  const keysRef = useRef(new Set<string>())
  const draggingRef = useRef(false)
  const spawnedRef = useRef<string | null>(null)
  const pendingSpawnRef = useRef<typeof spawn>(null)
  // Ride state: which platform the camera is currently coupled to + its
  // last-frame matrix. Reset when the nearest platform changes identity.
  const rideRef = useRef<{ id: string; matrix: Matrix4 } | null>(null)

  // Person-scale FOV while in first person; restore the orbit FOV on exit.
  useEffect(() => {
    if (!active) return
    const cam = camera as THREE.PerspectiveCamera
    const prevFov = cam.fov
    cam.fov = FPS_FOV
    cam.updateProjectionMatrix()
    return () => {
      cam.fov = prevFov
      cam.updateProjectionMatrix()
    }
  }, [active, camera])

  // Queue a (re)spawn on activation / spawn change. Placement happens in the
  // frame loop, NOT here: platform spawns must wait until the buoyancy loop
  // has written the ship's first real transform (at mount the group still
  // sits at the scene origin).
  useEffect(() => {
    if (!active || spawn == null) return
    const key = `${spawn.nonce}:${spawn.position?.toArray().join(',') ?? 'platform'}`
    if (spawnedRef.current === key) return
    spawnedRef.current = key
    pendingSpawnRef.current = spawn
  }, [active, spawn])

  useEffect(() => {
    if (active) return
    // Leaving FPS: drop held keys and forget the spawn so re-entering respawns.
    keysRef.current.clear()
    spawnedRef.current = null
    pendingSpawnRef.current = null
    rideRef.current = null
  }, [active])

  useEffect(() => {
    if (!active) return
    const dom = gl.domElement
    const keys = keysRef.current
    const onKeyDown = (e: KeyboardEvent): void => {
      keys.add(e.code)
    }
    const onKeyUp = (e: KeyboardEvent): void => {
      keys.delete(e.code)
    }
    const onBlur = (): void => {
      keys.clear()
      draggingRef.current = false
    }
    const onMouseDown = (e: MouseEvent): void => {
      if (e.button === 0) draggingRef.current = true
    }
    const onMouseUp = (): void => {
      draggingRef.current = false
    }
    const onMouseMove = (e: MouseEvent): void => {
      if (!draggingRef.current) return
      headingRef.current += e.movementX * FPS_LOOK_SPEED
      pitchRef.current = MathUtils.clamp(
        pitchRef.current - e.movementY * FPS_LOOK_SPEED,
        -85,
        85
      )
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    dom.addEventListener('mousedown', onMouseDown)
    window.addEventListener('mouseup', onMouseUp)
    window.addEventListener('mousemove', onMouseMove)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      dom.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('mouseup', onMouseUp)
      window.removeEventListener('mousemove', onMouseMove)
    }
  }, [active, gl])

  useFrame((_, dt) => {
    if (!active) return

    // Resolve a queued spawn. Platform spawns wait for the ship group to be
    // placed in ECEF (position length ≈ earth radius; at mount it's still at
    // the origin), then raycast straight down through the configured point to
    // find the actual deck surface and stand FPS_EYE_HEIGHT above it — so the
    // eye height is person-scale regardless of the GLB's deck height.
    const pending = pendingSpawnRef.current
    if (pending != null) {
      let position = pending.position
      if (pending.platformOffsetENU != null) {
        const platform =
          pending.platformId != null
            ? (platforms?.[pending.platformId] ?? null)
            : null
        if (platform == null || platform.position.lengthSq() < 1e12) return
        const anchor = platform.getWorldPosition(new Vector3())
        const [e, n, u] = pending.platformOffsetENU
        const { east, north, up } = enuBasis(anchor)
        position = anchor
          .clone()
          .addScaledVector(east, e)
          .addScaledVector(north, n)
          .addScaledVector(up, u)
        fpsSpawnRay.set(
          position.clone().addScaledVector(up, 60),
          up.clone().negate()
        )
        fpsSpawnRay.far = 200
        const hit = fpsSpawnRay.intersectObject(platform, true)[0]
        if (hit != null) {
          position = hit.point.clone().addScaledVector(up, FPS_EYE_HEIGHT)
        }
      }
      if (position == null) {
        pendingSpawnRef.current = null
        return
      }
      camera.position.copy(position)
      headingRef.current = pending.headingDeg
      pitchRef.current = pending.pitchDeg
      rideRef.current = null
      pendingSpawnRef.current = null
    }

    // Ride the nearest placed platform: apply its world-transform delta since
    // last frame, weighted by proximity (full within FPS_RIDE_NEAR, zero past
    // FPS_RIDE_FAR). The delta includes the tilt rotation about the hull
    // pivot, so a player at the rail rises/falls correctly, not just at the
    // deck centre. One frame of lag vs the buoyancy loop is sub-centimetre.
    // Static platforms yield an identity delta — a free no-op.
    let nearestId: string | null = null
    let nearestObj: Object3D | null = null
    let nearestDist = Infinity
    if (platforms != null) {
      for (const id in platforms) {
        const obj = platforms[id]
        // Skip unmounted entries and groups not yet placed in ECEF.
        if (obj == null || obj.position.lengthSq() < 1e12) continue
        const dist = camera.position.distanceTo(obj.position)
        if (dist < FPS_RIDE_FAR && dist < nearestDist) {
          nearestDist = dist
          nearestId = id
          nearestObj = obj
        }
      }
    }
    if (nearestObj != null && nearestId != null) {
      nearestObj.updateMatrixWorld()
      const m = nearestObj.matrixWorld
      const ride = rideRef.current
      if (ride != null && ride.id === nearestId) {
        const w = 1 - MathUtils.smoothstep(nearestDist, FPS_RIDE_NEAR, FPS_RIDE_FAR)
        if (w > 0) {
          fpsTmpM1.copy(ride.matrix).invert()
          fpsTmpM2.copy(m).multiply(fpsTmpM1)
          const ridden = fpsTmpRide
            .copy(camera.position)
            .applyMatrix4(fpsTmpM2)
          camera.position.lerp(ridden, w)
        }
        ride.matrix.copy(m)
      } else {
        rideRef.current = { id: nearestId, matrix: m.clone() }
      }
    } else {
      rideRef.current = null
    }

    const { east, north, up } = enuBasis(camera.position)
    const p = radians(pitchRef.current)
    // Horizontal forward/right from the compass heading (0 = N, 90 = E).
    const fwdH = bearingVector(headingRef.current, east, north)
    const rightH = bearingVector(headingRef.current + 90, east, north)

    const keys = keysRef.current
    const sprint =
      keys.has('ShiftLeft') || keys.has('ShiftRight') ? FPS_SPRINT_MULT : 1
    const move = fpsTmpMove.set(0, 0, 0)
    if (keys.has('KeyW') || keys.has('ArrowUp')) move.add(fwdH)
    if (keys.has('KeyS') || keys.has('ArrowDown')) move.sub(fwdH)
    if (keys.has('KeyD') || keys.has('ArrowRight')) move.add(rightH)
    if (keys.has('KeyA') || keys.has('ArrowLeft')) move.sub(rightH)
    if (keys.has('Space')) move.add(up)
    if (keys.has('KeyC')) move.sub(up)
    if (move.lengthSq() > 0) {
      camera.position.addScaledVector(
        move.normalize(),
        FPS_WALK_SPEED * sprint * dt
      )
    }

    // View: pitch the horizontal forward toward the surface normal.
    const look = fpsTmpLook
      .copy(fwdH)
      .multiplyScalar(Math.cos(p))
      .addScaledVector(up, Math.sin(p))
    camera.up.copy(up)
    camera.lookAt(look.add(camera.position))
  })

  return null
}

// One vessel for a globe-overview marker layer (sanctioned shadow fleet or
// Norwegian Coast Guard / Navy patrol). The host (deploy) resolves live
// positions from AIS and passes them in; the scene never invents positions.
// `id` is the stable selection key (IMO when broadcast, else mmsi-derived);
// `speedOverGround` feeds the selected vessel's forward-projection overlay.
export interface VesselMarker {
  id: string
  imo: string | null
  name: string | null
  latitude: number
  longitude: number
  courseOverGround: number | null
  speedOverGround: number | null
}

// Per-layer marker palette: dart fill + label text colour (selected → white).
export interface MarkerColor {
  fill: string
  text: string
}
export const SHADOW_MARKER_COLOR: MarkerColor = {
  fill: 'oklch(0.6671 0.2199 26.4681)',
  text: '#ffd7d0'
}
export const PATROL_MARKER_COLOR: MarkerColor = {
  fill: 'oklch(0.62 0.17 248)',
  text: '#cfe0ff'
}

// Globe-overview marker layer: drops an icon at each vessel's live position,
// shown ONLY when the camera is pulled back to a regional/globe view (where the
// ship models are sub-pixel specks) and hidden as you descend into a scenario —
// EXCEPT the selected vessel, which persists through the hide threshold so you
// can fly down and inspect it. Visibility uses hysteresis (show ≥30 km altitude,
// hide <18 km) so it doesn't flicker at the boundary. Icons are screen-space DOM
// (drei Html), so they stay a constant size regardless of zoom.
const MARKER_SHOW_ALT = 30_000 // m above the ellipsoid
const MARKER_HIDE_ALT = 18_000 // m (hysteresis band below SHOW)
const EARTH_MEAN_RADIUS = 6_371_000
// Distance (m) along a vessel's course used to derive the dart's ON-SCREEN
// heading: the dart is a screen-space DOM element, so rotating it by raw COG
// would peg it to screen-up, not geographic north — it would then appear to
// spin with the camera. Instead we project this probe point and rotate the dart
// to the screen-space bearing, so it tracks true course under any camera angle.
const HEADING_PROBE_M = 5000
const _rotNdcA = new Vector3()
const _rotNdcB = new Vector3()

// Single source of truth for the globe-overview LOD: true when the camera is
// pulled back past the marker show-altitude (hysteresis so it doesn't flicker at
// the boundary). Computed once from the real altitude above the ellipsoid and
// shared by every marker layer AND the host's AIS panel — so markers and panel
// swap together instead of each re-deriving it from a different camera metric.
function useOverviewLOD(): boolean {
  const [overview, setOverview] = useState(false)
  const ref = useRef(false)
  useFrame(({ camera }) => {
    const alt = camera.position.length() - EARTH_MEAN_RADIUS
    const next = ref.current ? alt > MARKER_HIDE_ALT : alt > MARKER_SHOW_ALT
    if (next !== ref.current) {
      ref.current = next
      setOverview(next)
    }
  })
  return overview
}

const VesselMarkers: FC<{
  vessels: VesselMarker[]
  color: MarkerColor
  // Marker click → host opens the full vessel callout (deploy HUD).
  onSelect?: (id: string) => void
  // Currently-selected vessel id, so its marker reads as active. Shared across
  // every layer; only the layer that OWNS it (has it in `vessels`) reacts.
  selectedId?: string | null
  // The shared overview-LOD boolean (computed once by useOverviewLOD in Content):
  // true when pulled back to the globe view. Every marker layer AND the host's
  // AIS panel read the same boolean, so markers and panel swap in lockstep.
  visible: boolean
}> = ({ vessels, color, onSelect, selectedId, visible }) => {
  // Live <svg> elements by vessel id, so the frame loop can rotate each dart to
  // its on-screen course bearing imperatively (no React re-render per frame).
  const svgRefs = useRef(new Map<string, SVGSVGElement>())
  // Last view state the darts were oriented for. The per-marker rotation pass
  // is skipped entirely when none of (camera pose, viewport, marker set) changed
  // — so a static view costs nothing. Per-instance (not module scope) so the
  // shadow and patrol layers don't clobber each other's guard.
  const lastPose = useRef({
    x: NaN,
    y: NaN,
    z: NaN,
    qx: NaN,
    qy: NaN,
    qz: NaN,
    qw: NaN,
    w: 0,
    h: 0,
    placed: null as typeof placed | null,
    sel: undefined as string | null | undefined
  })
  const placed = useMemo(
    () =>
      vessels.map(v => {
        const pos = new Geodetic(
          radians(v.longitude),
          radians(v.latitude),
          0
        ).toECEF()
        // Probe point a little way along the course, for the screen-bearing.
        let headPos: Vector3 | null = null
        if (v.courseOverGround != null) {
          const { east, north } = enuBasis(pos)
          headPos = pos
            .clone()
            .addScaledVector(
              bearingVector(v.courseOverGround, east, north),
              HEADING_PROBE_M
            )
        }
        return { v, pos, headPos }
      }),
    [vessels]
  )
  useFrame(({ camera, size }) => {
    // Rotate each drawn dart to the screen-space bearing of its course, so it
    // points at true heading regardless of camera azimuth (and doesn't spin with
    // the globe). Skipped unless the view changed since last frame — the course
    // is baked into headPos in the memo, so only the camera/viewport move it.
    const cp = camera.position
    const cq = camera.quaternion
    const lp = lastPose.current
    const viewChanged =
      lp.placed !== placed ||
      lp.sel !== selectedId ||
      lp.w !== size.width ||
      lp.h !== size.height ||
      lp.x !== cp.x ||
      lp.y !== cp.y ||
      lp.z !== cp.z ||
      lp.qx !== cq.x ||
      lp.qy !== cq.y ||
      lp.qz !== cq.z ||
      lp.qw !== cq.w
    if (viewChanged) {
      for (const p of placed) {
        if (p.headPos == null) continue
        const el = svgRefs.current.get(p.v.id)
        if (el == null) continue
        _rotNdcA.copy(p.pos).project(camera)
        _rotNdcB.copy(p.headPos).project(camera)
        // NDC deltas scaled by viewport px to undo aspect distortion. Dart points
        // up (−y screen) at 0°; CSS rotate is clockwise; NDC y is up, so a course
        // toward +NDC.y (north on a north-up view) → atan2(dx, dy)=0 (no spin),
        // east (dx>0) → +90° (right).
        const dx = (_rotNdcB.x - _rotNdcA.x) * size.width
        const dy = (_rotNdcB.y - _rotNdcA.y) * size.height
        el.style.transform = `rotate(${(Math.atan2(dx, dy) * 180) / Math.PI}deg)`
      }
      lp.placed = placed
      lp.sel = selectedId
      lp.w = size.width
      lp.h = size.height
      lp.x = cp.x
      lp.y = cp.y
      lp.z = cp.z
      lp.qx = cq.x
      lp.qy = cq.y
      lp.qz = cq.z
      lp.qw = cq.w
    }
  })
  if (placed.length === 0) return null
  // Pulled back → all markers. Zoomed past the hide threshold → only the
  // selected vessel this layer owns, so you can descend onto it for inspection.
  const ownedSelected =
    selectedId != null ? placed.find(p => p.v.id === selectedId) : undefined
  const toDraw = visible ? placed : ownedSelected != null ? [ownedSelected] : []
  if (toDraw.length === 0) return null
  return (
    <>
      {toDraw.map(({ v, pos }) => (
        <Html
          key={v.id}
          position={pos}
          center
          zIndexRange={[4, 0]}
          style={{ pointerEvents: 'none', userSelect: 'none' }}
        >
          <div
            onClick={onSelect != null ? () => onSelect(v.id) : undefined}
            title={`${v.name ?? 'Unknown'}${
              v.imo != null ? ` · IMO ${v.imo}` : ''
            }${
              v.courseOverGround != null
                ? ` · ${Math.round(v.courseOverGround)}°`
                : ''
            }`}
            style={{
              // Wrapper shrinks to the dart so drei's `center` lands the DART
              // exactly on the vessel position; the name floats beside it
              // (absolute, below) without shifting the icon off the point.
              position: 'relative',
              display: 'inline-flex',
              lineHeight: 0,
              color: selectedId === v.id ? '#fff' : color.text,
              // Only the marker is interactive; the rest of the Html layer
              // stays click-through so the globe drags normally.
              pointerEvents: onSelect != null ? 'auto' : 'none',
              cursor: onSelect != null ? 'pointer' : 'default'
            }}
          >
            {(() => {
              const sel = selectedId === v.id
              const cog = v.courseOverGround
              const sz = sel ? 18 : 14
              const stroke = sel ? '#fff' : 'rgba(255,255,255,0.85)'
              const fill = color.fill
              return (
                <svg
                  ref={el => {
                    if (el != null) svgRefs.current.set(v.id, el)
                    else svgRefs.current.delete(v.id)
                  }}
                  width={sz}
                  height={sz}
                  viewBox="0 0 24 24"
                  style={{
                    flexShrink: 0,
                    // Rotation is set imperatively each frame to the on-screen
                    // course bearing (see the useFrame loop) — a static
                    // rotate(cog) would peg the dart to screen-up, not north.
                    filter: 'drop-shadow(0 0 3px rgba(0,0,0,0.7))',
                    transition: 'width 120ms, height 120ms'
                  }}
                >
                  {cog != null ? (
                    // Ship dart pointing N: bow tip, two stern corners, notch.
                    <path
                      d="M12 2 L19 21 L12 16.5 L5 21 Z"
                      fill={fill}
                      stroke={stroke}
                      strokeWidth={1.3}
                      strokeLinejoin="round"
                    />
                  ) : (
                    // Heading unknown — neutral disc.
                    <circle
                      cx="12"
                      cy="12"
                      r="6"
                      fill={fill}
                      stroke={stroke}
                      strokeWidth={1.3}
                    />
                  )}
                </svg>
              )
            })()}
            <span
              style={{
                // Floated to the right of the dart, vertically centred, OUT of
                // flow so it never displaces the icon from the vessel position.
                position: 'absolute',
                left: '100%',
                top: '50%',
                transform: 'translateY(-50%)',
                marginLeft: 4,
                fontFamily:
                  "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
                fontSize: 10,
                lineHeight: 1,
                whiteSpace: 'nowrap',
                textShadow: '0 0 3px rgba(0,0,0,0.85)'
              }}
            >
              {v.name ?? v.imo ?? v.id}
            </span>
          </div>
        </Html>
      ))}
    </>
  )
}

// Overlay polylines sit at sea level (height 0), exactly like the marker dart's
// anchor, so the line and the icon rest at the same height — no parallax gap
// between them at an angled/zoomed view. No lift is needed because the lines are
// drawn with depthTest off (always on top), so the wave mesh can't bury them.
const OVERLAY_LIFT_M = 0
const KNOTS_TO_M = 1852 // 1 knot·hour = 1 nautical mile = 1852 m
// Forward dead-reckoning horizons for the selected vessel, matching NAIS
// ("where will she be after 30 min / 1 h / 3 h"). Distance to each tick is
// SOG × time, drawn straight along course-over-ground.
const PROJECTION_HOURS: ReadonlyArray<{ h: number; label: string }> = [
  { h: 0.5, label: '30 min' },
  { h: 1, label: '1 h' },
  { h: 3, label: '3 h' }
]
const PROJECTION_COLOR = 0xffcc33 // bright amber predictor (vs cyan wind arrow)
const TRACK_COLOR = 0x4dd2ff // bright cyan historic trail
// Screen-space line widths (px) — fat lines, constant thickness at any zoom.
const TRACK_WIDTH = 4
const PROJECTION_WIDTH = 3
// Projection dash pattern, in world metres along the line (it spans tens of km,
// so km-scale dashes give a handful of visible segments). Tunable.
const PROJECTION_DASH_M = 2500
const PROJECTION_GAP_M = 1800
// Below this speed a vessel is effectively stopped — no meaningful prediction.
const PROJECTION_MIN_SOG_KN = 0.5

// Minimal nav + track shapes the overlay needs (position + kinematics only),
// kept local so the story doesn't import the deploy's AIS types.
export interface SelectedVesselNav {
  latitude: number
  longitude: number
  courseOverGround: number | null
  speedOverGround: number | null
}
export interface TrackVertex {
  latitude: number
  longitude: number
}

// Fat (wide, optionally dashed) polyline through ECEF points, drawn as an
// always-on-top data overlay: depthTest off (so the ocean, haze and waves can't
// bury it) and a high renderOrder so it paints last; depthWrite off so it never
// occludes the scene. Width is screen-space px (constant at any zoom); dashes,
// when enabled, are measured in world metres along the line. Tracks/projections
// are local (regional), so drawing over the globe doesn't bleed through in
// practice.
function lineFromEcef(
  points: Vector3[],
  color: number,
  opacity: number,
  linewidth: number,
  dash?: { size: number; gap: number }
): Line2 {
  const positions: number[] = []
  for (const p of points) positions.push(p.x, p.y, p.z)
  const geometry = new LineGeometry()
  geometry.setPositions(positions)
  const material = new THREE.Line2NodeMaterial({
    color,
    linewidth,
    transparent: true,
    opacity,
    dashed: dash != null,
    ...(dash != null ? { dashSize: dash.size, gapSize: dash.gap } : {}),
    depthWrite: false,
    depthTest: false
  })
  const line = new Line2(geometry, material)
  // Dashing keys off cumulative segment length, which must be precomputed.
  if (dash != null) line.computeLineDistances()
  line.frustumCulled = false
  line.renderOrder = 10
  return line
}

// Dispose a built line's geometry + material when it is replaced or unmounted
// (these rebuild on every selection, so otherwise they would leak).
function useDisposableLine(line: Line2 | null): void {
  useEffect(
    () => () => {
      if (line == null) return
      line.geometry.dispose()
      const m = line.material
      if (Array.isArray(m)) {
        m.forEach(x => {
          x.dispose()
        })
      } else m.dispose()
    },
    [line]
  )
}

// Selected-vessel overlay: a NAIS-style forward dead-reckoning projection (amber
// line + 30 min/1 h/3 h ticks labelled with distance run) and the vessel's
// last-24h historic track (blue-white trail). Pure client geometry on the sea
// surface — no API beyond the track fetch the host passes in. Renders whenever a
// vessel is selected, independent of the marker LOD (so it persists on descent).
const SelectedVesselOverlay: FC<{
  nav: SelectedVesselNav
  track: TrackVertex[]
  // Overlay visibility, toggled from the AIS panel (default on).
  showProjection?: boolean
  showTrack?: boolean
}> = ({ nav, track, showProjection = true, showTrack = true }) => {
  const projection = useMemo(() => {
    if (!showProjection) return null
    const { courseOverGround: cog, speedOverGround: sog } = nav
    if (cog == null || sog == null || sog < PROJECTION_MIN_SOG_KN) return null
    // Anchor at sea level; offset along the COG bearing in the local tangent
    // frame, then reproject each tick back onto the surface (so the line hugs
    // the globe) and lift it clear of the waves.
    const anchor = new Geodetic(
      radians(nav.longitude),
      radians(nav.latitude),
      0
    ).toECEF()
    const { east, north } = enuBasis(anchor)
    const bearing = bearingVector(cog, east, north)
    const g = new Geodetic()
    const ticks = PROJECTION_HOURS.map(({ h, label }) => {
      const distNm = sog * h
      const offset = anchor
        .clone()
        .addScaledVector(bearing, distNm * KNOTS_TO_M)
      g.setFromECEF(offset)
      g.height = OVERLAY_LIFT_M
      return { ecef: g.toECEF(), label, distNm }
    })
    const start = new Geodetic(
      radians(nav.longitude),
      radians(nav.latitude),
      OVERLAY_LIFT_M
    ).toECEF()
    const line = lineFromEcef(
      [start, ...ticks.map(t => t.ecef)],
      PROJECTION_COLOR,
      1,
      PROJECTION_WIDTH,
      { size: PROJECTION_DASH_M, gap: PROJECTION_GAP_M }
    )
    return { line, ticks }
  }, [nav, showProjection])

  const trackLine = useMemo(() => {
    if (!showTrack || track.length < 2) return null
    return lineFromEcef(
      track.map(p =>
        new Geodetic(
          radians(p.longitude),
          radians(p.latitude),
          OVERLAY_LIFT_M
        ).toECEF()
      ),
      TRACK_COLOR,
      0.9,
      TRACK_WIDTH
    )
  }, [track, showTrack])

  useDisposableLine(projection?.line ?? null)
  useDisposableLine(trackLine)

  return (
    <>
      {trackLine != null && (
        // Keyed by uuid so a new line on re-selection remounts the primitive
        // (R3F doesn't reliably swap a changed `object` prop in place).
        <primitive key={trackLine.uuid} object={trackLine} />
      )}
      {projection != null && (
        <>
          <primitive key={projection.line.uuid} object={projection.line} />
          {projection.ticks.map(t => (
            <Html
              key={t.label}
              position={t.ecef}
              center
              zIndexRange={[3, 0]}
              style={{ pointerEvents: 'none', userSelect: 'none' }}
            >
              <div
                style={{
                  transform: 'translateY(-50%)',
                  fontFamily:
                    "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
                  fontSize: 9,
                  lineHeight: 1,
                  whiteSpace: 'nowrap',
                  color: '#ffe9b0',
                  textShadow: '0 0 3px rgba(0,0,0,0.85)'
                }}
              >
                {t.label} · {t.distNm.toFixed(1)} nm
              </div>
            </Html>
          ))}
        </>
      )}
    </>
  )
}

// Keeps the camera from dropping below the 3D terrain tiles. Rendered as a
// child of <TilesRenderer> so it can read the tile group from context and
// raycast it. Only LAND (terrain standing above sea level) acts as a floor —
// over open ocean the tile sits at sea level, so the camera is free to descend
// into the water. The IFFT ocean is a separate object and never raycast here.
const _clampRay = new THREE.Raycaster()
// Bridges the TilesRenderer context out to scene code that lives OUTSIDE the
// <TilesRenderer> subtree (cable floor raycasts need the tiles group, and a
// re-sample signal whenever streaming changes the raycastable surface — the
// cables' coverage lock decides whether that actually re-bakes anything).
const TilesTerrainBridge: FC<{
  onTerrain: (group: Object3D | null) => void
  onLoadEnd: () => void
}> = ({ onTerrain, onLoadEnd }) => {
  const tiles = useContext(TilesRendererContext) as any
  useEffect(() => {
    if (tiles == null) return
    onTerrain(tiles.group ?? null)
    tiles.addEventListener('tiles-load-end', onLoadEnd)
    return () => {
      tiles.removeEventListener('tiles-load-end', onLoadEnd)
      onTerrain(null)
    }
  }, [tiles, onTerrain, onLoadEnd])
  return null
}

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
  // Subsea inter-array cables fanning from the turbine bases to a hub. null
  // hides them. Baked by TurbineCables onto raycast-sampled terrain floors
  // (coverage-locked — see TurbineCables header), flat fallback elsewhere.
  cables?: {
    connectionPoint: Vector3
    seabedDepth: number
    slack: number
    radius: number
    terrain: Object3D | null
    terrainVersion: number
    maxFloorY: number
    baked: CableBakeSnapshot | null
    rebakeNonce: number
    onBake: (snapshot: CableBakeSnapshot) => void
  } | null
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
  heroCover,
  cables
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
    // Turbine-free site (count 0): no slots, no hero — heroPos null keeps the
    // camera focus null (surface target) instead of crashing on positions[0].
    const heroPos =
      count > 0
        ? new Vector3().fromArray(positions[centreSlotIndex(count, stagger)])
        : null
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

  // Base positions as Vector3[] for the cable router — memoised so the (one-off)
  // Verlet cable bake only re-runs when the layout actually changes.
  const baseVectors = useMemo(
    () => layout.positions.map(p => new Vector3().fromArray(p)),
    [layout]
  )

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
    if (heroHubLocal == null || layout.heroPos == null) return null
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
      {cables != null && (
        <TurbineCables
          bases={baseVectors}
          connectionPoint={cables.connectionPoint}
          target={target}
          seabedDepth={cables.seabedDepth}
          slack={cables.slack}
          radius={cables.radius}
          terrain={cables.terrain}
          terrainVersion={cables.terrainVersion}
          maxFloorY={cables.maxFloorY}
          baked={cables.baked}
          rebakeNonce={cables.rebakeNonce}
          onBake={cables.onBake}
        />
      )}
    </>
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
  //     Scenario viewpoints additionally carry an aim height (also unlocks
  //     close landings at turbine-free sites) and a landing heading/pitch.
  //     aimOffsetENU is a CAMERA-ONLY aim displacement (m, [east, north, up])
  //     from the location target: the location (and the farm/cables pinned to
  //     it) stays put while the camera flies to e.g. the ship or underwater.
  //   autoRotate / zoomDistance: override the leva autoOrbit / orbit distance.
  //   wingsEnabled: master on/off for rotor spin (lerps to a halt).
  flyTo?: {
    longitude: number
    latitude: number
    name: string
    height?: number
    aimOffsetENU?: [number, number, number]
    // Target orbit distance for this fly (owned by the fly animation, NOT the
    // zoom slider — so it can't race the slider-ease into a pre-fly snap).
    distance?: number
    headingDeg?: number
    pitchDeg?: number
    // Gentle recenter: ease the orbit centre at the CURRENT distance, no
    // great-circle pull-out arc (clicking a globe marker — already pulled back).
    gentle?: boolean
  } | null
  // 'orbit' (default): OrbitControls + CameraRig fly-tos. 'fps': free-fly
  // first-person rig (WASD + drag look); OrbitControls and the rig are
  // suspended, and the camera teleports to `fpsSpawn`.
  cameraMode?: 'orbit' | 'fps'
  // First-person spawn pose. offsetENU displaces from the lon/lat/height
  // point (scenario-anchor-relative spawns). `platform` (a registry id:
  // 'ship' | 'patrolship' | 'platform') instead spawns offsetENU-relative to
  // that structure's LIVE deck frame (and the FPS rig rides its buoyancy
  // motion while you stand on it). Bump `nonce` to force a respawn at an
  // unchanged pose.
  fpsSpawn?: {
    longitude: number
    latitude: number
    height?: number
    offsetENU?: [number, number, number]
    platform?: string
    headingDeg?: number
    pitchDeg?: number
    nonce?: number
  } | null
  // Live vessel positions for the globe-overview marker layers (red shadow
  // fleet, blue Coast Guard / Navy patrol). Host-supplied from AIS; the scene
  // shows them only at a pulled-back view.
  shadowFleetVessels?: VesselMarker[]
  patrolVessels?: VesselMarker[]
  // Marker click → host opens the full vessel callout; selectedVesselId
  // highlights. Selection is shared across both layers (one id).
  onVesselSelect?: (id: string) => void
  selectedVesselId?: string | null
  // Selected vessel's live nav + last-24h track, for the forward-projection and
  // historic-trail overlay. Null when nothing is selected.
  selectedVesselNav?: SelectedVesselNav | null
  trackPoints?: TrackVertex[]
  // Overlay visibility, toggled from the AIS panel (default on when omitted).
  showProjection?: boolean
  showTrack?: boolean
  autoRotate?: boolean
  zoomDistance?: number
  // Live orbit distance reported back each frame when the camera is at rest, so
  // the deploy's zoom slider tracks mouse-wheel zoom. Additive; Storybook omits.
  onZoomChange?: (distance: number) => void
  // Globe-overview LOD reported to the host so its AIS panel swaps in lockstep
  // with the markers (both read this one boolean). Additive; Storybook omits.
  onOverviewChange?: (overview: boolean) => void
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
  cameraMode,
  fpsSpawn,
  shadowFleetVessels,
  patrolVessels,
  onVesselSelect,
  selectedVesselId,
  selectedVesselNav,
  trackPoints,
  showProjection,
  showTrack,
  autoRotate,
  zoomDistance,
  onZoomChange,
  onOverviewChange,
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

  // Globe-overview LOD, computed once here from the camera altitude. Drives both
  // marker layers (the `visible` prop) and — reported to the host — its AIS panel
  // swap, so they transition on exactly the same boolean.
  const overview = useOverviewLOD()
  useEffect(() => {
    onOverviewChange?.(overview)
  }, [overview, onOverviewChange])

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

  // Report the human name for Custom positions commanded by a fly-to (scenario
  // viewpoints) so the HUD shows the scenario, not 'Custom'.
  useEffect(() => {
    onLocationChange?.(
      activeLocation.longitude,
      activeLocation.latitude,
      locationControls.preset === 'Custom' && flyTo != null
        ? flyTo.name
        : String(locationControls.preset)
    )
  }, [
    onLocationChange,
    activeLocation.longitude,
    activeLocation.latitude,
    locationControls.preset,
    flyTo
  ])

  // Deploy POI fly-to: push the requested location into the leva Location
  // control, which moves `target` and triggers the CameraRig fly animation.
  // Scenario viewpoints land at non-preset positions: Custom lon/lat plus the
  // viewpoint's aim height (default 20 = sea level, matching the presets).
  useEffect(() => {
    if (flyTo == null) return
    if (Object.prototype.hasOwnProperty.call(locationPresets, flyTo.name)) {
      setLocation({ preset: flyTo.name })
    } else {
      setLocation({
        preset: 'Custom',
        longitude: flyTo.longitude,
        latitude: flyTo.latitude,
        height: flyTo.height ?? 20
      })
    }
  }, [flyTo, setLocation])

  // Camera-only aim for same-site viewpoints (ship, underwater): the location
  // target stays pinned; only the rig's destination moves by the ENU offset.
  const flyAim = useMemo(() => {
    if (flyTo?.aimOffsetENU == null) return null
    const [e, n, u] = flyTo.aimOffsetENU
    const { east, north, up } = enuBasis(target)
    return target
      .clone()
      .addScaledVector(east, e)
      .addScaledVector(north, n)
      .addScaledVector(up, u)
  }, [flyTo, target])

  // First-person spawn pose in ECEF (FpsRig). Geodetic point + optional ENU
  // displacement, mirroring the flyAim resolution. Platform spawns ('ship')
  // resolve against the live deck frame inside FpsRig instead — the ship's
  // position is leva-tunable and heaves, so a precomputed point would be stale.
  const fpsSpawnPose = useMemo(() => {
    if (fpsSpawn == null) return null
    const headingDeg = fpsSpawn.headingDeg ?? 0
    const pitchDeg = fpsSpawn.pitchDeg ?? 0
    const nonce = fpsSpawn.nonce ?? 0
    if (fpsSpawn.platform != null) {
      return {
        position: null,
        platformId: fpsSpawn.platform,
        platformOffsetENU:
          fpsSpawn.offsetENU ?? ([0, 0, 10] as [number, number, number]),
        headingDeg,
        pitchDeg,
        nonce
      }
    }
    let position = new Geodetic(
      radians(fpsSpawn.longitude),
      radians(fpsSpawn.latitude),
      fpsSpawn.height ?? 20
    ).toECEF()
    if (fpsSpawn.offsetENU != null) {
      const [e, n, u] = fpsSpawn.offsetENU
      const { east, north, up } = enuBasis(position)
      position = position
        .addScaledVector(east, e)
        .addScaledVector(north, n)
        .addScaledVector(up, u)
    }
    return { position, headingDeg, pitchDeg, nonce }
  }, [fpsSpawn])

  // Live deck frames of the rideable structures (buoyancy-animated groups)
  // for the FPS rig, keyed by platform id. Setters memoised once — a fresh
  // identity per render would re-fire every ShipModel's onGroup effect.
  const [fpsPlatforms, setFpsPlatforms] = useState<
    Record<string, Object3D | null>
  >({})
  const platformSetters = useMemo(() => {
    const setters = {} as Record<
      FpsPlatformId,
      (group: Object3D | null) => void
    >
    for (const id of FPS_PLATFORM_IDS) {
      setters[id] = (group: Object3D | null): void => {
        setFpsPlatforms(platforms => ({ ...platforms, [id]: group }))
      }
    }
    return setters
  }, [])

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
    opacity: { value: 0.24, min: 0, max: 1, step: 0.01 },
    coverage: { value: 0.71, min: 0, max: 1, step: 0.01 },
    windSpeed: { value: 0.004, min: 0, max: 0.05, step: 0.001 },
    tiles: { value: 69, min: 1, max: 100, step: 1 },
    dayColor: '#ffffff',
    nightAmbient: { value: 0.03, min: 0, max: 0.5, step: 0.01 },
    density: { value: 0, min: 0, max: 1, step: 0.01 },
    intensity: { value: 2.5, min: 0, max: 6, step: 0.1 },
    contrast: { value: 1.3, min: 0.5, max: 5, step: 0.1 },
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

  // Ocean-local frame, shared by OceanSurface (chunk parent transform) and the
  // ship buoyancy probes (world → wave-field XZ via its inverse). Re-anchors
  // with the fly-to target, exactly like the rendered ocean does.
  const oceanMatrix = useMemo(
    () =>
      computeOceanMatrix(
        target,
        oceanFrameControls.seaLevelOffset,
        oceanFrameControls.oceanScale
      ),
    [target, oceanFrameControls.seaLevelOffset, oceanFrameControls.oceanScale]
  )
  // Inverse memoized once — ship probes and the underwater detection both
  // need it, and the matrix only changes on fly-to / leva edits.
  const oceanMatrixInverse = useMemo(
    () => oceanMatrix.clone().invert(),
    [oceanMatrix]
  )

  // ── Underwater post effect state ─────────────────────────────────────────
  // Camera submersion is detected on the CPU each frame (ocean-local camera Y
  // vs the Gerstner surface height — same sampler the ships use). The post
  // node reconstructs each pixel's position CAMERA-RELATIVE (view space) and
  // maps it to the ocean frame via viewToOcean, composed on the CPU in double
  // precision — going through float32 world space at ECEF magnitude would
  // jitter the caustics UVs by ~1 m.
  const underwaterUniforms = useMemo(() => createUnderwaterUniforms(), [])
  const viewToOceanUniform = useMemo(() => uniform(new Matrix4()), [])
  const underwaterTimeUniform = useMemo(() => uniform(0), [])
  const uwScratch = useMemo(
    () => ({
      p: new Vector3(),
      disp: new Vector3(),
      // Hysteresis + smoothing state. The Gerstner estimate misses the IFFT
      // cascade component (±~1 m), so a raw zero-crossing strobes the fog
      // on/off near the surface. Enter submerged 0.35 m below the estimate,
      // leave at 0.05 m, and ease underwaterT over ~0.2 s.
      submerged: false,
      t: 0,
    }),
    []
  )
  useFrame((_, delta) => {
    underwaterTimeUniform.value += delta
    camera.updateMatrixWorld()
    viewToOceanUniform.value.multiplyMatrices(
      oceanMatrixInverse,
      camera.matrixWorld
    )

    camera.getWorldPosition(uwScratch.p)
    uwScratch.p.applyMatrix4(oceanMatrixInverse)
    let surfaceY = 0
    if (vertexUniforms != null && oceanUniforms != null) {
      surfaceY = sampleGerstnerUniformsCPU(
        uwScratch.p.x,
        uwScratch.p.z,
        vertexUniforms,
        oceanUniforms.gerstnerAmplitude.value,
        uwScratch.disp
      ).y
    }
    const depthBelow = surfaceY - uwScratch.p.y
    // The planar depth test (height above the target's tangent plane) is only
    // valid near the surface. Far out — e.g. planetary zoom — orbiting below
    // that infinite plane reads as "deep underwater" and fades the post to
    // black. Gate it by true altitude (generous vs any real diving view).
    const camAltitude = camera.position.length() - target.length()
    if (camAltitude > 500) {
      uwScratch.submerged = false
    } else if (uwScratch.submerged) {
      if (depthBelow < 0.05) uwScratch.submerged = false
    } else if (depthBelow > 0.35) {
      uwScratch.submerged = true
    }
    uwScratch.t = MathUtils.damp(
      uwScratch.t,
      uwScratch.submerged ? 1 : 0,
      5, // lambda = 1 / 0.2 s
      delta
    )
    underwaterUniforms.underwaterT.value = uwScratch.t
    underwaterUniforms.cameraDepthBelow.value = Math.max(depthBelow, 0)
  })

  // Default values come from UNDERWATER_DEFAULTS (single source of truth in
  // the package) — leva only contributes ranges/labels.
  const underwaterControls = useControls('Underwater', {
    enabled: { value: true },
    murkiness: {
      value: UNDERWATER_DEFAULTS.absorptionScale,
      min: 0.05,
      max: 5,
      step: 0.05,
      label: 'Murkiness',
    },
    waterTint: { value: UNDERWATER_DEFAULTS.waterTint, label: 'Water tint' },
    fogIntensity: {
      value: UNDERWATER_DEFAULTS.fogIntensity,
      min: 0,
      max: 10,
      step: 0.1,
      label: 'Fog intensity',
    },
    ambientFalloff: {
      value: UNDERWATER_DEFAULTS.ambientFalloff,
      min: 0,
      max: 0.2,
      step: 0.005,
      label: 'Depth darkening',
    },
    causticsIntensity: {
      value: UNDERWATER_DEFAULTS.causticsIntensity,
      min: 0,
      max: 5,
      step: 0.05,
    },
    causticsScale: {
      value: UNDERWATER_DEFAULTS.causticsScale,
      min: 1,
      max: 300,
      step: 1,
    },
    causticsSpeed: {
      value: UNDERWATER_DEFAULTS.causticsSpeed,
      min: 0,
      max: 3,
      step: 0.05,
    },
    causticsSharpness: {
      value: UNDERWATER_DEFAULTS.causticsSharpness,
      min: 1,
      max: 16,
      step: 0.5,
    },
  })
  useEffect(() => {
    const u = underwaterUniforms
    u.enabled.value = underwaterControls.enabled ? 1 : 0
    u.absorptionScale.value = underwaterControls.murkiness
    const tint = new Color().setStyle(underwaterControls.waterTint)
    u.waterTint.value.set(tint.r, tint.g, tint.b)
    u.fogIntensity.value = underwaterControls.fogIntensity
    u.ambientFalloff.value = underwaterControls.ambientFalloff
    u.causticsIntensity.value = underwaterControls.causticsIntensity
    u.causticsScale.value = underwaterControls.causticsScale
    u.causticsSpeed.value = underwaterControls.causticsSpeed
    u.causticsSharpness.value = underwaterControls.causticsSharpness
  }, [underwaterControls, underwaterUniforms])

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
  // Per-scenario structures at their own sites: patrol ship off Bodø
  // (buoyant), production platform further out (static — no buoyancy).
  const patrolAnchor = useTargetECEF(
    locationPresets['Bodø'].longitude,
    locationPresets['Bodø'].latitude,
    locationPresets['Bodø'].height
  )
  const platformAnchor = useTargetECEF(
    locationPresets['Norwegian Sea'].longitude,
    locationPresets['Norwegian Sea'].latitude,
    locationPresets['Norwegian Sea'].height
  )
  const ship0 = useShip(SHIP_DEFS[0], shipAnchor, orbitControlsRef)
  const ship1 = useShip(SHIP_DEFS[1], shipAnchor, orbitControlsRef)
  const ship2 = useShip(SHIP_DEFS[2], patrolAnchor, orbitControlsRef)
  const ship3 = useShip(SHIP_DEFS[3], platformAnchor, orbitControlsRef)
  // platformId keys the FPS deck-spawn/ride registry; buoyant=false pins the
  // structure to its rest pose (platforms don't heave).
  const ships: Array<{
    url: string
    controls: typeof ship0.controls
    anchor: Vector3
    platformId?: FpsPlatformId
    buoyant: boolean
    waterOcclusion: boolean
  }> = [
    {
      url: SHIP_DEFS[0].url,
      controls: ship0.controls,
      anchor: shipAnchor,
      platformId: 'ship',
      buoyant: true,
      waterOcclusion: true
    },
    {
      url: SHIP_DEFS[1].url,
      controls: ship1.controls,
      anchor: shipAnchor,
      buoyant: true,
      waterOcclusion: true
    },
    {
      url: SHIP_DEFS[2].url,
      controls: ship2.controls,
      anchor: patrolAnchor,
      platformId: 'patrolship',
      buoyant: true,
      waterOcclusion: true
    },
    {
      url: SHIP_DEFS[3].url,
      controls: ship3.controls,
      anchor: platformAnchor,
      platformId: 'platform',
      buoyant: false,
      waterOcclusion: false
    },
  ]

  // Shared buoyancy + hull-occlusion rig for both ships. Motion amplitude
  // follows the Wind→Waves storm blending automatically because ShipModel
  // reads the live gerstnerAmplitude uniform every frame.
  const shipMotionControls: ShipMotionControls = useControls('Ship motion', {
    enabled: { value: true },
    heaveGain: { value: 1, min: 0, max: 3, step: 0.05, label: 'Heave gain' },
    tiltGain: { value: 2, min: 0, max: 8, step: 0.1, label: 'Tilt gain' },
    response: {
      value: 1.5,
      min: 0.1,
      max: 5,
      step: 0.05,
      label: 'Response (s)',
    },
    hullOcclusion: { value: true, label: 'Hull occlusion' },
    showOccluders: { value: false, label: 'Show occluder boxes' },
    occLengthFrac: {
      value: 0.75,
      min: 0.1,
      max: 1,
      step: 0.01,
      label: 'Occluder length',
    },
    occWidthFrac: {
      value: 0.8,
      min: 0.1,
      max: 1,
      step: 0.01,
      label: 'Occluder width',
    },
    occTopFrac: {
      value: 0.3,
      min: 0.02,
      max: 1,
      step: 0.01,
      label: 'Occluder height',
    },
  })

  // Auto-routed subsea inter-array cables — every turbine string runs to a hub
  // (Ship 1, the substation vessel). Baked once; see TurbineCables.
  const cableControls = useControls('Cables', {
    enabled: { value: true },
    // Fallback floor only — where terrain raycasts have coverage, the
    // cables drape onto the sampled tile surface instead.
    seabedDepth: { value: 35, min: -100, max: 200, step: 1, label: 'Seabed depth (m)' },
    slack: { value: 0.3, min: 0, max: 0.5, step: 0.01 },
    radius: { value: 0.7, min: 0.1, max: 10, step: 0.1, label: 'Radius (m)' },
  })
  // Latest LIVE bake snapshot (ref — onBake fires during render). The button
  // emits a ready-to-paste cable-bake.ts so production loads skip the solve.
  const latestCableBakeRef = useRef<CableBakeSnapshot | null>(null)
  const handleCableBake = useCallback((snapshot: CableBakeSnapshot) => {
    latestCableBakeRef.current = snapshot
  }, [])
  const [cableRebakeNonce, setCableRebakeNonce] = useState(0)
  useControls('Cables', {
    // Clears the converged bake and solves fresh against the CURRENT tiles —
    // use after the terrain has visibly finished loading.
    Rebake: button(() => {
      setCableRebakeNonce(v => v + 1)
    }),
    'Copy bake': button(() => {
      const snapshot = latestCableBakeRef.current
      if (snapshot == null) {
        console.warn('[TurbineCables] no live bake to copy yet (snapshot in use or still solving)')
        return
      }
      const file =
        "// Committed cable-bake snapshot for TurbineCables. When the snapshot's sig\n" +
        '// matches the live scene inputs, cables load instantly from these node paths\n' +
        '// (no terrain raycasts, no Verlet solve, no tile-streaming wait). Regenerate:\n' +
        '// let the scene bake (console shows coverage converging), click the Cables\n' +
        "// leva folder's 'Copy bake' button, and paste the clipboard over this file.\n" +
        '\n' +
        "import type { CableBakeSnapshot } from './TurbineCables'\n" +
        '\n' +
        'export const CABLE_BAKE: CableBakeSnapshot | null =\n  ' +
        JSON.stringify(snapshot) +
        '\n'
      console.log(file)
      void navigator.clipboard?.writeText(file)
    }),
  })
  // Terrain handle + re-sample counter from the TilesTerrainBridge. The
  // cables' coverage lock turns most of these signals into no-ops.
  const [cableTerrain, setCableTerrain] = useState<Object3D | null>(null)
  const [cableTerrainVersion, setCableTerrainVersion] = useState(0)
  const handleCableTerrainLoadEnd = useCallback(() => {
    setCableTerrainVersion(v => v + 1)
  }, [])
  const cables = useMemo(
    () =>
      cableControls.enabled && !disableOcean
        ? {
            connectionPoint: ship0.worldPos,
            seabedDepth: cableControls.seabedDepth,
            slack: cableControls.slack,
            radius: cableControls.radius,
            terrain: cableTerrain,
            terrainVersion: cableTerrainVersion,
            baked: CABLE_BAKE,
            rebakeNonce: cableRebakeNonce,
            onBake: handleCableBake,
            // Sampled floors are clamped under the rendered ocean surface —
            // offshore photogrammetry bakes the sea itself as geometry.
            maxFloorY: oceanFrameControls.seaLevelOffset - 3,
          }
        : null,
    [
      cableControls.enabled,
      cableControls.seabedDepth,
      cableControls.slack,
      cableControls.radius,
      ship0.worldPos,
      cableTerrain,
      cableTerrainVersion,
      oceanFrameControls.seaLevelOffset,
      handleCableBake,
      cableRebakeNonce,
      disableOcean,
    ]
  )

  const cameraControls = useControls('Camera', {
    minDistance: { value: 1, min: 0.1, max: 5000, step: 0.1 },
    // 30,000 km lets the camera pull back to a planetary full-disk view (earth
    // radius ~6,371 km); the deploy's zoom slider maps to this same ceiling.
    maxDistance: { value: 30_000_000, min: 1000, max: 50_000_000, step: 100_000 },
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
    // Underwater fog + caustics between aerial perspective and lens flare —
    // the flare reads the fogged scene, so the sun flare dims naturally when
    // submerged. Depth → view-space position uses the SAME log-depth path as
    // AerialPerspectiveNode (renderer runs logarithmicDepthBuffer at globe
    // scale); ocean-frame mapping stays camera-relative for f32 precision.
    const uwViewZ = depthToViewZ(
      depthNode.r,
      cameraNear(camera),
      cameraFar(camera),
      { perspective: true, logarithmic: true }
    )
    const uwPosView = screenToPositionView(
      uv(),
      depthNode.r,
      uwViewZ,
      projectionMatrix(camera),
      inverseProjectionMatrix(camera)
    )
    const underwaterNode = underwaterPostNode({
      inputNode: aerialNode,
      oceanPos: viewToOceanUniform.mul(vec4(uwPosView, 1)).xyz,
      dist: uwPosView.length(),
      time: underwaterTimeUniform,
      u: underwaterUniforms,
    })

    const lensFlareNode = lensFlare(underwaterNode)
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
    underwaterUniforms,
    viewToOceanUniform,
    underwaterTimeUniform,
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
        // Wheel/pinch dolly is undamped in OrbitControls (hard stop). The
        // CameraRig handles scroll zoom through its damped distance ease instead.
        enableZoom={false}
        enabled={cameraMode !== 'fps'}
        minDistance={cameraControls.minDistance}
        maxDistance={cameraControls.maxDistance}
        autoRotate={cameraMode !== 'fps' && (autoRotate ?? cameraControls.autoOrbit)}
        autoRotateSpeed={cameraControls.orbitSpeed}
      />
      {/* Unmounted entirely in FPS mode so its placement/fly logic can't fight
          the free-fly rig; remounting re-frames the site on return to orbit. */}
      {cameraMode !== 'fps' && (
        <CameraRig
          target={target}
          focus={heroFocus}
          aim={flyAim}
          zoomDistance={zoomDistance}
          flyDistance={flyTo?.distance}
          headingDeg={flyTo?.headingDeg}
          pitchDeg={flyTo?.pitchDeg}
          landExact={flyTo?.height != null}
          gentleRecenter={flyTo?.gentle === true}
          onDistance={onZoomChange}
        />
      )}
      <FpsRig
        active={cameraMode === 'fps'}
        spawn={fpsSpawnPose}
        platforms={fpsPlatforms}
      />
      {shadowFleetVessels != null && shadowFleetVessels.length > 0 && (
        <VesselMarkers
          vessels={shadowFleetVessels}
          color={SHADOW_MARKER_COLOR}
          onSelect={onVesselSelect}
          selectedId={selectedVesselId}
          visible={overview}
        />
      )}
      {patrolVessels != null && patrolVessels.length > 0 && (
        <VesselMarkers
          vessels={patrolVessels}
          color={PATROL_MARKER_COLOR}
          onSelect={onVesselSelect}
          selectedId={selectedVesselId}
          visible={overview}
        />
      )}
      {selectedVesselNav != null && (
        <SelectedVesselOverlay
          nav={selectedVesselNav}
          track={trackPoints ?? []}
          showProjection={showProjection}
          showTrack={showTrack}
        />
      )}
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
        cables={cables}
      />
      {/* Karmøy ship. Gated behind the ocean stage (so its ~7.7 MB
          download/parse doesn't compete with the stage-1 atmosphere-LUT
          compute) and isolated in its own Suspense so loading can't blank the
          rest of the scene. */}
      {ships.map(
        ({ url, controls, anchor, platformId, buoyant, waterOcclusion }) =>
          controls.visible &&
          !disableOcean && (
            <Suspense key={url} fallback={null}>
              <ShipModel
                url={url}
                anchor={anchor}
                scale={controls.scale}
                heightOffset={controls.heightOffset}
                eastOffset={controls.eastOffset}
                northOffset={controls.northOffset}
                yawDeg={controls.yawDeg}
                oceanMatrixInverse={oceanMatrixInverse}
                vu={vertexUniforms}
                gerstnerAmplitude={oceanUniforms?.gerstnerAmplitude ?? null}
                // Static structures (platform) keep their rest pose.
                motion={
                  buoyant
                    ? shipMotionControls
                    : { ...shipMotionControls, enabled: false }
                }
                waterOcclusion={waterOcclusion}
                // Deck-capable structures register as FPS spawn/ride platforms.
                onGroup={
                  platformId != null ? platformSetters[platformId] : undefined
                }
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
        <TilesTerrainBridge
          onTerrain={setCableTerrain}
          onLoadEnd={handleCableTerrainLoadEnd}
        />
      </TilesRenderer>
      {oceanDebugParams.enableOcean && !disableOcean && (
        <OceanSurface
          matrix={oceanMatrix}
          atmosphereContext={context}
          envCubeTexture={(envNode as any).renderTarget.texture}
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
          // Compose modelViewMatrix on the CPU (f64) instead of in-shader. The
          // node default multiplies cameraViewMatrix × modelWorldMatrix on the
          // GPU in f32 — at ECEF magnitude (~6.4e6 m translations in BOTH)
          // that cancels catastrophically and static geometry visibly jitters
          // (~0.4 m) as the camera moves; thin meshes like cables show it worst.
          r.highPrecision = true
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
