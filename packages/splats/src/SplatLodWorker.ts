// Web Worker that runs the SplatLodSelector off the main thread. On 'init' it
// rebuilds the octree from the flat arrays the manager posts and constructs the
// selector (keeping the transferred positions); on 'select' it runs one LOD/cull/
// budget pass and ping-pongs the sorted order + fade buffers back. Three-free (the
// selector and octree are), so this worker bundles tiny. Driven by WorkerSplatLodSelector.

import { SplatLodSelector, type SplatLodParams } from './SplatLodSelector'
import { octreeFromFlat, type SplatOctreeFlat } from './SplatOctree'

interface InitMessage {
  type: 'init'
  flat: SplatOctreeFlat
  positions: ArrayBuffer
}

interface SelectMessage {
  type: 'select'
  camX: number
  camY: number
  camZ: number
  planes: ArrayBuffer | null
  budget: number
  lodBaseDistance: number
  lodMultiplier: number
  order: ArrayBuffer
  fade: ArrayBuffer
}

// In a worker `globalThis` is the DedicatedWorkerGlobalScope; the lint config
// restricts `self`, so reach the message API through a typed view of globalThis.
const ctx = globalThis as unknown as {
  onmessage: ((event: MessageEvent) => void) | null
  postMessage: (message: unknown, transfer: Transferable[]) => void
}

let selector: SplatLodSelector | null = null

ctx.onmessage = (event: MessageEvent) => {
  const message = event.data as InitMessage | SelectMessage

  if (message.type === 'init') {
    const octree = octreeFromFlat(message.flat)
    selector = new SplatLodSelector(octree, new Float32Array(message.positions))
    return
  }

  if (selector == null) {
    return
  }

  const planes = message.planes != null ? new Float32Array(message.planes) : null
  const params: SplatLodParams = {
    budget: message.budget,
    lodBaseDistance: message.lodBaseDistance,
    lodMultiplier: message.lodMultiplier
  }
  const result = selector.select(
    message.camX,
    message.camY,
    message.camZ,
    planes,
    params
  )

  // Fill the ping-ponged buffers and transfer them back, zero-copy.
  const order = new Uint32Array(message.order)
  const fade = new Float32Array(message.fade)
  order.set(result.indices.subarray(0, result.count))
  fade.set(result.fade.subarray(0, result.count))
  ctx.postMessage(
    {
      order: order.buffer,
      fade: fade.buffer,
      count: result.count,
      visibleLeaves: result.visibleLeaves,
      totalLeaves: result.totalLeaves
    },
    [order.buffer, fade.buffer]
  )
}
