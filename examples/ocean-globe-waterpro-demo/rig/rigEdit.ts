// Pure RigDocument edit helpers for the author UI. Geometry editing follows
// the package demo's model — the host mutates a LIVE BezierPath in place and
// commits by serializing it back into the document via applyRigBezier, which
// rescales cart-track keys by the arc-length ratio (a "whole path" run still
// covers the whole path). Plus: show-duration rescale and point-target CRUD.

import {
  BezierPath,
  VertexPath,
  type RigDocument,
  type SerializedBezierPath,
  type TrackingTargetDefinition,
  type Vec3
} from '@huma/path-creator/core'

function cloneDocument(document: RigDocument): RigDocument {
  return JSON.parse(JSON.stringify(document)) as RigDocument
}

function lengthOf(bezier: SerializedBezierPath): number {
  return new VertexPath(BezierPath.fromJSON(bezier)).length
}

/** Commit an edited bezier into the document's first path, rescaling the
 * riding carts' track keys by the arc-length ratio. */
export function applyRigBezier(
  document: RigDocument,
  bezier: SerializedBezierPath
): RigDocument {
  const path = document.paths[0]
  if (path == null) return document
  const oldLength = lengthOf(path.bezier)
  const newLength = lengthOf(bezier)
  const scale = oldLength > 0 ? newLength / oldLength : 1

  const next = cloneDocument(document)
  next.paths[0] = { ...next.paths[0], bezier }
  const cartIds = new Set(
    next.carts.filter(cart => cart.pathId === path.id).map(cart => cart.id)
  )
  for (const timeline of next.timelines ?? []) {
    for (const track of timeline.tracks) {
      if (track.type === 'cart' && cartIds.has(track.cartId)) {
        track.keys = track.keys.map(key => ({
          ...key,
          distance: Math.min(key.distance * scale, newLength)
        }))
      }
    }
  }
  return next
}

/** A simple continuation anchor for Add-anchor UX: extend past the last
 * anchor along the end direction by the average segment spacing. */
export function suggestedNextAnchor(bezier: BezierPath): Vec3 {
  const count = bezier.isClosed ? bezier.numSegments : bezier.numSegments + 1
  const last = bezier.getAnchor(count - 1)
  if (count < 2) return { x: last.x + 50, y: last.y, z: last.z }
  const prev = bezier.getAnchor(count - 2)
  const dx = last.x - prev.x
  const dy = last.y - prev.y
  const dz = last.z - prev.z
  return { x: last.x + dx, y: last.y + dy, z: last.z + dz }
}

/** Rescale the first timeline to a new duration: block windows, blend-ins,
 * cart-key times and event times all stretch proportionally. */
export function setRigShowDuration(
  document: RigDocument,
  seconds: number
): RigDocument {
  const timeline = document.timelines?.[0]
  if (timeline == null || !(seconds > 0) || timeline.duration <= 0) {
    return document
  }
  const ratio = seconds / timeline.duration
  const next = cloneDocument(document)
  const target = next.timelines?.[0]
  if (target == null) return document
  target.duration = seconds
  target.tracks = target.tracks.map(track => {
    if (track.type === 'camera') {
      return {
        ...track,
        blocks: track.blocks.map(block => ({
          ...block,
          start: block.start * ratio,
          end: block.end * ratio,
          ...(block.blendIn != null && {
            blendIn: {
              ...block.blendIn,
              durationSeconds: block.blendIn.durationSeconds * ratio
            }
          })
        }))
      }
    }
    if (track.type === 'cart') {
      return {
        ...track,
        keys: track.keys.map(key => ({ ...key, time: key.time * ratio }))
      }
    }
    return {
      ...track,
      events: track.events.map(event => ({
        ...event,
        time: event.time * ratio
      }))
    }
  })
  return next
}

// --- tracking targets -----------------------------------------------------------

/** Point/cart tracking targets of the document (group targets are ignored by
 * the twin's editor UI). */
export function listRigTargets(
  document: RigDocument
): TrackingTargetDefinition[] {
  return document.targets ?? []
}

export function addRigPointTarget(
  document: RigDocument,
  position: Vec3
): { document: RigDocument; targetId: string } {
  const targets = document.targets ?? []
  const existing = new Set(targets.map(t => t.id))
  let n = targets.length + 1
  while (existing.has(`target-${n}`)) n++
  const targetId = `target-${n}`
  const next = cloneDocument(document)
  next.targets = [
    ...(next.targets ?? []),
    { id: targetId, name: `Target ${n}`, type: 'point', position }
  ]
  return { document: next, targetId }
}

export function moveRigPointTarget(
  document: RigDocument,
  targetId: string,
  position: Vec3
): RigDocument {
  const next = cloneDocument(document)
  next.targets = (next.targets ?? []).map(target =>
    target.id === targetId && target.type === 'point'
      ? { ...target, position }
      : target
  )
  return next
}

export function renameRigTarget(
  document: RigDocument,
  targetId: string,
  name: string
): RigDocument {
  const next = cloneDocument(document)
  next.targets = (next.targets ?? []).map(target =>
    target.id === targetId ? { ...target, name } : target
  )
  return next
}

/** Remove a target; any vcam aimed at it falls back to a fixed aim at the
 * target's last position (a shot must never lose its subject silently). */
export function removeRigTarget(
  document: RigDocument,
  targetId: string
): RigDocument {
  const removed = (document.targets ?? []).find(t => t.id === targetId)
  const fallback: Vec3 =
    removed?.type === 'point' ? { ...removed.position } : { x: 0, y: 0, z: 0 }
  const next = cloneDocument(document)
  next.targets = (next.targets ?? []).filter(t => t.id !== targetId)
  next.vcams = (next.vcams ?? []).map(vcam => {
    const aim = vcam.aim
    if (
      aim?.type === 'track' &&
      typeof aim.target === 'object' &&
      'targetId' in aim.target &&
      aim.target.targetId === targetId
    ) {
      return { ...vcam, aim: { ...aim, target: fallback } }
    }
    return vcam
  })
  return next
}

/** Point the first vcam's aim: at a tracking target, or (null) back along the
 * path direction (body aim). */
export function setRigVcamAimTarget(
  document: RigDocument,
  targetId: string | null
): RigDocument {
  const next = cloneDocument(document)
  next.vcams = (next.vcams ?? []).map((vcam, i) => {
    if (i !== 0) return vcam
    return targetId == null
      ? { ...vcam, aim: { type: 'body' } }
      : { ...vcam, aim: { type: 'track', target: { targetId } } }
  })
  return next
}

/** The first vcam's current aim target id, or null for body/fixed aims. */
export function rigVcamAimTargetId(document: RigDocument): string | null {
  const aim = document.vcams?.[0]?.aim
  if (
    aim?.type === 'track' &&
    typeof aim.target === 'object' &&
    'targetId' in aim.target
  ) {
    return aim.target.targetId
  }
  return null
}

// --- vcam lens ------------------------------------------------------------------

/** The first vcam's field of view (degrees), or a default when unset. */
export function rigVcamFov(document: RigDocument, fallback = 50): number {
  return document.vcams?.[0]?.lens?.fov ?? fallback
}

/** Set the first vcam's field of view (degrees). */
export function setRigVcamFov(document: RigDocument, fov: number): RigDocument {
  if (!(fov > 0)) return document
  const next = cloneDocument(document)
  next.vcams = (next.vcams ?? []).map((vcam, i) =>
    i === 0 ? { ...vcam, lens: { ...vcam.lens, fov } } : vcam
  )
  return next
}

/** The first vcam's rail-local mount offset (positionOffset on a cart body),
 * or the origin when the body is static/absent. */
export function rigVcamMountOffset(document: RigDocument): Vec3 {
  const body = document.vcams?.[0]?.body
  if (body?.type === 'cart' && body.positionOffset != null) {
    return { ...body.positionOffset }
  }
  return { x: 0, y: 0, z: 0 }
}

/** Set the first vcam's rail-local mount offset (only when it rides a cart). */
export function setRigVcamMountOffset(
  document: RigDocument,
  positionOffset: Vec3
): RigDocument {
  const next = cloneDocument(document)
  next.vcams = (next.vcams ?? []).map((vcam, i) =>
    i === 0 && vcam.body.type === 'cart'
      ? { ...vcam, body: { ...vcam.body, positionOffset } }
      : vcam
  )
  return next
}
