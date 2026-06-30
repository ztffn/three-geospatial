// Raw-WebGPU GPU radix sort for 32-bit unsigned keys, lifted from PlayCanvas's
// portable multipass backend (engine ComputeRadixSortMultipass + PrefixSumKernel,
// MIT; itself after kishimisu's WebGPU-Radix-Sort). Three.js TSL cannot declare
// the workgroup-shared atomic arrays these kernels need, so this runs PlayCanvas's
// WGSL verbatim on the renderer's shared GPUDevice. Sorts key→index pairs on-GPU.

// 4-bit radix: 16 buckets/pass, 256 threads (16x16), 8 elements/thread = 2048
// elements/workgroup. 32-bit keys → 8 passes. These match PlayCanvas's constants;
// the per-pass values (current bit, first/last-pass flags) that PlayCanvas bakes
// as shader constants are uniforms here so one pipeline serves every pass.
const THREADS_PER_WORKGROUP = 256
const ELEMENTS_PER_WORKGROUP = 2048
const BUCKET_COUNT = 16
const BITS_PER_PASS = 4
// Prefix-sum (Blelloch) workgroup processes 2 items/thread = 512 items.
const PS_ITEMS_PER_WORKGROUP = 2 * THREADS_PER_WORKGROUP

// Histogram pass: per-workgroup 16-bucket digit histogram via workgroup atomics,
// written to block_sums[digit * workgroupCount + workgroupId].
const HISTOGRAM_WGSL = /* wgsl */ `
struct RadixSortUniforms {
  workgroupCount: u32,
  elementCount: u32,
  currentBit: u32,
  isFirstPass: u32,
  isLastPass: u32,
};
@group(0) @binding(0) var<storage, read> input: array<u32>;
@group(0) @binding(1) var<storage, read_write> block_sums: array<u32>;
@group(0) @binding(2) var<uniform> uniforms: RadixSortUniforms;

const THREADS_PER_WORKGROUP: u32 = 256u;
const ELEMENTS_PER_THREAD: u32 = 8u;
const ELEMENTS_PER_WORKGROUP: u32 = THREADS_PER_WORKGROUP * ELEMENTS_PER_THREAD;

var<workgroup> histogram: array<atomic<u32>, 16>;

@compute @workgroup_size(16, 16, 1)
fn main(
  @builtin(workgroup_id) w_id: vec3<u32>,
  @builtin(num_workgroups) w_dim: vec3<u32>,
  @builtin(local_invocation_index) TID: u32,
) {
  let WORKGROUP_ID = w_id.x + w_id.y * w_dim.x;
  let WID = WORKGROUP_ID * ELEMENTS_PER_WORKGROUP;

  if (TID < 16u) {
    atomicStore(&histogram[TID], 0u);
  }
  workgroupBarrier();

  let elementCount = uniforms.elementCount;
  for (var r = 0u; r < ELEMENTS_PER_THREAD; r++) {
    let GID = WID + r * THREADS_PER_WORKGROUP + TID;
    let is_valid = GID < elementCount && WORKGROUP_ID < uniforms.workgroupCount;
    if (is_valid) {
      let elm = input[GID];
      let digit = (elm >> uniforms.currentBit) & 0xFu;
      atomicAdd(&histogram[digit], 1u);
    }
  }
  workgroupBarrier();

  if (TID < 16u && WORKGROUP_ID < uniforms.workgroupCount) {
    block_sums[TID * uniforms.workgroupCount + WORKGROUP_ID] = atomicLoad(&histogram[TID]);
  }
}
`

// Ranked-scatter pass: re-reads keys, sets bits in per-digit 256-bit workgroup
// bitmasks, computes a local rank via popcount, and scatters to
// prefix_block_sum[digit,workgroup] + localRank. Stable.
const REORDER_WGSL = /* wgsl */ `
struct RadixSortUniforms {
  workgroupCount: u32,
  elementCount: u32,
  currentBit: u32,
  isFirstPass: u32,
  isLastPass: u32,
};
@group(0) @binding(0) var<storage, read> inputKeys: array<u32>;
@group(0) @binding(1) var<storage, read_write> outputKeys: array<u32>;
@group(0) @binding(2) var<storage, read> prefix_block_sum: array<u32>;
@group(0) @binding(3) var<storage, read> inputValues: array<u32>;
@group(0) @binding(4) var<storage, read_write> outputValues: array<u32>;
@group(0) @binding(5) var<uniform> uniforms: RadixSortUniforms;

const THREADS_PER_WORKGROUP: u32 = 256u;
const ELEMENTS_PER_THREAD: u32 = 8u;
const ELEMENTS_PER_WORKGROUP: u32 = THREADS_PER_WORKGROUP * ELEMENTS_PER_THREAD;

var<workgroup> digit_masks: array<atomic<u32>, 128>;
var<workgroup> digit_offsets: array<u32, 16>;

@compute @workgroup_size(16, 16, 1)
fn main(
  @builtin(workgroup_id) w_id: vec3<u32>,
  @builtin(num_workgroups) w_dim: vec3<u32>,
  @builtin(local_invocation_index) TID: u32,
) {
  let WORKGROUP_ID = w_id.x + w_id.y * w_dim.x;
  let WID = WORKGROUP_ID * ELEMENTS_PER_WORKGROUP;

  let word_idx = TID >> 5u;
  let bit_idx = TID & 31u;

  if (TID < 16u) {
    digit_offsets[TID] = 0u;
  }
  if (TID < 128u) {
    atomicStore(&digit_masks[TID], 0u);
  }
  workgroupBarrier();

  let elementCount = uniforms.elementCount;
  for (var round = 0u; round < ELEMENTS_PER_THREAD; round++) {
    let GID = WID + round * THREADS_PER_WORKGROUP + TID;
    let is_valid = GID < elementCount;

    let k = select(0u, inputKeys[GID], is_valid);
    let digit = select(16u, (k >> uniforms.currentBit) & 0xFu, is_valid);

    let v = select(0u, select(inputValues[GID], GID, uniforms.isFirstPass == 1u), is_valid);

    if (is_valid) {
      atomicOr(&digit_masks[digit * 8u + word_idx], 1u << bit_idx);
    }
    workgroupBarrier();

    if (is_valid) {
      let base = digit * 8u;
      var local_prefix = digit_offsets[digit];
      for (var w = 0u; w < word_idx; w++) {
        local_prefix += countOneBits(atomicLoad(&digit_masks[base + w]));
      }
      local_prefix += countOneBits(atomicLoad(&digit_masks[base + word_idx]) & ((1u << bit_idx) - 1u));

      let pid = digit * uniforms.workgroupCount + WORKGROUP_ID;
      let sorted_position = prefix_block_sum[pid] + local_prefix;

      if (uniforms.isLastPass == 0u) {
        outputKeys[sorted_position] = k;
      }
      outputValues[sorted_position] = v;
    }

    if (round < ELEMENTS_PER_THREAD - 1u) {
      workgroupBarrier();
      if (TID < 16u) {
        var count = 0u;
        for (var w = 0u; w < 8u; w++) {
          let idx = TID * 8u + w;
          count += countOneBits(atomicLoad(&digit_masks[idx]));
          atomicStore(&digit_masks[idx], 0u);
        }
        digit_offsets[TID] += count;
      }
      workgroupBarrier();
    }
  }
}
`

// Blelloch exclusive scan (up-sweep + down-sweep) over one workgroup's worth of
// items, emitting each workgroup's total to blockSums for the recursive level.
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

// One recursion level of the hierarchical prefix sum. `scanBindGroup` binds
// (items, blockSums, uniform); the same binding serves the down-pass add.
interface PrefixSumLevel {
  count: number
  workgroupCount: number
  dispatch: DispatchSize
  blockSumBuffer: GPUBuffer
  uniformBuffer: GPUBuffer
  bindGroup: GPUBindGroup
}

/**
 * GPU radix sort over `count` u32 keys, producing the permutation of indices
 * (or the values carried alongside) that sorts them ascending. Owns its
 * ping-pong key/value buffers and the block-sum scan; the caller supplies the
 * key buffer and a command encoder, and reads back the sorted-values buffer.
 */
export class WebGpuRadixSort {
  private readonly device: GPUDevice
  private readonly numBits: number
  private readonly numPasses: number
  private readonly maxWorkgroupsPerDim: number

  private readonly histogramPipeline: GPUComputePipeline
  private readonly reorderPipeline: GPUComputePipeline
  private readonly scanPipeline: GPUComputePipeline
  private readonly addBlockPipeline: GPUComputePipeline
  private readonly histogramLayout: GPUBindGroupLayout
  private readonly reorderLayout: GPUBindGroupLayout
  private readonly prefixSumLayout: GPUBindGroupLayout

  private count = 0
  private keysBuffer: GPUBuffer | null = null
  private keys0: GPUBuffer | null = null
  private keys1: GPUBuffer | null = null
  private values0: GPUBuffer | null = null
  private values1: GPUBuffer | null = null
  private blockSums: GPUBuffer | null = null
  private dispatch: DispatchSize = { x: 1, y: 1 }

  private readonly histogramBindGroups: GPUBindGroup[] = []
  private readonly reorderBindGroups: GPUBindGroup[] = []
  private readonly radixUniformBuffers: GPUBuffer[] = []
  private prefixSumLevels: PrefixSumLevel[] = []

  constructor(device: GPUDevice, numBits = 32) {
    this.device = device
    this.numBits = numBits
    this.numPasses = numBits / BITS_PER_PASS
    const maxDim = device.limits.maxComputeWorkgroupsPerDimension
    this.maxWorkgroupsPerDim = maxDim > 0 ? maxDim : 65535

    const storageRO: GPUBindGroupLayoutEntry['buffer'] = {
      type: 'read-only-storage'
    }
    const storageRW: GPUBindGroupLayoutEntry['buffer'] = { type: 'storage' }
    const uniform: GPUBindGroupLayoutEntry['buffer'] = { type: 'uniform' }
    const C = GPUShaderStage.COMPUTE

    this.histogramLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: C, buffer: storageRO },
        { binding: 1, visibility: C, buffer: storageRW },
        { binding: 2, visibility: C, buffer: uniform }
      ]
    })
    this.reorderLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: C, buffer: storageRO },
        { binding: 1, visibility: C, buffer: storageRW },
        { binding: 2, visibility: C, buffer: storageRO },
        { binding: 3, visibility: C, buffer: storageRO },
        { binding: 4, visibility: C, buffer: storageRW },
        { binding: 5, visibility: C, buffer: uniform }
      ]
    })
    this.prefixSumLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: C, buffer: storageRW },
        { binding: 1, visibility: C, buffer: storageRW },
        { binding: 2, visibility: C, buffer: uniform }
      ]
    })

    const histogramModule = device.createShaderModule({ code: HISTOGRAM_WGSL })
    const reorderModule = device.createShaderModule({ code: REORDER_WGSL })
    const prefixSumModule = device.createShaderModule({ code: PREFIX_SUM_WGSL })

    this.histogramPipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({
        bindGroupLayouts: [this.histogramLayout]
      }),
      compute: { module: histogramModule, entryPoint: 'main' }
    })
    this.reorderPipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({
        bindGroupLayouts: [this.reorderLayout]
      }),
      compute: { module: reorderModule, entryPoint: 'main' }
    })
    this.scanPipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({
        bindGroupLayouts: [this.prefixSumLayout]
      }),
      compute: { module: prefixSumModule, entryPoint: 'reduce_downsweep' }
    })
    this.addBlockPipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({
        bindGroupLayouts: [this.prefixSumLayout]
      }),
      compute: { module: prefixSumModule, entryPoint: 'add_block_sums' }
    })
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

  // (Re)builds buffers, per-pass bind groups, and the prefix-sum levels for the
  // given key buffer and element count. The histogram/reorder per-pass uniforms
  // depend only on count (workgroup count) and pass index, so they are written
  // here, once, rather than per frame — which also sidesteps the queue.writeBuffer
  // ordering hazard (writes land before the command buffer, so per-pass rewrites
  // of a shared uniform would all collapse to the last value).
  private ensure(keysBuffer: GPUBuffer, count: number): void {
    if (this.keysBuffer === keysBuffer && this.count === count) {
      return
    }
    this.releaseBuffers()
    this.keysBuffer = keysBuffer
    this.count = count

    const device = this.device
    const workgroupCount = Math.max(1, Math.ceil(count / ELEMENTS_PER_WORKGROUP))
    this.dispatch = calcDispatchSize(workgroupCount, this.maxWorkgroupsPerDim)

    this.keys0 = WebGpuRadixSort.storageBuffer(device, count)
    this.keys1 = WebGpuRadixSort.storageBuffer(device, count)
    this.values0 = WebGpuRadixSort.storageBuffer(device, count)
    this.values1 = WebGpuRadixSort.storageBuffer(device, count)
    this.blockSums = WebGpuRadixSort.storageBuffer(
      device,
      BUCKET_COUNT * workgroupCount
    )

    // Ping-pong assignment per pass, matching PlayCanvas: pass 0 reads the input
    // key buffer; thereafter keys/values alternate between the two internal
    // buffers. The reorder pass writes nextValues, so the final sorted indices
    // land in values0 when numPasses is even (the only case here: 8 passes).
    for (let pass = 0; pass < this.numPasses; pass++) {
      const currentKeys =
        pass === 0 ? keysBuffer : pass % 2 === 1 ? this.keys0 : this.keys1
      const nextKeys = pass % 2 === 0 ? this.keys0 : this.keys1
      const currentValues = pass % 2 === 0 ? this.values0 : this.values1
      const nextValues = pass % 2 === 0 ? this.values1 : this.values0

      const uniformBuffer = device.createBuffer({
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      })
      device.queue.writeBuffer(
        uniformBuffer,
        0,
        new Uint32Array([
          workgroupCount,
          count,
          pass * BITS_PER_PASS,
          pass === 0 ? 1 : 0,
          pass === this.numPasses - 1 ? 1 : 0
        ])
      )
      this.radixUniformBuffers.push(uniformBuffer)

      this.histogramBindGroups.push(
        device.createBindGroup({
          layout: this.histogramLayout,
          entries: [
            { binding: 0, resource: { buffer: currentKeys } },
            { binding: 1, resource: { buffer: this.blockSums } },
            { binding: 2, resource: { buffer: uniformBuffer } }
          ]
        })
      )
      this.reorderBindGroups.push(
        device.createBindGroup({
          layout: this.reorderLayout,
          entries: [
            { binding: 0, resource: { buffer: currentKeys } },
            { binding: 1, resource: { buffer: nextKeys } },
            { binding: 2, resource: { buffer: this.blockSums } },
            { binding: 3, resource: { buffer: currentValues } },
            { binding: 4, resource: { buffer: nextValues } },
            { binding: 5, resource: { buffer: uniformBuffer } }
          ]
        })
      )
    }

    this.buildPrefixSumLevels(BUCKET_COUNT * workgroupCount)
  }

  // Recursive Blelloch scan over `itemCount` block-sum entries: each level scans
  // its items in place and emits per-workgroup totals to a deeper level; the down
  // pass adds the scanned totals back. Mirrors PlayCanvas's PrefixSumKernel.
  private buildPrefixSumLevels(itemCount: number): void {
    const device = this.device
    const levels: PrefixSumLevel[] = []
    let items = this.blockSums!
    let count = itemCount

    for (;;) {
      const workgroupCount = Math.max(
        1,
        Math.ceil(count / PS_ITEMS_PER_WORKGROUP)
      )
      const blockSumBuffer = WebGpuRadixSort.storageBuffer(device, workgroupCount)
      const uniformBuffer = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      })
      device.queue.writeBuffer(uniformBuffer, 0, new Uint32Array([count]))
      const bindGroup = device.createBindGroup({
        layout: this.prefixSumLayout,
        entries: [
          { binding: 0, resource: { buffer: items } },
          { binding: 1, resource: { buffer: blockSumBuffer } },
          { binding: 2, resource: { buffer: uniformBuffer } }
        ]
      })
      levels.push({
        count,
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
      count = workgroupCount
    }

    this.prefixSumLevels = levels
  }

  private static pass(
    encoder: GPUCommandEncoder,
    pipeline: GPUComputePipeline,
    bindGroup: GPUBindGroup,
    dispatch: DispatchSize
  ): void {
    // A separate compute pass per dispatch: WebGPU guarantees an inter-pass
    // barrier, so each kernel sees the previous one's storage writes.
    const computePass = encoder.beginComputePass()
    computePass.setPipeline(pipeline)
    computePass.setBindGroup(0, bindGroup)
    computePass.dispatchWorkgroups(dispatch.x, dispatch.y, 1)
    computePass.end()
  }

  /**
   * Records the full sort into `encoder`. `keysBuffer` holds `count` u32 keys
   * (sorted ascending); pass-0 values default to sequential indices, so the
   * returned buffer is the index permutation. Caller submits the encoder and
   * may then copy from the returned buffer.
   */
  encodeSort(
    encoder: GPUCommandEncoder,
    keysBuffer: GPUBuffer,
    count: number
  ): GPUBuffer {
    this.ensure(keysBuffer, count)

    for (let pass = 0; pass < this.numPasses; pass++) {
      // Histogram → block sums.
      WebGpuRadixSort.pass(
        encoder,
        this.histogramPipeline,
        this.histogramBindGroups[pass],
        this.dispatch
      )
      // Exclusive scan over block sums (in place), forward then down pass.
      for (const level of this.prefixSumLevels) {
        WebGpuRadixSort.pass(
          encoder,
          this.scanPipeline,
          level.bindGroup,
          level.dispatch
        )
      }
      for (let i = this.prefixSumLevels.length - 1; i >= 0; i--) {
        const level = this.prefixSumLevels[i]
        if (level.workgroupCount > 1) {
          WebGpuRadixSort.pass(
            encoder,
            this.addBlockPipeline,
            level.bindGroup,
            level.dispatch
          )
        }
      }
      // Ranked scatter.
      WebGpuRadixSort.pass(
        encoder,
        this.reorderPipeline,
        this.reorderBindGroups[pass],
        this.dispatch
      )
    }

    // numPasses is even (32-bit / 4-bit = 8), so the last reorder wrote values0.
    return this.numPasses % 2 === 1 ? this.values1! : this.values0!
  }

  private releaseBuffers(): void {
    this.keys0?.destroy()
    this.keys1?.destroy()
    this.values0?.destroy()
    this.values1?.destroy()
    this.blockSums?.destroy()
    for (const buffer of this.radixUniformBuffers) {
      buffer.destroy()
    }
    for (const level of this.prefixSumLevels) {
      level.blockSumBuffer.destroy()
      level.uniformBuffer.destroy()
    }
    this.keys0 = null
    this.keys1 = null
    this.values0 = null
    this.values1 = null
    this.blockSums = null
    this.histogramBindGroups.length = 0
    this.reorderBindGroups.length = 0
    this.radixUniformBuffers.length = 0
    this.prefixSumLevels = []
    this.keysBuffer = null
    this.count = 0
  }

  dispose(): void {
    this.releaseBuffers()
  }
}
