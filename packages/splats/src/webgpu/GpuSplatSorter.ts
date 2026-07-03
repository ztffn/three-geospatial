// GPU back-to-front splat sorter for the WebGPU node path. Computes a per-splat
// distance key on-GPU (squared distance to the camera, bit-cast so an ascending
// radix sort yields farthest-first), runs the WebGpuRadixSort, and writes the
// resulting draw order straight into the material's order storage buffer with a
// GPU-GPU copy — eliminating the CPU worker and the per-sort index upload.

import type { Vector3 } from 'three'

import { WebGpuRadixSort } from './WebGpuRadixSort'

// Computes ~bitcast<u32>(squaredDistance) per splat. Squared distance is always
// non-negative, so its IEEE-754 bit pattern is monotonic with the value; the
// bitwise-NOT flips ascending→descending so the ascending radix sort draws the
// farthest splat first (correct premultiplied-alpha compositing order).
const KEYS_WGSL = /* wgsl */ `
struct KeyUniforms {
  count: u32,
  camX: f32,
  camY: f32,
  camZ: f32,
};
@group(0) @binding(0) var<storage, read> centers: array<f32>;
@group(0) @binding(1) var<storage, read_write> keys: array<u32>;
@group(0) @binding(2) var<uniform> u: KeyUniforms;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= u.count) {
    return;
  }
  let dx = centers[i * 3u] - u.camX;
  let dy = centers[i * 3u + 1u] - u.camY;
  let dz = centers[i * 3u + 2u] - u.camZ;
  let d = dx * dx + dy * dy + dz * dz;
  keys[i] = ~bitcast<u32>(d);
}
`

// Structural view of the WebGPU renderer parts the sorter reaches into: the
// GPUDevice and the backend's attribute→GPUBuffer map (to find the order buffer).
interface WebGpuRendererLike {
  backend?: {
    device?: GPUDevice | null
    get?: (object: unknown) => { buffer?: GPUBuffer } | undefined
  }
}

/**
 * A GPU-resident splat sorter for {@link GaussianSplatNodeMaterial}. Unlike the
 * CPU {@link GaussianSplatSorter}s it does not return indices — it writes the
 * sorted draw order directly into the material's order storage buffer on the
 * GPU. The {@link GaussianSplatMesh} detects it via {@link isGpuSplatSorter} and
 * drives {@link sortGpu} instead of the CPU sort/upload path.
 */
export class GpuSplatSorter {
  readonly isGpuSplatSorter = true as const

  private device: GPUDevice | null = null
  private radix: WebGpuRadixSort | null = null
  private keysPipeline: GPUComputePipeline | null = null
  private keysLayout: GPUBindGroupLayout | null = null
  private keysUniform: GPUBuffer | null = null

  private centersBuffer: GPUBuffer | null = null
  private keysBuffer: GPUBuffer | null = null
  private keysBindGroup: GPUBindGroup | null = null
  private lastPositions: Float32Array | null = null
  private count = 0

  // Builds the device-dependent resources on first use, once the renderer's
  // backend has a device. Returns false until then (pre-init frames are skipped).
  private initDevice(renderer: WebGpuRendererLike): boolean {
    if (this.device != null) {
      return true
    }
    const device = renderer.backend?.device
    if (device == null) {
      return false
    }
    this.device = device
    this.radix = new WebGpuRadixSort(device, 32)
    this.keysLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'read-only-storage' }
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'storage' }
        },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'uniform' }
        }
      ]
    })
    this.keysPipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({
        bindGroupLayouts: [this.keysLayout]
      }),
      compute: {
        module: device.createShaderModule({ code: KEYS_WGSL }),
        entryPoint: 'main'
      }
    })
    this.keysUniform = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    })
    return true
  }

  // Uploads the splat centres to a storage buffer once (re-uploaded only when the
  // cloud changes), and (re)allocates the matching key buffer + keys bind group.
  private setCenters(positions: Float32Array, count: number): void {
    if (this.lastPositions === positions && this.centersBuffer != null) {
      return
    }
    const device = this.device!
    this.centersBuffer?.destroy()
    this.keysBuffer?.destroy()

    const centerData = positions.subarray(0, count * 3)
    this.centersBuffer = device.createBuffer({
      size: Math.max(4, centerData.byteLength),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true
    })
    new Float32Array(this.centersBuffer.getMappedRange()).set(centerData)
    this.centersBuffer.unmap()

    this.keysBuffer = device.createBuffer({
      size: Math.max(4, count * 4),
      usage:
        GPUBufferUsage.STORAGE |
        GPUBufferUsage.COPY_SRC |
        GPUBufferUsage.COPY_DST
    })

    this.keysBindGroup = device.createBindGroup({
      layout: this.keysLayout!,
      entries: [
        { binding: 0, resource: { buffer: this.centersBuffer } },
        { binding: 1, resource: { buffer: this.keysBuffer } },
        { binding: 2, resource: { buffer: this.keysUniform! } }
      ]
    })

    this.lastPositions = positions
    this.count = count
  }

  /**
   * Sorts the splats back-to-front for `cameraPosition` (in splat-local space)
   * and writes the draw order into `orderAttribute`'s GPU buffer. No-op until the
   * renderer backend has a device and the order buffer has been allocated by the
   * first render (the order attribute is identity-initialised, so the first frame
   * before this runs is still coherent).
   *
   * @param renderer The WebGPU renderer (provides the device and buffer map).
   * @param orderAttribute The material's order `StorageInstancedBufferAttribute`.
   * @param positions `count * 3` splat centres, splat-local.
   * @param cameraPosition Camera position in splat-local space.
   * @param count Number of splats.
   */
  sortGpu(
    renderer: WebGpuRendererLike,
    orderAttribute: unknown,
    positions: Float32Array,
    cameraPosition: Vector3,
    count: number
  ): void {
    if (!this.initDevice(renderer)) {
      return
    }
    const device = this.device!
    const orderBuffer = renderer.backend?.get?.(orderAttribute)?.buffer
    if (orderBuffer == null) {
      return
    }
    this.setCenters(positions, count)

    const uniformData = new ArrayBuffer(16)
    new Uint32Array(uniformData, 0, 1)[0] = count
    new Float32Array(uniformData, 4, 3).set([
      cameraPosition.x,
      cameraPosition.y,
      cameraPosition.z
    ])
    device.queue.writeBuffer(this.keysUniform!, 0, uniformData)

    const encoder = device.createCommandEncoder()

    const keysPass = encoder.beginComputePass()
    keysPass.setPipeline(this.keysPipeline!)
    keysPass.setBindGroup(0, this.keysBindGroup)
    keysPass.dispatchWorkgroups(Math.ceil(count / 256), 1, 1)
    keysPass.end()

    const sorted = this.radix!.encodeSort(encoder, this.keysBuffer!, count)
    encoder.copyBufferToBuffer(sorted, 0, orderBuffer, 0, count * 4)

    device.queue.submit([encoder.finish()])
  }

  dispose(): void {
    this.centersBuffer?.destroy()
    this.keysBuffer?.destroy()
    this.keysUniform?.destroy()
    this.radix?.dispose()
    this.centersBuffer = null
    this.keysBuffer = null
    this.keysUniform = null
    this.radix = null
    this.lastPositions = null
  }
}
