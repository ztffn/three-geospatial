import {
  Matrix4,
  Mesh,
  Vector3,
  type Camera,
  type Material,
  type Vector2
} from 'three'

import type { GaussianSplatData } from './GaussianSplatData'
import { GaussianSplatGeometry } from './GaussianSplatGeometry'
import { GaussianSplatMaterial } from './GaussianSplatMaterial'
import {
  CPUSplatSorter,
  SortTrigger,
  type GaussianSplatSorter
} from './GaussianSplatSorter'

// Structural view of the renderer parts a splat material's `update` needs.
// Satisfied by both `WebGLRenderer` and the WebGPU `Renderer`.
interface SplatMaterialRenderer {
  getDrawingBufferSize: (target: Vector2) => Vector2
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
  updateColors?: (renderer: SplatMaterialRenderer, cameraLocal: Vector3) => void
}

export interface GaussianSplatMeshOptions {
  sorter?: GaussianSplatSorter
  /** Camera rotation, in degrees, that triggers a re-sort. */
  sortThresholdDegrees?: number
  /**
   * Builds the material from the geometry. Defaults to the WebGL
   * {@link GaussianSplatMaterial}; pass `GaussianSplatNodeMaterial` for WebGPU.
   */
  createMaterial?: (geometry: GaussianSplatGeometry) => SplatMaterial
}

const scratchCameraLocal = new Vector3()
const scratchInverseMatrix = new Matrix4()

/**
 * Renders a set of 3D Gaussian splats. Drop it into any three.js scene; call
 * {@link update} once per frame (the R3F `<GaussianSplats>` wrapper does this
 * automatically) so the splats are re-sorted as the camera moves.
 */
export class GaussianSplatMesh extends Mesh<
  GaussianSplatGeometry,
  SplatMaterial
> {
  readonly sorter: GaussianSplatSorter
  private readonly trigger: SortTrigger
  private pendingSort = false

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
  }

  /**
   * Re-sorts the splats back-to-front if the camera has moved enough, and
   * refreshes the projection-dependent material uniforms.
   */
  update(renderer: SplatMaterialRenderer, camera: Camera): void {
    this.material.update(renderer, camera)

    // Transform the camera into the mesh's local space so the sort matches the
    // coordinates baked into the geometry.
    this.updateWorldMatrix(true, false)
    scratchInverseMatrix.copy(this.matrixWorld).invert()
    scratchCameraLocal
      .setFromMatrixPosition(camera.matrixWorld)
      .applyMatrix4(scratchInverseMatrix)

    const moved = this.trigger.shouldSort(
      scratchCameraLocal,
      this.geometry.centroid
    )
    // Re-resolve view-dependent colours (a GPU compute pre-pass) whenever the
    // camera moves — independent of the sort, which the worker may still be
    // running. No-op for materials without a per-view colour pass.
    if (moved) {
      this.material.updateColors?.(renderer, scratchCameraLocal)
    }
    if (this.pendingSort || !moved) {
      return
    }

    const result = this.sorter.sort(
      this.geometry.splatPositions,
      scratchCameraLocal,
      this.geometry.count
    )
    this.trigger.markSorted(scratchCameraLocal, this.geometry.centroid)

    if (result instanceof Promise) {
      this.pendingSort = true
      void result.then(indices => {
        this.geometry.setSortedIndices(indices)
        this.pendingSort = false
      })
    } else {
      this.geometry.setSortedIndices(result)
    }
  }

  dispose(): void {
    this.geometry.dispose()
    this.material.dispose()
    this.sorter.dispose()
  }
}
