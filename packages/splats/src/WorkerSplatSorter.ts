// Off-main-thread Gaussian-splat depth sorter. Lifts PlayCanvas's gsplat
// sort-worker approach (engine src/scene/gsplat/gsplat-sort-worker.js, MIT): a
// Web Worker runs a counting sort over the splat centres with bucket precision
// scaled to the splat count, and ping-pongs the index buffer back as a
// transferable so the render thread never blocks. Same contract as CPUSplatSorter.

import type { Vector3 } from 'three'

import type { GaussianSplatSorter } from './GaussianSplatSorter'

// Worker body — stringified into a Blob, so it MUST be self-contained: no closure
// captures, no imports, only globals (Math, typed arrays, self). Counting sort by
// squared distance from the camera, farthest-first. Bucket precision scales with
// the splat count (PlayCanvas's `compareBits` heuristic, 10..20 bits) so large
// clouds keep depth resolution. Centres are uploaded once (kept across messages);
// each sort transfers in the order buffer and transfers it back out, zero-copy.
function sortWorkerBody(): void {
  // In a worker `globalThis` is the DedicatedWorkerGlobalScope (same as `self`,
  // which the lint config restricts).
  const ctx = globalThis as unknown as {
    onmessage: ((event: MessageEvent) => void) | null
    postMessage: (message: unknown, transfer: Transferable[]) => void
  }

  let centers: Float32Array | null = null
  let distances: Float32Array | null = null
  let counts: Uint32Array | null = null
  let starts: Uint32Array | null = null
  let bucketCount = 0

  ctx.onmessage = (event: MessageEvent) => {
    const message = event.data as {
      centers?: ArrayBuffer
      order?: ArrayBuffer
      count?: number
      cx?: number
      cy?: number
      cz?: number
    }

    if (message.centers != null) {
      centers = new Float32Array(message.centers)
    }
    if (message.order == null || centers == null || message.count == null) {
      return
    }

    const order = new Uint32Array(message.order)
    const count = message.count
    // Always sent by the main thread; cast (not `??`) so the stringified worker
    // body stays free of any bundler-injected nullish-coalescing helper.
    const cx = message.cx!
    const cy = message.cy!
    const cz = message.cz!

    // Bucket precision scaled to count, clamped 10..20 bits (PlayCanvas heuristic).
    const bits = Math.max(
      10,
      Math.min(20, Math.round(Math.log2(Math.max(1, count / 4))))
    )
    const nb = 2 ** bits + 1
    if (counts == null || bucketCount !== nb) {
      counts = new Uint32Array(nb)
      starts = new Uint32Array(nb)
      bucketCount = nb
    } else {
      counts.fill(0)
    }
    if (distances == null || distances.length < count) {
      distances = new Float32Array(count)
    }
    const dist = distances
    const cnt = counts
    const start = starts!

    // Squared distance from the camera (preserves ordering, avoids sqrt).
    let minD = Infinity
    let maxD = -Infinity
    for (let i = 0; i < count; ++i) {
      const dx = centers[i * 3] - cx
      const dy = centers[i * 3 + 1] - cy
      const dz = centers[i * 3 + 2] - cz
      const d = dx * dx + dy * dy + dz * dz
      dist[i] = d
      if (d < minD) minD = d
      if (d > maxD) maxD = d
    }

    const range = maxD - minD
    const scale = range > 0 ? (nb - 1) / range : 0
    for (let i = 0; i < count; ++i) {
      ++cnt[((dist[i] - minD) * scale) | 0]
    }
    // Farthest-first: prefix-sum buckets from high distance down to low.
    let total = 0
    for (let b = nb - 1; b >= 0; --b) {
      start[b] = total
      total += cnt[b]
    }
    for (let i = 0; i < count; ++i) {
      order[start[((dist[i] - minD) * scale) | 0]++] = i
    }

    ctx.postMessage({ order: order.buffer }, [order.buffer])
  }
}

/**
 * A {@link GaussianSplatSorter} that runs the depth sort in a Web Worker, so
 * sorting multi-million-splat clouds never blocks the render thread. Drop it into
 * a {@link GaussianSplatMesh} via the `sorter` option; the mesh already awaits the
 * returned promise (its async-sort path) and uploads the result when it resolves.
 */
export class WorkerSplatSorter implements GaussianSplatSorter {
  private readonly worker: Worker
  private lastPositions: Float32Array | null = null
  private orderBuffer: ArrayBuffer | null = null
  private resolvePending: ((indices: Uint32Array) => void) | null = null

  constructor() {
    const source = `(${sortWorkerBody.toString()})()`
    const blob = new Blob([source], { type: 'application/javascript' })
    const url = URL.createObjectURL(blob)
    this.worker = new Worker(url)
    URL.revokeObjectURL(url)
    this.worker.onmessage = (event: MessageEvent) => {
      const buffer = (event.data as { order: ArrayBuffer }).order
      this.orderBuffer = buffer
      const resolve = this.resolvePending
      this.resolvePending = null
      resolve?.(new Uint32Array(buffer))
    }
  }

  async sort(
    positions: Float32Array,
    cameraPosition: Vector3,
    count: number
  ): Promise<Uint32Array> {
    return await new Promise(resolve => {
      const transfer: Transferable[] = []
      const message: Record<string, unknown> = {
        count,
        cx: cameraPosition.x,
        cy: cameraPosition.y,
        cz: cameraPosition.z
      }
      // Upload centres only when the cloud changes (worker retains them). A copy
      // is sent so the mesh keeps ownership of its `splatPositions`.
      if (positions !== this.lastPositions) {
        const copy = positions.slice(0, count * 3)
        message.centers = copy.buffer
        transfer.push(copy.buffer)
        this.lastPositions = positions
      }
      // Ping-pong a single index buffer: transferred in, filled, transferred back.
      if (this.orderBuffer?.byteLength !== count * 4) {
        this.orderBuffer = new ArrayBuffer(count * 4)
      }
      message.order = this.orderBuffer
      transfer.push(this.orderBuffer)
      this.orderBuffer = null
      this.resolvePending = resolve
      this.worker.postMessage(message, transfer)
    })
  }

  dispose(): void {
    this.worker.terminate()
    this.lastPositions = null
    this.orderBuffer = null
    this.resolvePending = null
  }
}
