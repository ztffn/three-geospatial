// Off-main-thread driver for the splat LOD selector. Flattens the octree, ships it
// (plus a positions copy) to a Web Worker once, then per frame posts the camera +
// frustum and awaits the sorted active order + fade. Keeps the per-frame LOD/cull/
// budget/sort cost off the render thread; the GaussianSplatMesh awaits the promise
// (its async-select path) and uploads the result when it resolves. Mirrors WorkerSplatSorter.

import {
  octreeToFlat,
  type SplatOctreeData,
  type SplatOctreeFlat
} from './SplatOctree'
import type { SplatLodParams, SplatLodResult } from './SplatLodSelector'

interface WorkerResult {
  order: ArrayBuffer
  fade: ArrayBuffer
  count: number
}

/**
 * Drives {@link SplatLodSelector} in a Web Worker. Construct with the octree (built
 * once on the main thread) and the splat centres; call {@link select} each frame the
 * mesh wants a new LOD selection and await the back-to-front active set + fade.
 */
export class WorkerSplatLodSelector {
  private readonly worker: Worker
  private readonly count: number
  private orderBuffer: ArrayBuffer | null = null
  private fadeBuffer: ArrayBuffer | null = null
  private resolvePending: ((result: SplatLodResult) => void) | null = null

  constructor(octree: SplatOctreeData, positions: Float32Array) {
    this.count = octree.totalCount
    this.worker = new Worker(new URL('./SplatLodWorker.ts', import.meta.url), {
      type: 'module'
    })
    this.worker.onmessage = (event: MessageEvent) => {
      const data = event.data as WorkerResult
      this.orderBuffer = data.order
      this.fadeBuffer = data.fade
      const resolve = this.resolvePending
      this.resolvePending = null
      resolve?.({
        indices: new Uint32Array(data.order),
        fade: new Float32Array(data.fade),
        count: data.count
      })
    }

    // One-time init: flatten the octree and ship it with a positions copy. The
    // flat buffers and the copy are transferred (the octree is discarded after).
    const flat: SplatOctreeFlat = octreeToFlat(octree)
    const positionsCopy = positions.slice(0, this.count * 3)
    this.worker.postMessage(
      { type: 'init', flat, positions: positionsCopy.buffer },
      [
        flat.leafBounds.buffer,
        flat.leafOffsets.buffer,
        flat.leafCounts.buffer,
        flat.leafLodCounts.buffer,
        flat.sortedIndices.buffer,
        positionsCopy.buffer
      ]
    )
  }

  /**
   * Requests a LOD selection for the given splat-local camera and frustum planes
   * (`[nx,ny,nz,constant]×6`, or null to skip culling). Resolves with the active
   * indices (back-to-front) and per-instance fade. Only one request is in flight at
   * a time; the mesh gates new requests on its own pending flag.
   */
  async select(
    cameraX: number,
    cameraY: number,
    cameraZ: number,
    planes: Float32Array | null,
    params: SplatLodParams
  ): Promise<SplatLodResult> {
    return await new Promise(resolve => {
      // Ping-pong the order + fade buffers: transferred in, filled, transferred back.
      if (this.orderBuffer?.byteLength !== this.count * 4) {
        this.orderBuffer = new ArrayBuffer(this.count * 4)
      }
      if (this.fadeBuffer?.byteLength !== this.count * 4) {
        this.fadeBuffer = new ArrayBuffer(this.count * 4)
      }
      const order = this.orderBuffer
      const fade = this.fadeBuffer
      this.orderBuffer = null
      this.fadeBuffer = null

      const transfer: Transferable[] = [order, fade]
      let planesBuffer: ArrayBuffer | null = null
      if (planes != null) {
        const copy = planes.slice()
        planesBuffer = copy.buffer
        transfer.push(planesBuffer)
      }

      this.resolvePending = resolve
      this.worker.postMessage(
        {
          type: 'select',
          camX: cameraX,
          camY: cameraY,
          camZ: cameraZ,
          planes: planesBuffer,
          budget: params.budget,
          lodBaseDistance: params.lodBaseDistance,
          lodMultiplier: params.lodMultiplier,
          order,
          fade
        },
        transfer
      )
    })
  }

  dispose(): void {
    this.worker.terminate()
    this.orderBuffer = null
    this.fadeBuffer = null
    this.resolvePending = null
  }
}
