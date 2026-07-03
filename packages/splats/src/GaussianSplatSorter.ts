import { Vector3 } from 'three'

/**
 * Produces a back-to-front ordering of splats relative to the camera. Correct
 * alpha compositing of Gaussians requires drawing farthest-first, and because
 * splats do not write depth (see {@link GaussianSplatMaterial}) this ordering is
 * the only thing that establishes their mutual occlusion.
 */
export interface GaussianSplatSorter {
  /**
   * @param positions `count * 3` splat centers, in the same local space as
   *   `cameraPosition`.
   * @param cameraPosition Camera position expressed in the splats' local space.
   * @param count Number of splats.
   * @returns `count` splat indices, ordered farthest-to-nearest.
   */
  sort(
    positions: Float32Array,
    cameraPosition: Vector3,
    count: number
  ): Uint32Array | Promise<Uint32Array>

  dispose(): void
}

/**
 * A GPU-resident sorter (e.g. the WebGPU `GpuSplatSorter`). Instead of returning
 * indices to the CPU, it writes the sorted draw order directly into the material's
 * order storage buffer on the GPU — no per-sort index upload. The
 * {@link GaussianSplatMesh} detects it via {@link isGpuSplatSorter} and drives
 * {@link sortGpu} instead of {@link GaussianSplatSorter.sort}. The renderer and
 * order attribute are typed loosely so this contract stays free of WebGPU types.
 */
export interface GpuGaussianSplatSorter {
  readonly isGpuSplatSorter: true
  sortGpu(
    renderer: unknown,
    orderAttribute: unknown,
    positions: Float32Array,
    cameraPosition: Vector3,
    count: number
  ): void
  dispose(): void
}

/**
 * Synchronous counting sort that buckets splats by quantized squared distance
 * from the camera. Single pass over the data with `bucketCount` buckets, which
 * is both faster and more numerically forgiving than a comparison sort for the
 * large counts typical of splat scenes.
 *
 * Runs on the main thread; acceptable up to a few hundred thousand splats. For
 * larger scenes move this behind a Web Worker (Phase 2) or a GPU compute pass
 * (Phase 3) — both can implement the same {@link GaussianSplatSorter} contract.
 */
export class CPUSplatSorter implements GaussianSplatSorter {
  private readonly bucketCount: number
  private indices: Uint32Array = new Uint32Array(0)
  private distances: Float32Array = new Float32Array(0)
  private readonly counts: Uint32Array
  private readonly starts: Uint32Array

  constructor(bucketCount = 256 * 256) {
    this.bucketCount = bucketCount
    this.counts = new Uint32Array(bucketCount)
    this.starts = new Uint32Array(bucketCount)
  }

  sort(
    positions: Float32Array,
    cameraPosition: Vector3,
    count: number
  ): Uint32Array {
    if (this.distances.length < count) {
      this.distances = new Float32Array(count)
      this.indices = new Uint32Array(count)
    }
    const { distances, bucketCount } = this
    const cx = cameraPosition.x
    const cy = cameraPosition.y
    const cz = cameraPosition.z

    // Squared distance avoids a sqrt and preserves ordering.
    let minDistance = Infinity
    let maxDistance = -Infinity
    for (let i = 0; i < count; ++i) {
      const dx = positions[i * 3] - cx
      const dy = positions[i * 3 + 1] - cy
      const dz = positions[i * 3 + 2] - cz
      const distance = dx * dx + dy * dy + dz * dz
      distances[i] = distance
      if (distance < minDistance) {
        minDistance = distance
      }
      if (distance > maxDistance) {
        maxDistance = distance
      }
    }

    const counts = this.counts.fill(0)
    const range = maxDistance - minDistance
    // Map distance to a bucket; guard against a degenerate zero range.
    const scale = range > 0 ? (bucketCount - 1) / range : 0

    for (let i = 0; i < count; ++i) {
      const bucket = ((distances[i] - minDistance) * scale) | 0
      ++counts[bucket]
    }

    // Prefix sum to get the start offset of each bucket. We want farthest
    // first, so iterate buckets from high distance (last) to low (first).
    const starts = this.starts
    let total = 0
    for (let b = bucketCount - 1; b >= 0; --b) {
      starts[b] = total
      total += counts[b]
    }

    const indices = this.indices
    for (let i = 0; i < count; ++i) {
      const bucket = ((distances[i] - minDistance) * scale) | 0
      indices[starts[bucket]++] = i
    }

    // Return a view tightly sized to the splat count.
    return indices.subarray(0, count)
  }

  dispose(): void {
    this.indices = new Uint32Array(0)
    this.distances = new Float32Array(0)
  }
}

const scratchAngleA = new Vector3()
const scratchAngleB = new Vector3()

/**
 * Tracks whether the camera has moved enough (relative to the splat centroid)
 * to warrant a re-sort. Matches CesiumJS's ~0.5° threshold, which keeps sorting
 * work bounded during smooth camera motion without visible popping.
 */
export class SortTrigger {
  private readonly thresholdRadians: number
  private readonly lastDirection = new Vector3()
  private hasSorted = false

  constructor(thresholdDegrees = 0.5) {
    this.thresholdRadians = (thresholdDegrees * Math.PI) / 180
  }

  shouldSort(cameraPosition: Vector3, centroid: Vector3): boolean {
    scratchAngleA.subVectors(cameraPosition, centroid)
    if (scratchAngleA.lengthSq() === 0) {
      return false
    }
    if (!this.hasSorted) {
      return true
    }
    scratchAngleB.copy(this.lastDirection)
    return scratchAngleA.angleTo(scratchAngleB) > this.thresholdRadians
  }

  markSorted(cameraPosition: Vector3, centroid: Vector3): void {
    this.lastDirection.subVectors(cameraPosition, centroid)
    this.hasSorted = true
  }

  reset(): void {
    this.hasSorted = false
    this.lastDirection.set(0, 0, 0)
  }
}
