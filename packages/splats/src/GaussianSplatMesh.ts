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
import { computeSplatImportance, SplatOctree } from './SplatOctree'

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
   * Optional per-view colour resolve (e.g. a view-dependent SH compute pre-pass).
   * Called when the camera moves, with the camera in the mesh's local space.
   * Requires a compute-capable renderer (the WebGPU `Renderer`).
   */
  /**
   * Optional per-view resolve of per-splat render data (e.g. a compute pre-pass
   * that projects each splat and evaluates its view-dependent colour). Called each
   * frame with the mesh's model-view matrix and the camera in mesh-local space.
   * Requires a compute-capable renderer (the WebGPU `Renderer`).
   */
  updatePrepare?: (
    renderer: SplatMaterialRenderer,
    modelView: Matrix4,
    cameraLocal: Vector3,
    camera: Camera,
    activeCount: number
  ) => void
  /**
   * Order storage attribute (instance → splat id) a GPU sorter writes directly.
   * Present on the WebGPU `GaussianSplatNodeMaterial`. The mesh passes it to a
   * {@link GpuGaussianSplatSorter}.
   */
  getOrderAttribute?: () => unknown
  /**
   * Uploads a CPU-computed draw order into the order buffer. Lets the WebGPU node
   * path use a CPU/worker sorter (the GPU sorter writes the buffer on-GPU instead).
   */
  uploadOrder?: (indices: Uint32Array) => void
}

/**
 * Enables octree LOD: builds a spatial octree with importance-decimated LOD levels
 * at construction (PlayCanvas's offline-baked structure, built here at load), then
 * each frame renders only a budgeted subset chosen by distance. Bounds the
 * rasterized splat count so multi-million-splat clouds stay interactive.
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
   * Enables octree LOD (see {@link SplatLodMeshOptions}). When set, the mesh
   * selects a budgeted subset per frame instead of sorting/drawing every splat —
   * the path that scales to multi-million-splat clouds. WebGPU node material only.
   */
  lod?: SplatLodMeshOptions
}

const scratchCameraLocal = new Vector3()
const scratchInverseMatrix = new Matrix4()
const scratchView = new Matrix4()
const scratchModelView = new Matrix4()
const scratchProjScreen = new Matrix4()
const scratchFrustum = new Frustum()

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
  private readonly trigger: SortTrigger
  private pendingSort = false
  private readonly lodSelector: SplatLodSelector | null
  private lodDirty = true

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
      this.lodSelector = new SplatLodSelector(octree, data.positions)
      const radius = this.geometry.boundingSphere?.radius ?? 1
      this.lodParams = {
        budget: options.lod.budget ?? 1_000_000,
        lodBaseDistance: options.lod.lodBaseDistance ?? radius,
        lodMultiplier: options.lod.lodMultiplier ?? 2
      }
    } else {
      this.lodSelector = null
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

    // LOD path FIRST: pick a budgeted subset by octree LOD + distance, sorted
    // back-to-front, and draw only that (instanceCount = the subset). Bounds the
    // rasterized count for multi-million-splat clouds. Gated on the camera-rotation
    // threshold (or a budget change), so a static camera costs nothing. Runs before
    // the prepare pass so the prepare projects only the active subset.
    if (this.lodSelector != null) {
      if (
        this.lodDirty ||
        this.trigger.shouldSort(scratchCameraLocal, this.geometry.centroid)
      ) {
        // Frustum in splat-local space (clip = projection · modelView), so leaves
        // fully off-screen are dropped — the budget then goes to what's visible.
        scratchProjScreen.multiplyMatrices(
          camera.projectionMatrix,
          scratchModelView
        )
        scratchFrustum.setFromProjectionMatrix(
          scratchProjScreen,
          renderer.coordinateSystem ?? WebGLCoordinateSystem
        )
        const result = this.lodSelector.select(
          scratchCameraLocal,
          scratchFrustum,
          this.lodParams
        )
        const active = result.indices.subarray(0, result.count)
        if (this.material.uploadOrder != null) {
          this.material.uploadOrder(active)
        } else {
          this.geometry.setSortedIndices(active)
        }
        this.geometry.instanceCount = result.count
        this.trigger.markSorted(scratchCameraLocal, this.geometry.centroid)
        this.lodDirty = false
      }
    }

    // Resolve per-splat render data (screen-space projection + colour) for this
    // view — a GPU compute pre-pass over the active subset (`instanceCount`),
    // gated on view/count change inside the material so a static camera costs
    // nothing. No-op for materials without it (the WebGL path projects per vertex).
    this.material.updatePrepare?.(
      renderer,
      scratchModelView,
      scratchCameraLocal,
      camera,
      this.geometry.instanceCount
    )

    // LOD path already set the draw order; no separate sorter pass.
    if (this.lodSelector != null) {
      return
    }

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
  }
}
