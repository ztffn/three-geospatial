import {
  Matrix4,
  Mesh,
  Vector3,
  type Camera,
  type WebGLRenderer
} from 'three'

import type { GaussianSplatData } from './GaussianSplatData'
import { GaussianSplatGeometry } from './GaussianSplatGeometry'
import { GaussianSplatMaterial } from './GaussianSplatMaterial'
import {
  CPUSplatSorter,
  SortTrigger,
  type GaussianSplatSorter
} from './GaussianSplatSorter'

export interface GaussianSplatMeshOptions {
  sorter?: GaussianSplatSorter
  /** Camera rotation, in degrees, that triggers a re-sort. */
  sortThresholdDegrees?: number
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
  GaussianSplatMaterial
> {
  readonly sorter: GaussianSplatSorter
  private readonly trigger: SortTrigger
  private pendingSort = false

  constructor(data: GaussianSplatData, options: GaussianSplatMeshOptions = {}) {
    const geometry = new GaussianSplatGeometry(data)
    const material = new GaussianSplatMaterial(geometry)
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
  update(renderer: WebGLRenderer, camera: Camera): void {
    this.material.update(renderer, camera)

    // Transform the camera into the mesh's local space so the sort matches the
    // coordinates baked into the geometry.
    this.updateWorldMatrix(true, false)
    scratchInverseMatrix.copy(this.matrixWorld).invert()
    scratchCameraLocal
      .setFromMatrixPosition(camera.matrixWorld)
      .applyMatrix4(scratchInverseMatrix)

    if (
      this.pendingSort ||
      !this.trigger.shouldSort(scratchCameraLocal, this.geometry.centroid)
    ) {
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
