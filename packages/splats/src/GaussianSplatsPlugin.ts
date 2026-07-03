import type { Camera, Object3D, WebGLRenderer } from 'three'

import { GaussianSplatMesh } from './GaussianSplatMesh'

// Minimal structural view of the parts of `TilesRenderer` this plugin uses.
// Kept structural so the package does not hard-depend on a specific
// `3d-tiles-renderer` version (it is an optional peer dependency).
interface TileModelEvent {
  scene: Object3D
}

interface TilesRendererLike {
  addEventListener: (type: string, listener: (event: never) => void) => void
  removeEventListener: (type: string, listener: (event: never) => void) => void
}

export interface GaussianSplatsPluginOptions {
  /** Render order applied to every splat mesh found in loaded tiles. */
  renderOrder?: number
}

/**
 * `3d-tiles-renderer` plugin that integrates {@link GaussianSplatMesh} content
 * delivered by tiles. It does not parse glTF itself — register
 * {@link KhrGaussianSplattingExtension} with `GLTFExtensionsPlugin` for that —
 * it tracks the splat meshes that appear in loaded tiles, configures their
 * render order, and drives per-frame sorting via {@link update}.
 */
export class GaussianSplatsPlugin {
  readonly name = 'GAUSSIAN_SPLATS_PLUGIN'
  private readonly renderOrder: number
  private tiles: TilesRendererLike | null = null
  private readonly meshes = new Set<GaussianSplatMesh>()

  constructor(options: GaussianSplatsPluginOptions = {}) {
    this.renderOrder = options.renderOrder ?? 2
  }

  init(tiles: TilesRendererLike): void {
    this.tiles = tiles
    tiles.addEventListener('load-model', this.handleLoadModel as never)
    tiles.addEventListener('dispose-model', this.handleDisposeModel as never)
  }

  /** Re-sorts every tracked splat mesh and refreshes its uniforms. */
  update(renderer: WebGLRenderer, camera: Camera): void {
    for (const mesh of this.meshes) {
      mesh.update(renderer, camera)
    }
  }

  private readonly handleLoadModel = (event: TileModelEvent): void => {
    event.scene.traverse(object => {
      if (object instanceof GaussianSplatMesh) {
        object.renderOrder = this.renderOrder
        this.meshes.add(object)
      }
    })
  }

  private readonly handleDisposeModel = (event: TileModelEvent): void => {
    event.scene.traverse(object => {
      if (object instanceof GaussianSplatMesh) {
        this.meshes.delete(object)
        object.dispose()
      }
    })
  }

  dispose(): void {
    this.tiles?.removeEventListener('load-model', this.handleLoadModel as never)
    this.tiles?.removeEventListener(
      'dispose-model',
      this.handleDisposeModel as never
    )
    for (const mesh of this.meshes) {
      mesh.dispose()
    }
    this.meshes.clear()
  }
}
