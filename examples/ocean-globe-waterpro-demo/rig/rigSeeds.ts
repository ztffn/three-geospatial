// Code-authored default RigDocuments per scenario, used until an authored
// document for the same scenario exists in the server rig manifest (which
// then supersedes the seed — same precedence as site seeds). Coordinates are
// site-local metres in the driver's y-up authoring frame (x=east, y=up,
// z=south). Current seed: a Waste Handling facility flyby aimed at the kiln.

import {
  BezierPath,
  createRigDocument,
  createTimeline,
  EndOfPathInstruction,
  VertexPath,
  type RigDocument,
  type RigTimelineDefinition,
  type Vec3
} from '@huma/path-creator/core'

// Waste Handling default: captured from an in-scene authoring pass — two path
// anchors and two markers clustered by the kiln (local ~y72). The dolly cam
// looks at the CENTROID of the point targets (the driver's roll-free aim), so
// both markers frame the shot. Coordinates are the authored values.
const WASTE_PATH_ANCHORS: Vec3[] = [
  { x: -24.8, y: 72.2, z: -1.6 },
  { x: -51.3, y: 69.6, z: 9.1 }
]

// Two aim markers by the kiln (draggable in the editor). The vcam aims at the
// first; the driver's camera-follow looks at the centroid of all point targets.
const WASTE_TARGETS: Array<{ id: string; name: string; position: Vec3 }> = [
  { id: 'target-2', name: 'Target 2', position: { x: -39.3, y: 69.6, z: 0.4 } },
  { id: 'target-3', name: 'Target 3', position: { x: -27.4, y: 69.6, z: -4.9 } }
]

const WASTE_SHOW_SECONDS = 30
const WASTE_FOV = 69

function buildFlybyDocument(
  anchors: Vec3[],
  targets: Array<{ id: string; name: string; position: Vec3 }>,
  fov: number,
  showSeconds: number
): RigDocument {
  const bezier = new BezierPath(anchors, { isClosed: false })
  const pathLength = new VertexPath(bezier).length

  const timeline: RigTimelineDefinition = {
    id: 'show',
    name: 'Flyby',
    ...createTimeline({
      duration: showSeconds,
      tracks: [
        {
          type: 'camera',
          id: 'camera-track',
          blocks: [
            { id: 'shot-flyby', vcamId: 'vcam-dolly', start: 0, end: showSeconds }
          ]
        },
        {
          type: 'cart',
          id: 'dolly-track',
          cartId: 'dolly-1',
          // Keys store ARC DISTANCE along the path, not normalized 0–1.
          keys: [
            { time: 0, distance: 0, easing: 'easeInOut' },
            { time: showSeconds, distance: pathLength }
          ]
        }
      ]
    })
  }

  return createRigDocument({
    paths: [{ id: 'path-flyby', name: 'Flyby rail', bezier: bezier.toJSON() }],
    carts: [
      {
        id: 'dolly-1',
        name: 'Dolly',
        pathId: 'path-flyby',
        distance: 0,
        speed: 0, // timeline-keyed; never free-runs
        endOfPathInstruction: EndOfPathInstruction.Stop,
        orientationMode: 'path-frame',
        positionOffset: { x: 0, y: 0, z: 0 }
      }
    ],
    vcams: [
      {
        id: 'vcam-dolly',
        name: 'Dolly cam',
        body: { type: 'cart', cartId: 'dolly-1', positionOffset: { x: 0, y: 2, z: 0 } },
        aim: { type: 'track', target: { targetId: targets[0].id } },
        lens: { fov }
      }
    ],
    targets: targets.map(t => ({
      id: t.id,
      name: t.name,
      type: 'point' as const,
      position: t.position
    })),
    timelines: [timeline]
  })
}

export const RIG_SEEDS: Record<string, RigDocument> = {
  'waste-handling': buildFlybyDocument(
    WASTE_PATH_ANCHORS,
    WASTE_TARGETS,
    WASTE_FOV,
    WASTE_SHOW_SECONDS
  )
}
