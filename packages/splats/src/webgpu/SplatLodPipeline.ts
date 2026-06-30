// Fully-GPU LOD work-buffer + interval-compaction for the WebGPU splat path, ported
// from PlayCanvas's gsplat work-buffer / interval-compaction (MIT). Each frame: ramp
// a per-splat persistent alpha toward its per-leaf target (the temporal cross-fade),
// GPU stream-compact the alpha>0 set (prefix-sum + scatter), distance-key + radix-sort
// the compacted ids, and write the indirect-draw instance count. Raw WebGPU on device.

import { IndirectStorageBufferAttribute } from 'three/webgpu'

import type { SplatOctreeData } from '../SplatOctree'
import { GpuPrefixSum } from './GpuPrefixSum'
import { WebGpuRadixSort } from './WebGpuRadixSort'

// Quad index count for the splat geometry (two triangles), the draw-indirect
// `indexCount` field of `drawIndexedIndirect`.
const QUAD_INDEX_COUNT = 6
const RAMP_WORKGROUP_SIZE = 256
// Alpha below this counts as gone: the splat is dropped from the compacted set.
const ALIVE_EPSILON = 1 / 512

// Per-splat persistent-alpha ramp toward the per-leaf target. target = 1 if the
// splat's importance rank survives at the leaf's target LOD, else 0; alpha moves
// toward it by at most `fadeStep` per frame. Emits the alive flag (alpha > eps) that
// the compaction scans. Keyed by splat id, so the fade survives re-selection.
const RAMP_WGSL = /* wgsl */ `
struct RampUniforms {
  count: u32,
  lodLevels: u32,
  fadeStep: f32,
  eps: f32,
};
@group(0) @binding(0) var<storage, read> splatLeaf: array<u32>;
@group(0) @binding(1) var<storage, read> splatRank: array<u32>;
@group(0) @binding(2) var<storage, read> leafLodCounts: array<u32>;
@group(0) @binding(3) var<storage, read> leafTargetLod: array<u32>;
@group(0) @binding(4) var<storage, read_write> alpha: array<f32>;
@group(0) @binding(5) var<storage, read_write> alive: array<u32>;
@group(0) @binding(6) var<uniform> u: RampUniforms;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= u.count) {
    return;
  }
  let leaf = splatLeaf[i];
  let lod = leafTargetLod[leaf];
  var keep: u32 = 0u;
  if (lod < u.lodLevels) {
    keep = leafLodCounts[leaf * u.lodLevels + lod];
  }
  let targetAlpha = select(0.0, 1.0, splatRank[i] < keep);
  var a = alpha[i];
  a = a + clamp(targetAlpha - a, -u.fadeStep, u.fadeStep);
  a = clamp(a, 0.0, 1.0);
  alpha[i] = a;
  alive[i] = select(0u, 1u, a > u.eps);
}
`

// Stream-compaction scatter: after the alive flags are exclusively scanned into
// `scan`, each alive splat id is written to its dense slot `scan[i]`. The last
// thread also writes the total alive count (the compacted length).
const SCATTER_WGSL = /* wgsl */ `
struct ScatterUniforms { count: u32, pad0: u32, pad1: u32, pad2: u32 };
@group(0) @binding(0) var<storage, read> alive: array<u32>;
@group(0) @binding(1) var<storage, read> scan: array<u32>;
@group(0) @binding(2) var<storage, read_write> compactedIds: array<u32>;
@group(0) @binding(3) var<storage, read_write> compactCount: array<u32>;
@group(0) @binding(4) var<uniform> u: ScatterUniforms;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= u.count) {
    return;
  }
  let a = alive[i];
  if (a == 1u) {
    compactedIds[scan[i]] = i;
  }
  if (i == u.count - 1u) {
    compactCount[0] = scan[i] + a;
  }
}
`

// Distance keys for the compacted set: key = ~bitcast(squaredDistance) so an
// ascending radix sort yields farthest-first (premultiplied-over order). Only the
// first `compactCount` slots are keyed; the rest are skipped (the sort ignores them).
const KEYS_WGSL = /* wgsl */ `
struct KeyUniforms { count: u32, camX: f32, camY: f32, camZ: f32 };
@group(0) @binding(0) var<storage, read> centers: array<f32>;
@group(0) @binding(1) var<storage, read> compactedIds: array<u32>;
@group(0) @binding(2) var<storage, read> compactCount: array<u32>;
@group(0) @binding(3) var<storage, read_write> keys: array<u32>;
@group(0) @binding(4) var<uniform> u: KeyUniforms;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let j = gid.x;
  if (j >= compactCount[0]) {
    return;
  }
  let id = compactedIds[j];
  let dx = centers[id * 3u] - u.camX;
  let dy = centers[id * 3u + 1u] - u.camY;
  let dz = centers[id * 3u + 2u] - u.camZ;
  let d = dx * dx + dy * dy + dz * dz;
  keys[j] = ~bitcast<u32>(d);
}
`

// Structural view of the WebGPU renderer parts the pipeline reaches into: the
// GPUDevice and the backend's attribute→GPUBuffer map.
interface WebGpuRendererLike {
  backend?: {
    device?: GPUDevice | null
    get?: (object: unknown) => { buffer?: GPUBuffer } | undefined
  }
}

/**
 * The fully-GPU LOD selection + sort + compaction pipeline for the WebGPU splat
 * node material. Built once from the octree; the mesh uploads a per-leaf target LOD
 * each re-selection ({@link uploadLeafTargetLod}) and calls {@link update} each
 * active frame with the material's order/alpha/compact-count storage attributes and
 * the splat-local camera. It writes the sorted draw order, the per-splat alpha (read
 * by the fragment), and the compacted draw count (into the indirect-draw instance
 * field) entirely on-GPU — no per-frame CPU upload of the drawn set. Pass
 * {@link getDrawIndirect} to `geometry.setIndirect`; the prepare over-dispatches the
 * loaded count, guarded by the compacted count, so projection tracks the drawn set.
 */
export class SplatLodPipeline {
  private readonly count: number
  private readonly lodLevels: number
  private readonly leafCount: number
  // CPU-side static data, uploaded to GPU on first device access.
  private readonly splatLeafData: Uint32Array
  private readonly splatRankData: Uint32Array
  private readonly leafLodCountsData: Uint32Array
  private readonly centersData: Float32Array

  // Indirect draw args (Three-owned buffer) for `geometry.setIndirect`. The
  // instanceCount field (slot 1) is overwritten each frame with the compacted count.
  private readonly drawIndirect: IndirectStorageBufferAttribute

  private device: GPUDevice | null = null
  private radix: WebGpuRadixSort | null = null
  private prefixSum: GpuPrefixSum | null = null

  // Static GPU buffers (uploaded once).
  private splatLeaf: GPUBuffer | null = null
  private splatRank: GPUBuffer | null = null
  private leafLodCounts: GPUBuffer | null = null
  private centers: GPUBuffer | null = null
  // Per-frame / persistent GPU buffers.
  private leafTargetLod: GPUBuffer | null = null
  private alive: GPUBuffer | null = null
  private scan: GPUBuffer | null = null
  private compactedIds: GPUBuffer | null = null
  private keys: GPUBuffer | null = null

  private rampPipeline: GPUComputePipeline | null = null
  private scatterPipeline: GPUComputePipeline | null = null
  private keysPipeline: GPUComputePipeline | null = null
  private rampLayout: GPUBindGroupLayout | null = null
  private scatterLayout: GPUBindGroupLayout | null = null
  private keysLayout: GPUBindGroupLayout | null = null
  private rampUniform: GPUBuffer | null = null
  private scatterUniform: GPUBuffer | null = null
  private keysUniform: GPUBuffer | null = null

  // Bind groups that reference the lazily-resolved material buffers, built once those
  // buffers exist. Keyed by the resolved buffers to rebuild if they move.
  private rampBindGroup: GPUBindGroup | null = null
  private scatterBindGroup: GPUBindGroup | null = null
  private keysBindGroup: GPUBindGroup | null = null
  private boundAlpha: GPUBuffer | null = null
  private boundCompactCount: GPUBuffer | null = null

  private leafTargetDirty = false
  private pendingLeafTargetLod: Uint32Array | null = null

  /**
   * @param octree The spatial octree with per-leaf LOD counts (built at load).
   * @param positions `count * 3` splat centres (splat-local), for distance keys.
   * @param count Number of loaded splats.
   */
  constructor(octree: SplatOctreeData, positions: Float32Array, count: number) {
    this.count = count
    this.lodLevels = octree.lodLevels
    this.leafCount = octree.leaves.length
    this.centersData = positions.subarray(0, count * 3)

    // Invert the octree: per splat id, its leaf index and importance rank within
    // the leaf (rank 0 = most important). Drives the per-splat alpha target.
    this.splatLeafData = new Uint32Array(count)
    this.splatRankData = new Uint32Array(count)
    const { leaves, sortedIndices } = octree
    for (let li = 0; li < leaves.length; li++) {
      const leaf = leaves[li]
      for (let k = 0; k < leaf.count; k++) {
        const id = sortedIndices[leaf.offset + k]
        this.splatLeafData[id] = li
        this.splatRankData[id] = k
      }
    }
    // Flat per-leaf LOD counts (leafCount × lodLevels).
    this.leafLodCountsData = new Uint32Array(this.leafCount * this.lodLevels)
    for (let li = 0; li < leaves.length; li++) {
      const lodCounts = leaves[li].lodCounts
      for (let l = 0; l < this.lodLevels; l++) {
        this.leafLodCountsData[li * this.lodLevels + l] = lodCounts[l]
      }
    }

    // Indexed draw-indirect args: [indexCount, instanceCount, firstIndex,
    // baseVertex, firstInstance]. instanceCount starts 0 (draw nothing) and is
    // overwritten each frame with the compacted count.
    this.drawIndirect = new IndirectStorageBufferAttribute(
      new Uint32Array([QUAD_INDEX_COUNT, 0, 0, 0, 0]),
      1
    )
  }

  /** The draw-indirect attribute for `geometry.setIndirect`. */
  getDrawIndirect(): IndirectStorageBufferAttribute {
    return this.drawIndirect
  }

  /** Queues a new per-leaf target LOD for upload on the next {@link update}. */
  uploadLeafTargetLod(leafTargetLod: Uint32Array): void {
    this.pendingLeafTargetLod = leafTargetLod
    this.leafTargetDirty = true
  }

  private static storageBuffer(device: GPUDevice, u32Count: number): GPUBuffer {
    return device.createBuffer({
      size: Math.max(4, u32Count * 4),
      usage:
        GPUBufferUsage.STORAGE |
        GPUBufferUsage.COPY_SRC |
        GPUBufferUsage.COPY_DST
    })
  }

  private static uploadedStorage(
    device: GPUDevice,
    data: Uint32Array | Float32Array
  ): GPUBuffer {
    const buffer = device.createBuffer({
      size: Math.max(4, data.byteLength),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true
    })
    if (data instanceof Float32Array) {
      new Float32Array(buffer.getMappedRange()).set(data)
    } else {
      new Uint32Array(buffer.getMappedRange()).set(data)
    }
    buffer.unmap()
    return buffer
  }

  private makePipeline(
    code: string,
    layout: GPUBindGroupLayout
  ): GPUComputePipeline {
    const device = this.device!
    return device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      compute: { module: device.createShaderModule({ code }), entryPoint: 'main' }
    })
  }

  // Builds device resources once the renderer backend has a device. Returns false
  // until then (pre-init frames are skipped, like GpuSplatSorter).
  private initDevice(renderer: WebGpuRendererLike): boolean {
    if (this.device != null) {
      return true
    }
    const device = renderer.backend?.device
    if (device == null) {
      return false
    }
    this.device = device
    const C = GPUShaderStage.COMPUTE
    const ro: GPUBindGroupLayoutEntry['buffer'] = { type: 'read-only-storage' }
    const rw: GPUBindGroupLayoutEntry['buffer'] = { type: 'storage' }
    const un: GPUBindGroupLayoutEntry['buffer'] = { type: 'uniform' }
    const entry = (
      binding: number,
      buffer: GPUBindGroupLayoutEntry['buffer']
    ): GPUBindGroupLayoutEntry => ({ binding, visibility: C, buffer })

    this.rampLayout = device.createBindGroupLayout({
      entries: [
        entry(0, ro),
        entry(1, ro),
        entry(2, ro),
        entry(3, ro),
        entry(4, rw),
        entry(5, rw),
        entry(6, un)
      ]
    })
    this.scatterLayout = device.createBindGroupLayout({
      entries: [entry(0, ro), entry(1, ro), entry(2, rw), entry(3, rw), entry(4, un)]
    })
    this.keysLayout = device.createBindGroupLayout({
      entries: [entry(0, ro), entry(1, ro), entry(2, ro), entry(3, rw), entry(4, un)]
    })

    this.rampPipeline = this.makePipeline(RAMP_WGSL, this.rampLayout)
    this.scatterPipeline = this.makePipeline(SCATTER_WGSL, this.scatterLayout)
    this.keysPipeline = this.makePipeline(KEYS_WGSL, this.keysLayout)

    // Static, uploaded once.
    this.splatLeaf = SplatLodPipeline.uploadedStorage(device, this.splatLeafData)
    this.splatRank = SplatLodPipeline.uploadedStorage(device, this.splatRankData)
    this.leafLodCounts = SplatLodPipeline.uploadedStorage(
      device,
      this.leafLodCountsData
    )
    this.centers = SplatLodPipeline.uploadedStorage(device, this.centersData)

    // Per-frame / persistent.
    this.leafTargetLod = device.createBuffer({
      size: Math.max(4, this.leafCount * 4),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    })
    this.alive = SplatLodPipeline.storageBuffer(device, this.count)
    this.scan = SplatLodPipeline.storageBuffer(device, this.count)
    this.compactedIds = SplatLodPipeline.storageBuffer(device, this.count)
    this.keys = SplatLodPipeline.storageBuffer(device, this.count)

    this.rampUniform = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    })
    this.scatterUniform = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    })
    this.keysUniform = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    })
    device.queue.writeBuffer(this.scatterUniform, 0, new Uint32Array([this.count]))

    // Compacted-set sort carries explicit ids (seedGidValues = false) and reads its
    // element count from the GPU compact-count buffer.
    this.radix = new WebGpuRadixSort(device, 32, false)
    this.prefixSum = new GpuPrefixSum(device, this.scan, this.count)
    return true
  }

  // (Re)builds the bind groups that reference the lazily-resolved material buffers.
  // Cheap to skip when the buffers are unchanged (the common case).
  private ensureBindGroups(
    alphaBuf: GPUBuffer,
    compactCountBuf: GPUBuffer
  ): void {
    if (
      this.boundAlpha === alphaBuf &&
      this.boundCompactCount === compactCountBuf &&
      this.rampBindGroup != null
    ) {
      return
    }
    const device = this.device!
    const b = (binding: number, buffer: GPUBuffer): GPUBindGroupEntry => ({
      binding,
      resource: { buffer }
    })
    this.rampBindGroup = device.createBindGroup({
      layout: this.rampLayout!,
      entries: [
        b(0, this.splatLeaf!),
        b(1, this.splatRank!),
        b(2, this.leafLodCounts!),
        b(3, this.leafTargetLod!),
        b(4, alphaBuf),
        b(5, this.alive!),
        b(6, this.rampUniform!)
      ]
    })
    this.scatterBindGroup = device.createBindGroup({
      layout: this.scatterLayout!,
      entries: [
        b(0, this.alive!),
        b(1, this.scan!),
        b(2, this.compactedIds!),
        b(3, compactCountBuf),
        b(4, this.scatterUniform!)
      ]
    })
    this.keysBindGroup = device.createBindGroup({
      layout: this.keysLayout!,
      entries: [
        b(0, this.centers!),
        b(1, this.compactedIds!),
        b(2, compactCountBuf),
        b(3, this.keys!),
        b(4, this.keysUniform!)
      ]
    })
    this.boundAlpha = alphaBuf
    this.boundCompactCount = compactCountBuf
  }

  private static dispatch1d(
    encoder: GPUCommandEncoder,
    pipeline: GPUComputePipeline,
    bindGroup: GPUBindGroup,
    workgroups: number
  ): void {
    const pass = encoder.beginComputePass()
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, bindGroup)
    pass.dispatchWorkgroups(workgroups, 1, 1)
    pass.end()
  }

  /**
   * Records and submits one frame of the GPU pipeline: alpha ramp → compaction →
   * distance keys → sort → indirect-draw count. Resolves the material's order/alpha/
   * compact-count storage buffers and the draw-indirect buffer from the renderer
   * backend; returns false (a no-op) until they all exist (the first frame, before
   * the prepare compute and first render have created them).
   *
   * @param renderer The WebGPU renderer (device + attribute→buffer map); typed
   *   `unknown` to satisfy the renderer-agnostic mesh, narrowed internally.
   * @param orderAttr The material's order `StorageInstancedBufferAttribute`.
   * @param alphaAttr The material's per-splat alpha `StorageInstancedBufferAttribute`.
   * @param compactCountAttr The material's 1-element compact-count attribute.
   * @param camX Camera X in splat-local space.
   * @param camY Camera Y in splat-local space.
   * @param camZ Camera Z in splat-local space.
   * @param fadeStep Per-frame alpha step toward the target (the cross-fade rate).
   */
  update(
    renderer: unknown,
    orderAttr: unknown,
    alphaAttr: unknown,
    compactCountAttr: unknown,
    camX: number,
    camY: number,
    camZ: number,
    fadeStep: number
  ): boolean {
    const rendererLike = renderer as WebGpuRendererLike
    if (!this.initDevice(rendererLike)) {
      return false
    }
    const device = this.device!
    // Call through `backend` so `this` stays bound inside Three's `get` (a detached
    // `const get = backend.get` loses the receiver → `undefined.data`).
    const backend = rendererLike.backend
    const orderBuf = backend?.get?.(orderAttr)?.buffer
    const alphaBuf = backend?.get?.(alphaAttr)?.buffer
    const compactCountBuf = backend?.get?.(compactCountAttr)?.buffer
    const drawBuf = backend?.get?.(this.drawIndirect)?.buffer
    if (
      orderBuf == null ||
      alphaBuf == null ||
      compactCountBuf == null ||
      drawBuf == null
    ) {
      return false
    }
    this.ensureBindGroups(alphaBuf, compactCountBuf)

    if (this.leafTargetDirty && this.pendingLeafTargetLod != null) {
      // Pass the backing ArrayBuffer (byte offset/size) to sidestep the typed-array
      // ArrayBufferLike→ArrayBuffer lib mismatch on `writeBuffer`.
      const src = this.pendingLeafTargetLod
      device.queue.writeBuffer(
        this.leafTargetLod!,
        0,
        src.buffer as ArrayBuffer,
        src.byteOffset,
        src.byteLength
      )
      this.leafTargetDirty = false
    }

    // Ramp uniform: count + lodLevels (u32), fadeStep + eps (f32).
    const rampBuf = new ArrayBuffer(16)
    new Uint32Array(rampBuf, 0, 2).set([this.count, this.lodLevels])
    new Float32Array(rampBuf, 8, 2).set([fadeStep, ALIVE_EPSILON])
    device.queue.writeBuffer(this.rampUniform!, 0, rampBuf)
    // Keys uniform: count (u32) + camera (f32 ×3).
    const keyBuf = new ArrayBuffer(16)
    new Uint32Array(keyBuf, 0, 1)[0] = this.count
    new Float32Array(keyBuf, 4, 3).set([camX, camY, camZ])
    device.queue.writeBuffer(this.keysUniform!, 0, keyBuf)

    const wg = Math.ceil(this.count / RAMP_WORKGROUP_SIZE)
    const encoder = device.createCommandEncoder()
    // 1. Ramp per-splat alpha → alpha (read by the fragment) + alive flags.
    SplatLodPipeline.dispatch1d(encoder, this.rampPipeline!, this.rampBindGroup!, wg)
    // 2. Compact: scan a copy of the alive flags, then scatter ids + count.
    encoder.copyBufferToBuffer(this.alive!, 0, this.scan!, 0, this.count * 4)
    this.prefixSum!.encodeScan(encoder)
    SplatLodPipeline.dispatch1d(
      encoder,
      this.scatterPipeline!,
      this.scatterBindGroup!,
      wg
    )
    // 3. Distance keys for the compacted ids.
    SplatLodPipeline.dispatch1d(encoder, this.keysPipeline!, this.keysBindGroup!, wg)
    // 4. Sort the compacted ids back-to-front; copy into the material order buffer.
    const sorted = this.radix!.encodeSortValues(
      encoder,
      this.keys!,
      this.compactedIds!,
      this.count,
      compactCountBuf
    )
    encoder.copyBufferToBuffer(sorted, 0, orderBuf, 0, this.count * 4)
    // 5. Indirect-draw instance count = the compacted count (drawArgs slot 1).
    encoder.copyBufferToBuffer(compactCountBuf, 0, drawBuf, 4, 4)
    device.queue.submit([encoder.finish()])
    return true
  }

  dispose(): void {
    this.radix?.dispose()
    this.prefixSum?.dispose()
    this.splatLeaf?.destroy()
    this.splatRank?.destroy()
    this.leafLodCounts?.destroy()
    this.centers?.destroy()
    this.leafTargetLod?.destroy()
    this.alive?.destroy()
    this.scan?.destroy()
    this.compactedIds?.destroy()
    this.keys?.destroy()
    this.rampUniform?.destroy()
    this.scatterUniform?.destroy()
    this.keysUniform?.destroy()
    this.radix = null
    this.prefixSum = null
  }
}
