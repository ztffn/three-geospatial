// Generic GPU exclusive prefix sum (Blelloch scan) over a u32 storage buffer of a
// fixed element count, scanned in place. Lifts WebGpuRadixSort's block-sum scan
// kernels (kishimisu/PlayCanvas multipass, MIT) and generalizes them to scan any
// caller-supplied buffer, for the splat LOD stream-compaction stage: the alive-flag
// array is scanned into dense output positions. Raw WebGPU — TSL can't express it.

// Workgroup config matches WebGpuRadixSort's scan: 256 threads, 2 items/thread.
const PS_THREADS_PER_WORKGROUP = 256
const PS_ITEMS_PER_WORKGROUP = 2 * PS_THREADS_PER_WORKGROUP

// Blelloch exclusive scan (up-sweep + down-sweep) over one workgroup's worth of
// items, emitting each workgroup's total to blockSums for the recursive level;
// add_block_sums folds the scanned per-workgroup totals back in. Identical to the
// kernels embedded in WebGpuRadixSort (kept standalone here to avoid touching the
// browser-validated sort).
const PREFIX_SUM_WGSL = /* wgsl */ `
struct PrefixSumUniforms {
  elementCount: u32,
};
@group(0) @binding(0) var<storage, read_write> items: array<u32>;
@group(0) @binding(1) var<storage, read_write> blockSums: array<u32>;
@group(0) @binding(2) var<uniform> uniforms: PrefixSumUniforms;

const THREADS_PER_WORKGROUP: u32 = 256u;
const ITEMS_PER_WORKGROUP: u32 = 512u;

var<workgroup> temp: array<u32, 1024>;

@compute @workgroup_size(16, 16, 1)
fn reduce_downsweep(
  @builtin(workgroup_id) w_id: vec3<u32>,
  @builtin(num_workgroups) w_dim: vec3<u32>,
  @builtin(local_invocation_index) TID: u32,
) {
  let WORKGROUP_ID = w_id.x + w_id.y * w_dim.x;
  let WID = WORKGROUP_ID * THREADS_PER_WORKGROUP;
  let GID = WID + TID;

  let ELM_TID = TID * 2u;
  let ELM_GID = GID * 2u;

  temp[ELM_TID] = select(items[ELM_GID], 0u, ELM_GID >= uniforms.elementCount);
  temp[ELM_TID + 1u] = select(items[ELM_GID + 1u], 0u, ELM_GID + 1u >= uniforms.elementCount);

  var offset: u32 = 1u;

  for (var d: u32 = ITEMS_PER_WORKGROUP >> 1u; d > 0u; d >>= 1u) {
    workgroupBarrier();
    if (TID < d) {
      var ai: u32 = offset * (ELM_TID + 1u) - 1u;
      var bi: u32 = offset * (ELM_TID + 2u) - 1u;
      temp[bi] += temp[ai];
    }
    offset *= 2u;
  }

  if (TID == 0u) {
    let last_offset = ITEMS_PER_WORKGROUP - 1u;
    blockSums[WORKGROUP_ID] = temp[last_offset];
    temp[last_offset] = 0u;
  }

  for (var d: u32 = 1u; d < ITEMS_PER_WORKGROUP; d *= 2u) {
    offset >>= 1u;
    workgroupBarrier();
    if (TID < d) {
      var ai: u32 = offset * (ELM_TID + 1u) - 1u;
      var bi: u32 = offset * (ELM_TID + 2u) - 1u;
      let t: u32 = temp[ai];
      temp[ai] = temp[bi];
      temp[bi] += t;
    }
  }
  workgroupBarrier();

  if (ELM_GID < uniforms.elementCount) {
    items[ELM_GID] = temp[ELM_TID];
  }
  if (ELM_GID + 1u < uniforms.elementCount) {
    items[ELM_GID + 1u] = temp[ELM_TID + 1u];
  }
}

@compute @workgroup_size(16, 16, 1)
fn add_block_sums(
  @builtin(workgroup_id) w_id: vec3<u32>,
  @builtin(num_workgroups) w_dim: vec3<u32>,
  @builtin(local_invocation_index) TID: u32,
) {
  let WORKGROUP_ID = w_id.x + w_id.y * w_dim.x;
  let WID = WORKGROUP_ID * THREADS_PER_WORKGROUP;
  let GID = WID + TID;
  let ELM_ID = GID * 2u;

  if (ELM_ID >= uniforms.elementCount) {
    return;
  }
  let blockSum = blockSums[WORKGROUP_ID];
  items[ELM_ID] += blockSum;

  if (ELM_ID + 1u >= uniforms.elementCount) {
    return;
  }
  items[ELM_ID + 1u] += blockSum;
}
`

interface DispatchSize {
  x: number
  y: number
}

/** 2D dispatch split so workgroup counts above the per-dimension cap still fit. */
function calcDispatchSize(workgroupCount: number, max: number): DispatchSize {
  if (workgroupCount <= max) {
    return { x: workgroupCount, y: 1 }
  }
  const x = Math.floor(Math.sqrt(workgroupCount))
  const y = Math.ceil(workgroupCount / x)
  return { x, y }
}

// One recursion level: scans `count` items in `buffer`, emitting per-workgroup
// totals to `blockSumBuffer` (which becomes the next level's items).
interface ScanLevel {
  count: number
  workgroupCount: number
  dispatch: DispatchSize
  blockSumBuffer: GPUBuffer
  uniformBuffer: GPUBuffer
  bindGroup: GPUBindGroup
}

/**
 * Exclusive prefix sum over a fixed-size u32 buffer, scanned in place. Construct
 * once with the buffer + element count (builds the recursive block-sum levels and
 * bind groups); call {@link encodeScan} each frame to record the scan into a
 * command encoder. After the scan, `buffer[i]` holds the sum of the original
 * `buffer[0 .. i)`; the grand total is `buffer[count - 1] + originalLastValue`
 * (the caller keeps the original last value if it needs the total).
 */
export class GpuPrefixSum {
  private readonly device: GPUDevice
  private readonly maxWorkgroupsPerDim: number
  private readonly scanPipeline: GPUComputePipeline
  private readonly addBlockPipeline: GPUComputePipeline
  private readonly layout: GPUBindGroupLayout
  private levels: ScanLevel[] = []

  constructor(device: GPUDevice, buffer: GPUBuffer, count: number) {
    this.device = device
    const maxDim = device.limits.maxComputeWorkgroupsPerDimension
    this.maxWorkgroupsPerDim = maxDim > 0 ? maxDim : 65535

    const storageRW: GPUBindGroupLayoutEntry['buffer'] = { type: 'storage' }
    const uniform: GPUBindGroupLayoutEntry['buffer'] = { type: 'uniform' }
    const C = GPUShaderStage.COMPUTE
    this.layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: C, buffer: storageRW },
        { binding: 1, visibility: C, buffer: storageRW },
        { binding: 2, visibility: C, buffer: uniform }
      ]
    })
    const module = device.createShaderModule({ code: PREFIX_SUM_WGSL })
    const layout = device.createPipelineLayout({ bindGroupLayouts: [this.layout] })
    this.scanPipeline = device.createComputePipeline({
      layout,
      compute: { module, entryPoint: 'reduce_downsweep' }
    })
    this.addBlockPipeline = device.createComputePipeline({
      layout,
      compute: { module, entryPoint: 'add_block_sums' }
    })

    this.buildLevels(buffer, count)
  }

  // Builds the recursive scan levels: each level scans its items in place and
  // emits per-workgroup totals to a deeper, smaller level; the deepest level has a
  // single workgroup. Block-sum buffers are owned here and reused every frame.
  private buildLevels(buffer: GPUBuffer, count: number): void {
    const device = this.device
    const levels: ScanLevel[] = []
    let items = buffer
    let cnt = count
    for (;;) {
      const workgroupCount = Math.max(1, Math.ceil(cnt / PS_ITEMS_PER_WORKGROUP))
      const blockSumBuffer = device.createBuffer({
        size: Math.max(4, workgroupCount * 4),
        usage:
          GPUBufferUsage.STORAGE |
          GPUBufferUsage.COPY_SRC |
          GPUBufferUsage.COPY_DST
      })
      const uniformBuffer = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      })
      device.queue.writeBuffer(uniformBuffer, 0, new Uint32Array([cnt]))
      const bindGroup = device.createBindGroup({
        layout: this.layout,
        entries: [
          { binding: 0, resource: { buffer: items } },
          { binding: 1, resource: { buffer: blockSumBuffer } },
          { binding: 2, resource: { buffer: uniformBuffer } }
        ]
      })
      levels.push({
        count: cnt,
        workgroupCount,
        dispatch: calcDispatchSize(workgroupCount, this.maxWorkgroupsPerDim),
        blockSumBuffer,
        uniformBuffer,
        bindGroup
      })
      if (workgroupCount <= 1) {
        break
      }
      items = blockSumBuffer
      cnt = workgroupCount
    }
    this.levels = levels
  }

  private static pass(
    encoder: GPUCommandEncoder,
    pipeline: GPUComputePipeline,
    bindGroup: GPUBindGroup,
    dispatch: DispatchSize
  ): void {
    const computePass = encoder.beginComputePass()
    computePass.setPipeline(pipeline)
    computePass.setBindGroup(0, bindGroup)
    computePass.dispatchWorkgroups(dispatch.x, dispatch.y, 1)
    computePass.end()
  }

  /** Records the in-place exclusive scan into `encoder`. */
  encodeScan(encoder: GPUCommandEncoder): void {
    for (const level of this.levels) {
      GpuPrefixSum.pass(encoder, this.scanPipeline, level.bindGroup, level.dispatch)
    }
    for (let i = this.levels.length - 1; i >= 0; i--) {
      const level = this.levels[i]
      if (level.workgroupCount > 1) {
        GpuPrefixSum.pass(
          encoder,
          this.addBlockPipeline,
          level.bindGroup,
          level.dispatch
        )
      }
    }
  }

  dispose(): void {
    for (const level of this.levels) {
      level.blockSumBuffer.destroy()
      level.uniformBuffer.destroy()
    }
    this.levels = []
  }
}
