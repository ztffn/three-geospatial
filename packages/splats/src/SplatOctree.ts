// Load-time spatial octree with per-node LOD levels for a flat splat cloud.
// PlayCanvas's unified gsplat LOD consumes octree assets whose nodes carry
// importance-decimated LOD levels, baked OFFLINE by their tooling. A flat SPZ has
// none, so this rebuilds that structure at load: subdivide into leaf nodes, then
// per node sort splats by importance so LOD k = the top (count / multiplier^k).

// A leaf node: an axis-aligned cell holding `count` splats, whose global indices
// occupy `sortedIndices[offset .. offset + count)` ordered by descending
// importance. `lodCounts[k]` is how many of those (the most important) survive at
// LOD k, so rendering LOD k means drawing `sortedIndices[offset .. offset + lodCounts[k])`.
export interface SplatOctreeLeaf {
  /** AABB min/max, flat `[minX, minY, minZ, maxX, maxY, maxZ]` in splat-local space. */
  readonly bounds: Float32Array
  /** Start of this leaf's run in {@link SplatOctree.sortedIndices}. */
  readonly offset: number
  /** Splats in this leaf (LOD 0 count). */
  readonly count: number
  /** Per-LOD splat counts; `lodCounts[0] === count`, strictly decreasing. */
  readonly lodCounts: number[]
}

/**
 * The octree data the LOD selector reads. {@link SplatOctree} satisfies it; the
 * transferable-flat form ({@link octreeToFlat} / {@link octreeFromFlat}) rebuilds
 * it inside a worker. Three-free so the worker bundle stays tiny.
 */
export interface SplatOctreeData {
  readonly leaves: SplatOctreeLeaf[]
  readonly sortedIndices: Uint32Array
  readonly lodLevels: number
  readonly totalCount: number
}

/** Flat, transferable form of {@link SplatOctreeData} for posting to a worker. */
export interface SplatOctreeFlat {
  leafBounds: Float32Array
  leafOffsets: Uint32Array
  leafCounts: Uint32Array
  leafLodCounts: Uint32Array
  lodLevels: number
  sortedIndices: Uint32Array
}

export interface SplatOctreeOptions {
  /** Max splats in a leaf before it subdivides. Default 8192. */
  leafCapacity?: number
  /** Max subdivision depth. Default 12. */
  maxDepth?: number
  /** Number of LOD levels per node (>= 1). Default 6. */
  lodLevels?: number
  /** Splat-count divisor between consecutive LODs. Default 2 (each LOD halves). */
  lodMultiplier?: number
}

// Recursion frame for the iterative octree build: a set of splat indices and the
// AABB they occupy. Iterative (not recursive) to stay shallow over millions.
interface BuildCell {
  indices: Uint32Array
  min: [number, number, number]
  max: [number, number, number]
  depth: number
}

/**
 * Builds, at load time, the octree + per-node importance-decimated LOD levels that
 * PlayCanvas bakes offline. Consumed by the per-frame LOD selector, which picks a
 * LOD per leaf from camera distance and a global budget, then gathers the surviving
 * splat indices to render. Renderer-agnostic; built once from the CPU splat data.
 */
export class SplatOctree {
  readonly leaves: SplatOctreeLeaf[]
  /** Per-leaf, importance-sorted splat indices, concatenated leaf-by-leaf. */
  readonly sortedIndices: Uint32Array
  readonly lodLevels: number

  /**
   * @param positions `count * 3` splat centres (splat-local space).
   * @param importance Per-splat importance (higher = kept at coarser LODs). Use a
   *   proxy such as opacity × splat size; see {@link computeSplatImportance}.
   * @param count Number of splats.
   */
  constructor(
    positions: Float32Array,
    importance: Float32Array,
    count: number,
    options: SplatOctreeOptions = {}
  ) {
    const leafCapacity = options.leafCapacity ?? 8192
    const maxDepth = options.maxDepth ?? 12
    this.lodLevels = Math.max(1, options.lodLevels ?? 6)
    const lodMultiplier = options.lodMultiplier ?? 2

    // Root AABB over all splats.
    const min: [number, number, number] = [Infinity, Infinity, Infinity]
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i < count; i++) {
      const x = positions[i * 3]
      const y = positions[i * 3 + 1]
      const z = positions[i * 3 + 2]
      if (x < min[0]) min[0] = x
      if (y < min[1]) min[1] = y
      if (z < min[2]) min[2] = z
      if (x > max[0]) max[0] = x
      if (y > max[1]) max[1] = y
      if (z > max[2]) max[2] = z
    }

    const allIndices = new Uint32Array(count)
    for (let i = 0; i < count; i++) {
      allIndices[i] = i
    }

    // Iterative subdivision: split each over-capacity cell into 8 octants by the
    // centre plane, partitioning its indices. Leaves accumulate as we go.
    const leafCells: BuildCell[] = []
    const stack: BuildCell[] = [{ indices: allIndices, min, max, depth: 0 }]
    while (stack.length > 0) {
      const cell = stack.pop()!
      if (cell.indices.length <= leafCapacity || cell.depth >= maxDepth) {
        if (cell.indices.length > 0) {
          leafCells.push(cell)
        }
        continue
      }
      const cx = (cell.min[0] + cell.max[0]) * 0.5
      const cy = (cell.min[1] + cell.max[1]) * 0.5
      const cz = (cell.min[2] + cell.max[2]) * 0.5

      // Bucket indices into the 8 octants.
      const buckets: number[][] = [[], [], [], [], [], [], [], []]
      const ind = cell.indices
      for (let k = 0; k < ind.length; k++) {
        const i = ind[k]
        const octant =
          (positions[i * 3] >= cx ? 1 : 0) |
          (positions[i * 3 + 1] >= cy ? 2 : 0) |
          (positions[i * 3 + 2] >= cz ? 4 : 0)
        buckets[octant].push(i)
      }
      for (let o = 0; o < 8; o++) {
        if (buckets[o].length === 0) {
          continue
        }
        stack.push({
          indices: Uint32Array.from(buckets[o]),
          min: [
            (o & 1) !== 0 ? cx : cell.min[0],
            (o & 2) !== 0 ? cy : cell.min[1],
            (o & 4) !== 0 ? cz : cell.min[2]
          ],
          max: [
            (o & 1) !== 0 ? cell.max[0] : cx,
            (o & 2) !== 0 ? cell.max[1] : cy,
            (o & 4) !== 0 ? cell.max[2] : cz
          ],
          depth: cell.depth + 1
        })
      }
    }

    // Lay out the leaves: per leaf, sort its indices by descending importance and
    // write them contiguously, then derive the geometric LOD prefix counts.
    const sortedIndices = new Uint32Array(count)
    const leaves: SplatOctreeLeaf[] = []
    let cursor = 0
    for (const cell of leafCells) {
      const leafCount = cell.indices.length
      const localOrder = Array.from(cell.indices)
      localOrder.sort((a, b) => importance[b] - importance[a])
      for (let k = 0; k < leafCount; k++) {
        sortedIndices[cursor + k] = localOrder[k]
      }

      const lodCounts: number[] = []
      let prev = -1
      for (let lod = 0; lod < this.lodLevels; lod++) {
        // LOD 0 = all; coarser LODs keep count / multiplier^lod (>= 1, decreasing).
        let c = Math.ceil(leafCount / lodMultiplier ** lod)
        if (c < 1) c = 1
        if (c >= prev && prev !== -1) c = prev - 1 // keep strictly decreasing
        if (c < 1) c = 1
        lodCounts.push(c)
        prev = c
      }

      const bounds = new Float32Array([
        cell.min[0],
        cell.min[1],
        cell.min[2],
        cell.max[0],
        cell.max[1],
        cell.max[2]
      ])
      leaves.push({ bounds, offset: cursor, count: leafCount, lodCounts })
      cursor += leafCount
    }

    this.leaves = leaves
    this.sortedIndices = sortedIndices
  }

  /** Total splats at LOD 0 across all leaves (== the source splat count). */
  get totalCount(): number {
    return this.sortedIndices.length
  }
}

/**
 * Importance proxy for LOD decimation: opacity × geometric-mean splat size. Bigger,
 * more opaque splats survive to coarser LODs (they cover more screen and matter
 * more), mirroring the visual-importance decimation PlayCanvas's tooling bakes.
 *
 * @param scales `count * 3` log-space scales (as stored in `GaussianSplatData`).
 * @param colors `count * 4` RGBA bytes; alpha is opacity.
 * @param count Number of splats.
 */
export function computeSplatImportance(
  scales: Float32Array,
  colors: Uint8Array,
  count: number
): Float32Array {
  const importance = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    const sx = Math.exp(scales[i * 3])
    const sy = Math.exp(scales[i * 3 + 1])
    const sz = Math.exp(scales[i * 3 + 2])
    const size = Math.cbrt(sx * sy * sz)
    const opacity = colors[i * 4 + 3] / 255
    importance[i] = size * opacity
  }
  return importance
}

/** Flattens octree data into transferable typed arrays for posting to a worker. */
export function octreeToFlat(octree: SplatOctreeData): SplatOctreeFlat {
  const { leaves, sortedIndices, lodLevels } = octree
  const leafCount = leaves.length
  const leafBounds = new Float32Array(leafCount * 6)
  const leafOffsets = new Uint32Array(leafCount)
  const leafCounts = new Uint32Array(leafCount)
  const leafLodCounts = new Uint32Array(leafCount * lodLevels)
  for (let i = 0; i < leafCount; i++) {
    const leaf = leaves[i]
    leafBounds.set(leaf.bounds, i * 6)
    leafOffsets[i] = leaf.offset
    leafCounts[i] = leaf.count
    for (let l = 0; l < lodLevels; l++) {
      leafLodCounts[i * lodLevels + l] = leaf.lodCounts[l]
    }
  }
  return {
    leafBounds,
    leafOffsets,
    leafCounts,
    leafLodCounts,
    lodLevels,
    sortedIndices
  }
}

/** Rebuilds {@link SplatOctreeData} from its flat form (inside a worker). */
export function octreeFromFlat(flat: SplatOctreeFlat): SplatOctreeData {
  const {
    leafBounds,
    leafOffsets,
    leafCounts,
    leafLodCounts,
    lodLevels,
    sortedIndices
  } = flat
  const leafCount = leafOffsets.length
  const leaves: SplatOctreeLeaf[] = []
  for (let i = 0; i < leafCount; i++) {
    const lodCounts: number[] = []
    for (let l = 0; l < lodLevels; l++) {
      lodCounts.push(leafLodCounts[i * lodLevels + l])
    }
    leaves.push({
      bounds: leafBounds.subarray(i * 6, i * 6 + 6),
      offset: leafOffsets[i],
      count: leafCounts[i],
      lodCounts
    })
  }
  return { leaves, sortedIndices, lodLevels, totalCount: sortedIndices.length }
}
