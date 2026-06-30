import {
  Frustum,
  Matrix4,
  Mesh,
  Vector3,
  WebGLCoordinateSystem,
  type Camera,
  type CoordinateSystem,
  type Material,
  type Vector2
} from 'three'
import type { IndirectStorageBufferAttribute } from 'three/webgpu'

import type { GaussianSplatData } from './GaussianSplatData'
import { GaussianSplatGeometry } from './GaussianSplatGeometry'
import { GaussianSplatMaterial } from './GaussianSplatMaterial'
import {
  CPUSplatSorter,
  SortTrigger,
  type GaussianSplatSorter,
  type GpuGaussianSplatSorter
} from './GaussianSplatSorter'
import { SplatLodSelector, type SplatLodParams } from './SplatLodSelector'
import {
  computeSplatImportance,
  SplatOctree,
  type SplatOctreeData
} from './SplatOctree'

// Structural view of the renderer parts a splat material's `update` needs.
// Satisfied by both `WebGLRenderer` and the WebGPU `Renderer`.
interface SplatMaterialRenderer {
  getDrawingBufferSize: (target: Vector2) => Vector2
  /** WebGL2 (z −1..1) vs WebGPU (z 0..1) clip space, for frustum extraction. */
  coordinateSystem?: CoordinateSystem
}

/**
 * A material that can render {@link GaussianSplatGeometry}. The WebGL
 * {@link GaussianSplatMaterial} and the WebGPU `GaussianSplatNodeMaterial`
 * (from the `webgpu` entry point) both satisfy this, so the mesh, sorter, and
 * geometry are shared across both render paths.
 */
export interface SplatMaterial extends Material {
  update(renderer: SplatMaterialRenderer, camera: Camera): void
  /**
   * Optional per-view resolve of per-splat render data (e.g. a compute pre-pass
   * that projects each splat and evaluates its view-dependent colour). Called each
   * frame with the mesh's model-view matrix and the camera in mesh-local space.
   * `dispatch` is the splat count to project (non-LOD path) or the GPU-written
   * indirect dispatch attribute (LOD path). Requires a compute-capable renderer.
   */
  updatePrepare?: (
    renderer: SplatMaterialRenderer,
    modelView: Matrix4,
    cameraLocal: Vector3,
    camera: Camera,
    dispatchCount: number,
    setCompactCount: boolean
  ) => void
  /**
   * Order storage attribute (instance → splat id) a GPU sorter / LOD pipeline writes
   * directly. Present on the WebGPU `GaussianSplatNodeMaterial`.
   */
  getOrderAttribute?: () => unknown
  /**
   * Per-splat persistent alpha storage attribute (LOD cross-fade), keyed by splat
   * id; the LOD pipeline ramps it on-GPU. Present on the WebGPU node material.
   */
  getAlphaAttribute?: () => unknown
  /**
   * 1-element drawn-count storage attribute the prepare guard reads; the LOD
   * pipeline writes it on-GPU. Present on the WebGPU node material.
   */
  getCompactCountAttribute?: () => unknown
  /**
   * Uploads a CPU-computed draw order into the order buffer. Lets the WebGPU node
   * path use a CPU/worker sorter (the GPU sorter/pipeline writes the buffer on-GPU).
   */
  uploadOrder?: (indices: Uint32Array) => void
}

/**
 * The GPU LOD pipeline the mesh drives when octree LOD is enabled (satisfied by the
 * WebGPU `SplatLodPipeline` class). Injected via
 * {@link SplatLodMeshOptions.createPipeline} so the renderer-agnostic mesh carries no
 * runtime dependency on `three/webgpu`.
 */
export interface SplatLodPipelineLike {
  uploadLeafTargetLod: (leafTargetLod: Uint32Array) => void
  update: (
    renderer: unknown,
    orderAttr: unknown,
    alphaAttr: unknown,
    compactCountAttr: unknown,
    camX: number,
    camY: number,
    camZ: number,
    fadeStep: number
  ) => boolean
  getDrawIndirect: () => IndirectStorageBufferAttribute
  dispose: () => void
}

/**
 * Enables octree LOD: builds a spatial octree with importance-decimated LOD levels
 * at construction (PlayCanvas's offline-baked structure, built here at load), then
 * each frame chooses a budgeted target LOD per leaf. The injected GPU pipeline
 * expands that into a per-splat temporal cross-fade, compacts the drawn set, sorts
 * it, and draws it indirectly — bounding the rasterized splat count so
 * multi-million-splat clouds stay interactive. WebGPU node material only.
 */
export interface SplatLodMeshOptions {
  /** Max splats rendered per frame. Default 1,000,000. */
  budget?: number
  /** FOV-adjusted distance for the LOD 0→1 transition. Default: bounding radius. */
  lodBaseDistance?: number
  /** Geometric distance multiplier between LOD bands. Default 2. */
  lodMultiplier?: number
  /** Max splats per octree leaf before it subdivides. Default 8192. */
  leafCapacity?: number
  /** Number of LOD levels per node. Default 6. */
  lodLevels?: number
  /** Per-frame alpha step of the LOD cross-fade (0..1). Default 0.1 (~10 frames). */
  fadeStep?: number
  /**
   * Builds the GPU LOD pipeline from the octree (built here), the splat centres, and
   * the count. The WebGPU path passes `(o, p, c) => new SplatLodPipeline(o, p, c)`.
   * Without it, octree LOD is inert (no pipeline to drive).
   */
  createPipeline?: (
    octree: SplatOctreeData,
    positions: Float32Array,
    count: number
  ) => SplatLodPipelineLike
}

export interface GaussianSplatMeshOptions {
  sorter?: GaussianSplatSorter | GpuGaussianSplatSorter
  /** Camera rotation, in degrees, that triggers a re-sort. */
  sortThresholdDegrees?: number
  /**
   * Builds the material from the geometry. Defaults to the WebGL
   * {@link GaussianSplatMaterial}; pass `GaussianSplatNodeMaterial` for WebGPU.
   */
  createMaterial?: (geometry: GaussianSplatGeometry) => SplatMaterial
  /**
   * Enables octree LOD (see {@link SplatLodMeshOptions}). When set with a
   * `createPipeline` factory, the mesh selects a budgeted subset per frame and draws
   * only that — the path that scales to multi-million-splat clouds. WebGPU only.
   */
  lod?: SplatLodMeshOptions
}

const scratchCameraLocal = new Vector3()
const scratchInverseMatrix = new Matrix4()
const scratchView = new Matrix4()
const scratchModelView = new Matrix4()
const scratchProjScreen = new Matrix4()
const scratchFrustum = new Frustum()
const scratchPlanes = new Float32Array(24)

/**
 * Renders a set of 3D Gaussian splats. Drop it into any three.js scene; call
 * {@link update} once per frame (the R3F `<GaussianSplats>` wrapper does this
 * automatically) so the splats are re-sorted as the camera moves.
 */
export class GaussianSplatMesh extends Mesh<
  GaussianSplatGeometry,
  SplatMaterial
> {
  readonly sorter: GaussianSplatSorter | GpuGaussianSplatSorter
  /** LOD/budget parameters; mutate (or call {@link setLodBudget}) to tune live. */
  readonly lodParams: SplatLodParams
  /**
   * Latest LOD selection diagnostics (null until the first selection). `activeCount`
   * is the selected (budgeted) splat count; `visibleLeaves < totalLeaves` means
   * frustum culling dropped leaves this frame.
   */
  lodStats: {
    activeCount: number
    visibleLeaves: number
    totalLeaves: number
  } | null = null
  private readonly trigger: SortTrigger
  private pendingSort = false
  // Synchronous main-thread per-leaf selection (O(leaves), cheap) + the GPU pipeline
  // it feeds. Both null unless octree LOD is enabled with a pipeline factory.
  private readonly lodSelector: SplatLodSelector | null
  private readonly lodPipeline: SplatLodPipelineLike | null
  private lodDirty = true
  // Frames the GPU pipeline keeps running after the last selection change, so the
  // temporal cross-fade settles before a static camera stops costing anything.
  private readonly fadeStep: number
  private readonly fadeFrames: number
  private fadeFramesRemaining = 0

  constructor(data: GaussianSplatData, options: GaussianSplatMeshOptions = {}) {
    const geometry = new GaussianSplatGeometry(data)
    const material = (options.createMaterial ??
      (geometry => new GaussianSplatMaterial(geometry)))(geometry)
    super(geometry, material)

    // Culling is handled per-splat in the vertex shader; the whole cloud is
    // typically partly on-screen, so disable mesh-level frustum culling.
    this.frustumCulled = false
    // After opaque geometry (0), before generic translucency.
    this.renderOrder = 2

    this.sorter = options.sorter ?? new CPUSplatSorter()
    this.trigger = new SortTrigger(options.sortThresholdDegrees)

    // Octree LOD: build the spatial structure + importance-decimated LOD levels
    // once (PlayCanvas bakes this offline; a flat SPZ needs it built at load).
    if (options.lod != null) {
      const importance = computeSplatImportance(
        data.scales,
        data.colors,
        data.count
      )
      const octree = new SplatOctree(data.positions, importance, data.count, {
        leafCapacity: options.lod.leafCapacity,
        lodLevels: options.lod.lodLevels,
        lodMultiplier: options.lod.lodMultiplier
      })
      this.lodSelector = new SplatLodSelector(octree)
      this.lodPipeline =
        options.lod.createPipeline?.(octree, data.positions, data.count) ?? null
      // GPU-driven draw: the pipeline's indirect buffer carries the instance count
      // (the compacted drawn set). `geometry.instanceCount` stays at the full count
      // so Three doesn't skip the object (it's >0); the indirect buffer overrides it.
      if (this.lodPipeline != null) {
        this.geometry.setIndirect(this.lodPipeline.getDrawIndirect())
      }
      this.fadeStep = options.lod.fadeStep ?? 0.1
      this.fadeFrames = Math.ceil(1 / this.fadeStep) + 4
      const radius = this.geometry.boundingSphere?.radius ?? 1
      this.lodParams = {
        budget: options.lod.budget ?? 1_000_000,
        lodBaseDistance: options.lod.lodBaseDistance ?? radius,
        lodMultiplier: options.lod.lodMultiplier ?? 2
      }
    } else {
      this.lodSelector = null
      this.lodPipeline = null
      this.fadeStep = 0.1
      this.fadeFrames = 0
      this.lodParams = { budget: 0, lodBaseDistance: 1, lodMultiplier: 2 }
    }
  }

  /** Sets the LOD splat budget and forces a re-selection on the next update. */
  setLodBudget(budget: number): void {
    this.lodParams.budget = budget
    this.lodDirty = true
  }

  /**
   * Re-sorts the splats back-to-front if the camera has moved enough, and
   * refreshes the projection-dependent material uniforms.
   */
  update(renderer: SplatMaterialRenderer, camera: Camera): void {
    this.material.update(renderer, camera)

    this.updateWorldMatrix(true, false)

    // modelView = inverse(cameraWorld) * meshWorld, from camera.matrixWorld (kept
    // current by the render loop). Camera in mesh-local space drives both the sort
    // and the per-splat SH view direction.
    scratchView.copy(camera.matrixWorld).invert()
    scratchModelView.multiplyMatrices(scratchView, this.matrixWorld)
    scratchInverseMatrix.copy(this.matrixWorld).invert()
    scratchCameraLocal
      .setFromMatrixPosition(camera.matrixWorld)
      .applyMatrix4(scratchInverseMatrix)

    // Fully-GPU LOD path: pick a per-leaf target LOD on the camera-rotation trigger
    // (cheap, O(leaves)), then drive the GPU pipeline (per-splat alpha ramp →
    // compaction → sort → indirect args) while the temporal cross-fade settles. The
    // prepare projects only the GPU-compacted drawn set, and the draw is indirect.
    if (this.lodSelector != null && this.lodPipeline != null) {
      const moved =
        this.lodDirty ||
        this.trigger.shouldSort(scratchCameraLocal, this.geometry.centroid)
      if (moved) {
        // Frustum in splat-local space (clip = projection · modelView), packed as
        // 6 inward planes; leaves fully off-screen are dropped from the budget.
        scratchProjScreen.multiplyMatrices(
          camera.projectionMatrix,
          scratchModelView
        )
        scratchFrustum.setFromProjectionMatrix(
          scratchProjScreen,
          renderer.coordinateSystem ?? WebGLCoordinateSystem
        )
        for (let p = 0; p < 6; p++) {
          const plane = scratchFrustum.planes[p]
          scratchPlanes[p * 4] = plane.normal.x
          scratchPlanes[p * 4 + 1] = plane.normal.y
          scratchPlanes[p * 4 + 2] = plane.normal.z
          scratchPlanes[p * 4 + 3] = plane.constant
        }
        const result = this.lodSelector.select(
          scratchCameraLocal.x,
          scratchCameraLocal.y,
          scratchCameraLocal.z,
          scratchPlanes,
          this.lodParams
        )
        this.lodPipeline.uploadLeafTargetLod(result.leafTargetLod)
        this.lodStats = {
          activeCount: result.selectedCount,
          visibleLeaves: result.visibleLeaves,
          totalLeaves: result.totalLeaves
        }
        this.lodDirty = false
        this.trigger.markSorted(scratchCameraLocal, this.geometry.centroid)
        // Keep the pipeline running long enough for the cross-fade to complete.
        this.fadeFramesRemaining = this.fadeFrames
      }

      if (moved || this.fadeFramesRemaining > 0) {
        const ran = this.lodPipeline.update(
          renderer,
          this.material.getOrderAttribute?.(),
          this.material.getAlphaAttribute?.(),
          this.material.getCompactCountAttribute?.(),
          scratchCameraLocal.x,
          scratchCameraLocal.y,
          scratchCameraLocal.z,
          this.fadeStep
        )
        // Only count down once the pipeline is actually running (the first frame(s)
        // no-op while Three lazily creates the storage/indirect buffers).
        if (ran && !moved) {
          this.fadeFramesRemaining--
        }
        // Prepare: over-dispatch the loaded count (the in-shader guard clips the
        // heavy projection to the GPU-compacted drawn set). `setCompactCount = false`
        // leaves the compact-count buffer to the pipeline. Always dispatched here
        // (also on warm-up, so the compute creates the material's storage buffers).
        this.material.updatePrepare?.(
          renderer,
          scratchModelView,
          scratchCameraLocal,
          camera,
          this.geometry.count,
          false
        )
      }
      // Settled + static: the last GPU state (order, alpha, indirect args) persists,
      // so the continuous render keeps drawing the correct frame at no extra cost.
      return
    }

    // Non-LOD path: resolve per-splat render data over the whole cloud (the prepare
    // pass projects all `instanceCount` splats), gated on view change inside the
    // material. `setCompactCount = true` sets the prepare guard to the full count.
    // No-op for materials without it (the WebGL path projects per vertex).
    this.material.updatePrepare?.(
      renderer,
      scratchModelView,
      scratchCameraLocal,
      camera,
      this.geometry.instanceCount,
      true
    )

    // GPU sorter: dispatches a compute sort that writes the order buffer directly
    // on the GPU — no indices returned, no per-sort index upload. Gated on the
    // same camera-rotation threshold as the CPU path.
    const sorter = this.sorter
    if ('isGpuSplatSorter' in sorter) {
      if (this.trigger.shouldSort(scratchCameraLocal, this.geometry.centroid)) {
        sorter.sortGpu(
          renderer,
          this.material.getOrderAttribute?.(),
          this.geometry.splatPositions,
          scratchCameraLocal,
          this.geometry.count
        )
        this.trigger.markSorted(scratchCameraLocal, this.geometry.centroid)
      }
      return
    }

    if (
      this.pendingSort ||
      !this.trigger.shouldSort(scratchCameraLocal, this.geometry.centroid)
    ) {
      return
    }

    const result = sorter.sort(
      this.geometry.splatPositions,
      scratchCameraLocal,
      this.geometry.count
    )
    this.trigger.markSorted(scratchCameraLocal, this.geometry.centroid)

    // WebGPU node material consumes order from its storage buffer (uploadOrder);
    // the WebGL material consumes the geometry's splatIndex attribute.
    const apply = (indices: Uint32Array): void => {
      if (this.material.uploadOrder != null) {
        this.material.uploadOrder(indices)
      } else {
        this.geometry.setSortedIndices(indices)
      }
    }

    if (result instanceof Promise) {
      this.pendingSort = true
      void result.then(indices => {
        apply(indices)
        this.pendingSort = false
      })
    } else {
      apply(result)
    }
  }

  dispose(): void {
    this.geometry.dispose()
    this.material.dispose()
    this.sorter.dispose()
    this.lodPipeline?.dispose()
  }
}
