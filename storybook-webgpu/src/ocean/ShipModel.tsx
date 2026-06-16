// Ship rendering + buoyancy for the globe ocean scene: a GLB anchored on the
// ENU tangent plane that rides the Gerstner waves (4-probe heave/roll/pitch
// with exp-smoothed hull inertia) and carries an invisible hull water-occluder
// box for the depth pre-pass. Also exports the per-ship leva rig (useShip) and
// the ship definitions. Extracted from GlobeWaterproOcean-Story (wiring stays there).

import { useFrame } from '@react-three/fiber'
import { button, useControls } from 'leva'
import { useEffect, useMemo, useRef, type FC } from 'react'
import {
  Box3,
  BoxGeometry,
  MathUtils,
  Matrix4,
  Mesh,
  Quaternion,
  Vector3,
  type Group,
  type Material,
} from 'three'
import { MeshBasicNodeMaterial, type UniformNode } from 'three/webgpu'

import { sampleGerstnerUniformsCPU } from '../../../packages/ocean-ifft/src/ocean/gerstner-cpu'
import { useGLTF } from '../hooks/useGLTF'
import { enuBasis } from './enu'
import {
  WATER_OCCLUDER_KEY,
  type VertexUniformsBag,
} from './OceanChunksWaterpro'

// Shared 'Ship motion' leva values driving every ShipModel's buoyancy rig +
// hull water occluder. Lives at the scene level (one folder, both ships).
export interface ShipMotionControls {
  enabled: boolean
  heaveGain: number
  tiltGain: number
  response: number
  hullOcclusion: boolean
  showOccluders: boolean
  occLengthFrac: number
  occWidthFrac: number
  occTopFrac: number
}

export interface ShipDef {
  folder: string
  url: string
  scale: number
  heightOffset: number
  eastOffset: number
  northOffset: number
  // Initial yaw (°) for the leva default; omitted → 0. Lets a static structure
  // bake its captured orientation (e.g. the land site).
  yawDeg?: number
}

export const SHIP_DEFS: ShipDef[] = [
  {
    folder: 'Ship',
    url: 'public/ship_large_compressed.glb',
    scale: 0.35,
    heightOffset: 26.9,
    eastOffset: 0,
    northOffset: 0,
    yawDeg: -104,
  },
  {
    folder: 'Ship 2',
    url: 'public/ship_supply_compressed.glb',
    scale: 0.35,
    heightOffset: 28.3,
    eastOffset: -10,
    northOffset: -20,
    yawDeg: 94,
  },
  // Patrol ship outside Bodø (own scenario; anchored at the Bodø preset).
  {
    folder: 'Patrol ship',
    url: 'public/patrolship-compressed.glb',
    scale: 1,
    heightOffset: 26,
    eastOffset: 0,
    northOffset: 0,
  },
  // Offshore platform in the Norwegian Sea (own scenario; static — no
  // buoyancy, the caller passes motion disabled). scale/waterline carried over
  // from the prior platform model — verify they fit the deepwater model.
  {
    folder: 'Platform',
    url: 'public/deepwater_platform_compressed.glb',
    scale: 1,
    heightOffset: 26,
    eastOffset: 0,
    northOffset: 0,
  },
  // Waste-handling facility on/near Karmøy island (waste-handling scenario;
  // static — no buoyancy). On LAND; offsets/height/yaw captured in-scene via the
  // leva 'Waste site' folder and baked here (the scene doesn't raycast ground
  // height — the offset is applied along the ECEF up). Tune further there.
  {
    folder: 'Waste site',
    url: 'public/site_compressed.glb',
    scale: 1,
    heightOffset: 67.4,
    eastOffset: -50,
    northOffset: 40,
    yawDeg: -30,
  },
]

// One ship's debug rig: a leva folder (visibility, scale, waterline, east/north
// offset, yaw) + a "Fly to ship" button that snaps the orbit camera to frame
// the hull. The ship is pinned to a fixed geodetic anchor; its ENU world
// position is held in a ref so the (once-captured) button reads live offsets.
// Returns the live controls; the caller mounts <ShipModel> from def.url.
export function useShip(
  def: ShipDef,
  anchor: Vector3,
  orbitControlsRef: { current: any }
): {
  controls: {
    visible: boolean
    scale: number
    heightOffset: number
    eastOffset: number
    northOffset: number
    yawDeg: number
  }
  // Reactive ECEF hull position (changes identity on offset edits) — for the
  // cable hub. The fly-to button instead reads a live ref (leva captures once).
  worldPos: Vector3
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
    yawDeg: {
      value: def.yawDeg ?? 0,
      min: -180,
      max: 180,
      step: 1,
      label: 'Yaw (°)',
    },
  })
  const worldPos = useMemo(() => {
    const { east, north, up } = enuBasis(anchor)
    return anchor
      .clone()
      .addScaledVector(east, controls.eastOffset)
      .addScaledVector(north, controls.northOffset)
      .addScaledVector(up, controls.heightOffset)
  }, [anchor, controls.eastOffset, controls.northOffset, controls.heightOffset])
  // Mirror the latest position into a ref so the once-captured button reads it
  // live (the standard "latest value" ref pattern; not read during render).
  const worldRef = useRef(worldPos)
  worldRef.current = worldPos
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
  return { controls, worldPos }
}

// Single ship GLB anchored at a fixed geodetic point (Karmøy), placed on the
// local East-North-Up tangent plane with local +Y aligned to the surface
// normal — the same ENU placement math as TurbineFarm. A GLB's modelling
// origin rarely sits at the waterline or faces a useful heading, so scale,
// waterline height, east/north position and yaw are leva-tunable to seat the
// hull on the ocean. The caller gates this behind the ocean stage + Suspense
// (the model is ~7.7 MB, so it must not compete with stage-1 LUT compute).
//
// Buoyancy: four probes (bow/stern/port/starboard, spans from the GLB bbox)
// sample the CPU mirror of the vertex-stage Gerstner sum at the ship's
// ocean-local position. Mean height drives heave; the slope plane drives a
// roll/pitch tilt. Both are low-pass filtered (exp smoothing, `response`
// seconds) as cheap hull inertia. Tracks the Gerstner component only — the
// IFFT cascade displacement is GPU-only and intentionally ignored (perf).
export const ShipModel: FC<{
  url: string
  anchor: Vector3
  scale: number
  heightOffset: number
  eastOffset: number
  northOffset: number
  yawDeg: number
  /** Inverse of the ocean-local frame matrix — maps world → wave-field XZ.
   * Memoized by the caller (it only changes on fly-to / leva edits). */
  oceanMatrixInverse: Matrix4
  /** WGSL vertex-stage uniform bag — null until the ocean is mounted. */
  vu: VertexUniformsBag | null
  /** Live Gerstner amplitude (shared bag) — null until the ocean is mounted. */
  gerstnerAmplitude: UniformNode<number> | null
  motion: ShipMotionControls
  /** Whether this model should punch an invisible hull volume into the water
   * pre-pass. Ships need it; static above-water structures such as production
   * platforms do not. */
  waterOcclusion?: boolean
  /** Surfaces the buoyancy-animated group (the live deck frame) to the host —
   * the FPS rig rides it so a player standing on deck moves with the hull. */
  onGroup?: (group: Group | null) => void
}> = ({
  url,
  anchor,
  scale,
  heightOffset,
  eastOffset,
  northOffset,
  yawDeg,
  oceanMatrixInverse,
  vu,
  gerstnerAmplitude,
  motion,
  waterOcclusion = true,
  onGroup,
}) => {
  const gltf = useGLTF(url)
  const scene = useMemo(() => gltf.scene.clone(true), [gltf.scene])
  const groupRef = useRef<Group>(null)

  useEffect(() => {
    onGroup?.(groupRef.current)
    return () => {
      onGroup?.(null)
    }
  }, [onGroup])

  // Rest pose + world-frame probe axes. forward/starboard are the yawed ENU
  // directions of ship-local +Z/+X. The group transform is written every frame
  // by the buoyancy useFrame (all branches), so no position/quaternion props.
  const frame = useMemo(() => {
    const { east, north, up } = enuBasis(anchor)
    const yawQ = new Quaternion().setFromAxisAngle(
      new Vector3(0, 1, 0),
      MathUtils.degToRad(yawDeg)
    )
    const alignQ = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), up)
    const baseQ = alignQ.clone().multiply(yawQ)
    const basePos = anchor
      .clone()
      .addScaledVector(east, eastOffset)
      .addScaledVector(north, northOffset)
      .addScaledVector(up, heightOffset)
    const forward = new Vector3(0, 0, 1).applyQuaternion(baseQ)
    const starboard = new Vector3(1, 0, 0).applyQuaternion(baseQ)
    return { up, baseQ, basePos, forward, starboard }
  }, [anchor, heightOffset, eastOffset, northOffset, yawDeg])

  // Hull bounding box in GLB-local units (the group applies `scale`).
  const hull = useMemo(() => {
    const box = new Box3().setFromObject(scene)
    const size = box.getSize(new Vector3())
    const center = box.getCenter(new Vector3())
    return { size, center, minY: box.min.y, longIsZ: size.z >= size.x }
  }, [scene])

  // A GLB may carry its own occluder: a closed low-poly hull-interior volume
  // named 'WaterOccluder' (authored in Blender) that follows the hull taper
  // better than the fitted box. Flag it for the depth pre-pass (G=1) and hide it
  // from the color pass; when present, the box below is skipped.
  const hasGlbOccluder = useMemo(() => {
    let found = false
    scene.traverse(obj => {
      if (!/occluder/i.test(obj.name)) return
      // Flag the MESHES in the named subtree (the export often nests the mesh
      // under a group named 'WaterOccluder' — a child-of-a-child). Key off the
      // mesh, not the group: the pre-pass reads the key on the mesh AND walks
      // ancestor visibility, so the group must stay VISIBLE while each occluder
      // mesh is keyed + visible=false (the pre-pass flips it on just for the
      // depth pass; the color pass skips it). Hiding the group instead made the
      // ancestor walk drop the mesh — which is why occlusion did nothing.
      obj.traverse(o => {
        if ((o as Mesh).isMesh !== true) return
        o.userData[WATER_OCCLUDER_KEY] = true
        o.visible = false
        found = true
      })
    })
    return found
  }, [scene])

  // World-frame probe rig: longest bbox axis = hull length.
  const probes = useMemo(() => {
    const axisLong = hull.longIsZ ? frame.forward : frame.starboard
    const axisShort = hull.longIsZ ? frame.starboard : frame.forward
    const halfL = 0.5 * scale * (hull.longIsZ ? hull.size.z : hull.size.x)
    const halfW = 0.5 * scale * (hull.longIsZ ? hull.size.x : hull.size.z)
    return {
      axisLong,
      axisShort,
      halfL: Math.max(halfL, 1),
      halfW: Math.max(halfW, 1),
    }
  }, [hull, frame, scale])

  // Ocean-local probe coordinates — static between control edits, so computed
  // here instead of per frame (the wave field varies only in XZ; the per-frame
  // inputs to the height sample are just time/steepness/amplitude).
  const probePoints = useMemo(() => {
    const mk = (dir: Vector3, dist: number): Vector3 =>
      frame.basePos
        .clone()
        .addScaledVector(dir, dist)
        .applyMatrix4(oceanMatrixInverse)
    return {
      bow: mk(probes.axisLong, probes.halfL),
      stern: mk(probes.axisLong, -probes.halfL),
      stbd: mk(probes.axisShort, probes.halfW),
      port: mk(probes.axisShort, -probes.halfW),
    }
  }, [frame, probes, oceanMatrixInverse])

  // Invisible hull water-occluder volume. The depth pre-pass renders it with
  // the G=1 flag material; the water shader discards its surface behind it.
  // MUST stay inside the hull silhouette — a box poking outside the hull
  // punches a visible hole in the ocean — hence the inset fractions. A unit
  // box created once; leva slider edits only touch scale/position (no
  // geometry churn). The wireframe shows when 'Show occluder boxes' is on.
  //
  // FUTURE: a rectangular box can't follow hull taper at the bow — it either
  // pokes outside the silhouette or leaves the bow tip uncovered. If the box
  // fit proves inadequate, the planned upgrade is a named mask mesh authored
  // in Blender inside the ship GLB (closed low-poly interior volume named
  // 'WaterOccluder'): detect it here by name, flag it with WATER_OCCLUDER_KEY
  // + visible=false, and skip the box. No other code changes needed — the
  // pre-pass flags any mesh carrying the key (see OceanChunksWaterpro.tsx).
  const occluder = useMemo(() => {
    const mesh = new Mesh(
      new BoxGeometry(1, 1, 1),
      new MeshBasicNodeMaterial({ wireframe: true, color: 0xff3366 })
    )
    mesh.userData[WATER_OCCLUDER_KEY] = true
    return mesh
  }, [])
  useEffect(() => {
    return () => {
      occluder.geometry.dispose()
      ;(occluder.material as Material).dispose()
    }
  }, [occluder])
  useEffect(() => {
    const sx =
      hull.size.x * (hull.longIsZ ? motion.occWidthFrac : motion.occLengthFrac)
    const sz =
      hull.size.z * (hull.longIsZ ? motion.occLengthFrac : motion.occWidthFrac)
    const sy = Math.max(hull.size.y * motion.occTopFrac, 1e-3)
    occluder.scale.set(Math.max(sx, 1e-3), sy, Math.max(sz, 1e-3))
    occluder.position.set(hull.center.x, hull.minY + sy / 2, hull.center.z)
    occluder.visible = motion.showOccluders
  }, [
    occluder,
    hull,
    motion.occLengthFrac,
    motion.occWidthFrac,
    motion.occTopFrac,
    motion.showOccluders,
  ])

  // Per-frame buoyancy. Scratch objects + smoothing state persist per ship.
  const scratch = useMemo(
    () => ({ disp: new Vector3(), n: new Vector3(), tiltQ: new Quaternion() }),
    []
  )
  const smoothRef = useRef<{ heave: number; normal: Vector3 }>({
    heave: 0,
    normal: frame.up.clone(),
  })

  useFrame((_, delta) => {
    const group = groupRef.current
    if (group == null) return
    const { basePos, baseQ, up } = frame
    if (vu == null || gerstnerAmplitude == null || !motion.enabled) {
      group.position.copy(basePos)
      group.quaternion.copy(baseQ)
      return
    }
    const strength = gerstnerAmplitude.value
    const sample = (p: Vector3): number =>
      sampleGerstnerUniformsCPU(p.x, p.z, vu, strength, scratch.disp).y
    const hBow = sample(probePoints.bow)
    const hStern = sample(probePoints.stern)
    const hStbd = sample(probePoints.stbd)
    const hPort = sample(probePoints.port)
    const heave = (hBow + hStern + hStbd + hPort) / 4
    const slopeL = (hBow - hStern) / (2 * probes.halfL)
    const slopeS = (hStbd - hPort) / (2 * probes.halfW)
    // Surface normal tilted by the probe-plane slopes, exaggerated by tiltGain.
    scratch.n
      .copy(up)
      .addScaledVector(probes.axisLong, -slopeL * motion.tiltGain)
      .addScaledVector(probes.axisShort, -slopeS * motion.tiltGain)
      .normalize()

    // Exponential low-pass — cheap hull inertia.
    const sm = smoothRef.current
    const alpha = 1 - Math.exp(-delta / Math.max(motion.response, 1e-3))
    sm.heave += (heave - sm.heave) * alpha
    sm.normal.lerp(scratch.n, alpha).normalize()

    group.position
      .copy(basePos)
      .addScaledVector(up, sm.heave * motion.heaveGain)
    scratch.tiltQ.setFromUnitVectors(up, sm.normal)
    group.quaternion.copy(scratch.tiltQ).multiply(baseQ)
  })

  return (
    <group ref={groupRef} scale={scale}>
      <primitive object={scene} />
      {waterOcclusion && motion.hullOcclusion && !hasGlbOccluder && (
        <primitive object={occluder} />
      )}
    </group>
  )
}
