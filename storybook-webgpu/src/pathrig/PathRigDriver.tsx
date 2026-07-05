// Scene-side driver for @huma/path-creator rig documents: anchors a rig's
// paths/carts/targets to a site's ENU frame, replicates the package demo's
// per-frame drive loop (step player → evaluate timeline → apply cart frames),
// renders the rail + a marker per cart + the WebGPU-native editing layer
// (anchor/target handles + three TransformControls — drei's fat-line gizmos
// are WebGL-only), and writes the virtual-camera shot when following.

import { TransformControls } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState, type FC } from 'react'
import {
  Matrix4,
  Quaternion,
  Vector3,
  type Group,
  type Mesh,
  type PerspectiveCamera
} from 'three'
import { LineGeometry } from 'three/addons/lines/LineGeometry.js'
import { Line2 } from 'three/addons/lines/webgpu/Line2.js'
import { Line2NodeMaterial } from 'three/webgpu'

import {
  buildRigRuntime,
  EndOfPathInstruction,
  TargetRegistry,
  type BezierPath,
  type CartFrame,
  type RigDocument,
  type Vec3,
  type VertexPath
} from '@huma/path-creator/core'
import { EditorHelpers, useEditorHelpersVisible } from '@huma/path-creator/r3f'
import { applyCartFrameToObject } from '@huma/path-creator/three'
import {
  evaluateTimeline,
  stepTimelinePlayer,
  type TimelinePlayer,
  type TimelineRigContext
} from '@huma/path-creator/timeline'

import { enuBasis } from '../ocean/enu'

// Rail sample density: one polyline vertex per this many metres of arc.
const RAIL_METRES_PER_SAMPLE = 5
const RAIL_COLOR = 0x53c2f0
const ANCHOR_COLOR = 0xe8f4fb
const ANCHOR_SELECTED_COLOR = 0xff8c3b
const TARGET_COLOR = 0x33d1a6
const TARGET_SELECTED_COLOR = 0xff8c3b
// Handle radius in metres (site-local). Small — facility structures/targets
// cluster within a few metres of each other.
const HANDLE_RADIUS = 1.5

const _matrix = new Matrix4()
const _position = new Vector3()
const _quaternion = new Quaternion()
const _groupQuaternion = new Quaternion()
const _aim = new Vector3()

// A tracking target the editor can drag (mirrors the package EditableTarget,
// kept local so the driver carries no drei-bound package UI types).
export interface EditableTarget {
  id: string
  name?: string
  type: 'point' | 'cart'
  position?: Vec3
  cartId?: string
}

// In-scene editing, driven by the host's author UI. `bezier` is a LIVE
// BezierPath the host mutates in place (package-demo model); `pathVersion`
// bumps to force redraws. Selection is by bezier POINT index (anchors at
// index%3===0). Targets are the document's tracking targets, draggable in place.
export interface PathRigEditing {
  bezier: BezierPath
  vertexPath: VertexPath
  pathVersion: number
  selectedHandle: number | null
  selectedMidpoint: number | null
  onSelectHandle: (index: number | null) => void
  onSelectMidpoint: (index: number | null) => void
  onMovePoint: (index: number, point: Vec3) => void
  onRotateMidpointNormal: (segmentIndex: number, deltaDegrees: number) => void
  onClearSelection: () => void
  targets: EditableTarget[]
  selectedTarget: string | null
  onSelectTarget: (id: string | null) => void
  onMoveTarget: (id: string, position: Vec3) => void
  // Fires on gizmo drag start/end; the host persists on end.
  onTransformingChange: (transforming: boolean) => void
}

export interface PathRigProps {
  rig: RigDocument
  // Shared transport clock, owned by the host (author transport UI mutates
  // play/time; this driver steps it while playing). Mutable by design.
  player: TimelinePlayer
  // ECEF position the rig's local frame hangs off (the site anchor). The
  // rig authors in y-up local metres: x=east, y=up, z=south.
  anchor: Vector3
  // Hand the scene camera to the timeline's virtual-camera output. The host
  // must suspend its own camera writers (OrbitControls/CameraRig) while set.
  cameraFollow?: boolean
  // Show the authoring guides (rail polyline + dolly marker). True in author
  // mode; false for a visitor cinematic so the shot is clean. Camera-follow
  // works regardless — the vcam pose comes from the timeline, not the meshes.
  showGuides?: boolean
  editing?: PathRigEditing | null
}

export const PathRigDriver: FC<PathRigProps> = ({
  rig,
  player,
  anchor,
  cameraFollow = false,
  showGuides = true,
  editing = null
}) => {
  const camera = useThree(({ camera }) => camera)
  // Reveal editor-helper meshes (layer 30) on the viewport camera while
  // editing; the ocean depth pre-pass excludes that layer (see
  // OceanChunksWaterpro) so the handles never enter the material-override pass.
  useEditorHelpersVisible(editing != null)

  const runtime = useMemo(() => buildRigRuntime(rig), [rig])
  const timeline = useMemo(
    () => runtime.timelines.values().next().value ?? null,
    [runtime]
  )
  // Live cart frames, shared by the drive loop (writer) and the target
  // registry / cart-mounted target glyphs (readers).
  const framesRef = useRef(new Map<string, CartFrame>())

  // Target registry: point targets resolve to their document position, cart
  // targets to the live frame — so a vcam aimed at a target tracks it.
  const registry = useMemo(() => new TargetRegistry(), [])
  const targetsKey = (rig.targets ?? [])
    .map(t => `${t.id}:${t.type}:${t.type === 'cart' ? t.cartId : ''}`)
    .join('|')
  useEffect(() => {
    const unregister = (rig.targets ?? []).map(target => {
      const source =
        target.type === 'cart'
          ? () => framesRef.current.get(target.cartId)?.position ?? null
          : target.type === 'point'
            ? () => target.position
            : () => null
      return registry.register(target.id, source, target.name)
    })
    return () => {
      unregister.forEach(fn => {
        fn()
      })
    }
    // Positions are read live; only re-register when the id/mount set changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetsKey, registry])

  const context = useMemo<TimelineRigContext>(
    () => ({
      rig: runtime,
      vcams: runtime.vcams,
      getTargetPosition: (id: string) => registry.resolve(id)
    }),
    [runtime, registry]
  )
  // The cart the active vcam rides — its marker hides while the camera does.
  const riddenCartId = useMemo(() => {
    for (const vcam of runtime.vcams.values()) {
      if (vcam.body.type === 'cart') return vcam.body.cartId
    }
    return null
  }, [runtime])

  // Hardcoded camera aim: the centroid of the point targets (rig-local), and
  // the site's ENU up. In cameraFollow we look at this centroid with that up,
  // bypassing the package's aim quaternion — which rolls 90° when composed
  // through the rotated ENU group. Roll-free by construction. Null → fall back
  // to the package snapshot orientation (scenes with no point targets).
  const aimLocal = useMemo(() => {
    const pts: Vec3[] = []
    for (const t of rig.targets ?? []) {
      if (t.type === 'point') pts.push(t.position)
    }
    if (pts.length === 0) return null
    let x = 0
    let y = 0
    let z = 0
    for (const p of pts) {
      x += p.x
      y += p.y
      z += p.z
    }
    return new Vector3(x / pts.length, y / pts.length, z / pts.length)
  }, [rig])
  const enuUp = useMemo(() => enuBasis(anchor).up.clone(), [anchor])

  const groupRef = useRef<Group>(null)
  const cartRefs = useRef(new Map<string, Group>())

  // ENU placement: rig-local x→east, y→up, z→south (east × up = −north).
  // `anchor` is memoized upstream (new identity per site change).
  useEffect(() => {
    const group = groupRef.current
    if (group == null) return
    const { east, north, up } = enuBasis(anchor)
    group.position.copy(anchor)
    group.quaternion.setFromRotationMatrix(
      _matrix.makeBasis(east, up, north.clone().negate())
    )
    group.updateMatrixWorld(true)
  }, [anchor])

  // Debug rail per path, sampled by arc distance (Line2 = the scene's WebGPU
  // fat-line idiom; depthTest off so the authoring rail reads through terrain).
  // Rebuilt when the runtime changes — including every geometry edit, since the
  // host commits edits into the doc so the runtime (hence rail) tracks live.
  const rails = useMemo(
    () =>
      [...runtime.paths.values()].map(path => {
        const count = Math.max(2, Math.ceil(path.length / RAIL_METRES_PER_SAMPLE))
        const positions: number[] = []
        for (let i = 0; i <= count; i++) {
          const p = path.getPointAtDistance(
            (i / count) * path.length,
            EndOfPathInstruction.Stop
          )
          positions.push(p.x, p.y, p.z)
        }
        const geometry = new LineGeometry()
        geometry.setPositions(positions)
        const material = new Line2NodeMaterial({
          color: RAIL_COLOR,
          linewidth: 2,
          transparent: true,
          opacity: 0.7,
          depthWrite: false,
          depthTest: false
        })
        const line = new Line2(geometry, material)
        line.frustumCulled = false
        line.renderOrder = 10
        return line
      }),
    [runtime]
  )
  useEffect(
    () => () => {
      rails.forEach(line => {
        line.geometry.dispose()
        line.material.dispose()
      })
    },
    [rails]
  )

  // Anchor world-local positions from the live bezier (recomputed per edit).
  const anchors = useMemo(() => {
    if (editing == null) return []
    const b = editing.bezier
    const count = b.isClosed ? b.numSegments : b.numSegments + 1
    return Array.from({ length: count }, (_, i) => {
      const a = b.getAnchor(i)
      return { pointIndex: i * 3, position: { x: a.x, y: a.y, z: a.z } }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing?.bezier, editing?.pathVersion, editing == null])

  // Gizmo target resolution: one three TransformControls, bound to the selected
  // anchor OR target mesh. Mesh refs fill a Map (setState in an inline ref would
  // loop); an effect binds the gizmo when the selection changes.
  const anchorMeshRefs = useRef(new Map<number, Mesh>())
  const targetMeshRefs = useRef(new Map<string, Mesh>())
  const [gizmoTarget, setGizmoTarget] = useState<Mesh | null>(null)
  const selectedHandle = editing?.selectedHandle ?? null
  const selectedTarget = editing?.selectedTarget ?? null
  const isEditing = editing != null
  const anchorCount = anchors.length
  useEffect(() => {
    if (!isEditing) {
      setGizmoTarget(null)
      return
    }
    if (selectedHandle != null) {
      setGizmoTarget(anchorMeshRefs.current.get(selectedHandle) ?? null)
    } else if (selectedTarget != null) {
      setGizmoTarget(targetMeshRefs.current.get(selectedTarget) ?? null)
    } else {
      setGizmoTarget(null)
    }
    // Mesh maps are refs (stable); rebind when selection or anchor set changes.
  }, [isEditing, selectedHandle, selectedTarget, anchorCount])

  const editingRef = useRef(editing)
  editingRef.current = editing

  // Restore the lens when the rig releases the camera.
  useEffect(() => {
    if (!cameraFollow) return
    const persp = camera as PerspectiveCamera
    const fov = persp.fov
    return () => {
      persp.fov = fov
      persp.updateProjectionMatrix()
    }
  }, [cameraFollow, camera])

  // The drive loop, replicated from the package demo (drive-loop extraction
  // into /three is still pending upstream): advance the clock only while
  // playing, evaluate at the player's time, apply frames.
  useFrame((_, delta) => {
    const group = groupRef.current
    if (group == null || timeline == null) return
    if (player.playing) stepTimelinePlayer(player, timeline, delta)
    const sample = evaluateTimeline(timeline, context, player.time)

    framesRef.current = sample.cartFrames
    for (const [cartId, frame] of sample.cartFrames) {
      const cartObject = cartRefs.current.get(cartId)
      if (cartObject == null) continue
      applyCartFrameToObject(cartObject, frame)
      cartObject.visible = !(cameraFollow && cartId === riddenCartId)
    }

    if (cameraFollow && sample.camera != null) {
      group.updateWorldMatrix(true, false)
      const { position, quaternion, lens } = sample.camera
      // Eye: the cart-mounted vcam position (rig-local) → world.
      _position.set(position.x, position.y, position.z)
      camera.position.copy(_position.applyMatrix4(group.matrixWorld))
      if (aimLocal != null) {
        // Look straight at the targets' centroid with ENU up — no roll.
        _aim.copy(aimLocal).applyMatrix4(group.matrixWorld)
        camera.up.copy(enuUp)
        camera.lookAt(_aim)
      } else {
        group.getWorldQuaternion(_groupQuaternion)
        _quaternion.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w)
        camera.quaternion.copy(_groupQuaternion.multiply(_quaternion))
      }
      const persp = camera as PerspectiveCamera
      if (lens?.fov != null && persp.fov !== lens.fov) {
        persp.fov = lens.fov
        persp.updateProjectionMatrix()
      }
      camera.updateMatrixWorld()
    }
  })

  // Whether the currently-bound gizmo edits an anchor (vs a target).
  const gizmoIsAnchor = selectedHandle != null

  return (
    <>
      <group ref={groupRef}>
        {showGuides &&
          rails.map((line, i) => <primitive key={i} object={line} />)}
        {showGuides &&
          [...runtime.carts.keys()].map(cartId => (
          <group
            key={cartId}
            ref={el => {
              if (el != null) cartRefs.current.set(cartId, el)
              else cartRefs.current.delete(cartId)
            }}
          >
            {/* Dolly marker: a bright box with a nose cone showing travel
                direction (cart forward = local +z). */}
            <mesh>
              <boxGeometry args={[3, 2, 5]} />
              <meshStandardMaterial
                color={RAIL_COLOR}
                emissive={RAIL_COLOR}
                emissiveIntensity={0.6}
              />
            </mesh>
            <mesh position={[0, 0, 3.5]} rotation={[Math.PI / 2, 0, 0]}>
              <coneGeometry args={[1, 2, 12]} />
              <meshStandardMaterial
                color={0xffffff}
                emissive={0xffffff}
                emissiveIntensity={0.4}
              />
            </mesh>
          </group>
        ))}
        {editing != null && (
          <EditorHelpers>
            {/* Anchor handles (click to select, drag the gizmo to move). */}
            {anchors.map(a => (
              <mesh
                key={`a${a.pointIndex}`}
                position={[a.position.x, a.position.y, a.position.z]}
                ref={el => {
                  if (el != null) anchorMeshRefs.current.set(a.pointIndex, el)
                  else anchorMeshRefs.current.delete(a.pointIndex)
                }}
                onClick={event => {
                  event.stopPropagation()
                  editing.onSelectHandle(a.pointIndex)
                }}
              >
                <sphereGeometry args={[HANDLE_RADIUS, 16, 16]} />
                <meshStandardMaterial
                  color={
                    a.pointIndex === selectedHandle
                      ? ANCHOR_SELECTED_COLOR
                      : ANCHOR_COLOR
                  }
                  emissive={
                    a.pointIndex === selectedHandle
                      ? ANCHOR_SELECTED_COLOR
                      : ANCHOR_COLOR
                  }
                  emissiveIntensity={0.5}
                />
              </mesh>
            ))}
            {/* Point-target handles (cart-mounted targets follow the cart and
                aren't draggable). */}
            {editing.targets
              .filter(t => t.type === 'point' && t.position != null)
              .map(t => (
                <mesh
                  key={`t${t.id}`}
                  position={[t.position!.x, t.position!.y, t.position!.z]}
                  ref={el => {
                    if (el != null) targetMeshRefs.current.set(t.id, el)
                    else targetMeshRefs.current.delete(t.id)
                  }}
                  onClick={event => {
                    event.stopPropagation()
                    editing.onSelectTarget(t.id)
                  }}
                >
                  <sphereGeometry args={[HANDLE_RADIUS, 16, 16]} />
                  <meshStandardMaterial
                    color={
                      t.id === selectedTarget
                        ? TARGET_SELECTED_COLOR
                        : TARGET_COLOR
                    }
                    emissive={
                      t.id === selectedTarget
                        ? TARGET_SELECTED_COLOR
                        : TARGET_COLOR
                    }
                    emissiveIntensity={0.5}
                  />
                </mesh>
              ))}
          </EditorHelpers>
        )}
      </group>
      {/* three's TransformControls (WebGPU-safe — LineBasicMaterial gizmo)
          bound to the selected anchor/target mesh. Mounted OUTSIDE the ENU
          group: it tracks the object's WORLD matrix itself, and object.position
          it reports is in the group's local (rig) frame — exactly what the edit
          callbacks expect. */}
      {editing != null && gizmoTarget != null && (
        <TransformControls
          object={gizmoTarget}
          mode='translate'
          space='local'
          size={0.5}
          onMouseDown={() => {
            editing.onTransformingChange(true)
          }}
          onMouseUp={() => {
            editing.onTransformingChange(false)
          }}
          onObjectChange={() => {
            const p = gizmoTarget.position
            const ed = editingRef.current
            if (ed == null) return
            if (gizmoIsAnchor && selectedHandle != null) {
              ed.onMovePoint(selectedHandle, { x: p.x, y: p.y, z: p.z })
            } else if (selectedTarget != null) {
              ed.onMoveTarget(selectedTarget, { x: p.x, y: p.y, z: p.z })
            }
          }}
        />
      )}
    </>
  )
}
