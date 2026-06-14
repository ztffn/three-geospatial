import type { BufferAttribute } from 'three'
import type {
  GLTFLoaderPlugin,
  GLTFParser
} from 'three/examples/jsm/loaders/GLTFLoader.js'

import type { GaussianSplatData } from './GaussianSplatData'
import { GaussianSplatMesh } from './GaussianSplatMesh'

export const KHR_GAUSSIAN_SPLATTING = 'KHR_gaussian_splatting'
export const KHR_GAUSSIAN_SPLATTING_COMPRESSION_SPZ =
  'KHR_gaussian_splatting_compression_spz'

interface MeshPrimitiveDef {
  attributes: Record<string, number>
  extensions?: Record<string, unknown>
}

function toFloat32(attribute: BufferAttribute): Float32Array {
  const { array } = attribute
  return array instanceof Float32Array ? array : new Float32Array(array)
}

function toRGBA(attribute: BufferAttribute, count: number): Uint8Array {
  const colors = new Uint8Array(count * 4)
  const { itemSize, normalized } = attribute
  const isByte = attribute.array instanceof Uint8Array
  for (let i = 0; i < count; ++i) {
    for (let c = 0; c < 4; ++c) {
      let value: number
      if (c < itemSize) {
        const raw = attribute.array[i * itemSize + c]
        // Normalize floats to bytes; pass through already-byte values.
        value = isByte && normalized ? raw : Math.round(raw * 255)
      } else {
        value = 255 // default opaque alpha when COLOR_0 is VEC3
      }
      colors[i * 4 + c] = Math.max(0, Math.min(255, value))
    }
  }
  return colors
}

/**
 * Three.js {@link GLTFLoaderPlugin} that turns mesh primitives carrying the
 * `KHR_gaussian_splatting` extension into {@link GaussianSplatMesh} instances.
 *
 * Register it through `3d-tiles-renderer`'s `GLTFExtensionsPlugin`:
 *
 * ```ts
 * new GLTFExtensionsPlugin({
 *   plugins: [parser => new KhrGaussianSplattingExtension(parser)]
 * })
 * ```
 *
 * Note: the `_ROTATION` accessor is read as glTF-convention XYZW and converted
 * to the WXYZ order used by {@link GaussianSplatData}. The exact attribute
 * semantics of the draft extension should be verified against real datasets.
 */
export class KhrGaussianSplattingExtension implements GLTFLoaderPlugin {
  readonly name = KHR_GAUSSIAN_SPLATTING
  readonly parser: GLTFParser

  constructor(parser: GLTFParser) {
    this.parser = parser
  }

  // Returns `null` synchronously to defer to the default loader; the GLTFLoader
  // plugin contract uses this to fall through to the next handler.
  loadMesh(meshIndex: number): Promise<GaussianSplatMesh> | null {
    const json = this.parser.json as {
      meshes?: Array<{ primitives: MeshPrimitiveDef[] }>
    }
    const meshDef = json.meshes?.[meshIndex]
    const primitive = meshDef?.primitives[0]
    if (primitive?.extensions?.[KHR_GAUSSIAN_SPLATTING] == null) {
      return null
    }
    if (primitive.extensions[KHR_GAUSSIAN_SPLATTING_COMPRESSION_SPZ] != null) {
      throw new Error(
        `${KHR_GAUSSIAN_SPLATTING_COMPRESSION_SPZ} is not yet supported; ` +
          'provide uncompressed splat attributes.'
      )
    }
    return this.loadSplatMesh(primitive)
  }

  private async loadSplatMesh(
    primitive: MeshPrimitiveDef
  ): Promise<GaussianSplatMesh> {
    const { attributes } = primitive
    const required = ['POSITION', '_SCALE', '_ROTATION', 'COLOR_0']
    for (const name of required) {
      if (attributes[name] == null) {
        throw new Error(
          `${KHR_GAUSSIAN_SPLATTING} primitive is missing attribute ${name}`
        )
      }
    }

    const [positionAttr, scaleAttr, rotationAttr, colorAttr] = await Promise.all(
      [
        this.parser.getDependency('accessor', attributes.POSITION),
        this.parser.getDependency('accessor', attributes._SCALE),
        this.parser.getDependency('accessor', attributes._ROTATION),
        this.parser.getDependency('accessor', attributes.COLOR_0)
      ]
    )

    const count = (positionAttr as BufferAttribute).count
    const positions = toFloat32(positionAttr as BufferAttribute)
    const scales = toFloat32(scaleAttr as BufferAttribute)
    const colors = toRGBA(colorAttr as BufferAttribute, count)

    // Convert glTF XYZW quaternions to the canonical WXYZ layout.
    const xyzw = toFloat32(rotationAttr as BufferAttribute)
    const rotations = new Float32Array(count * 4)
    for (let i = 0; i < count; ++i) {
      rotations[i * 4] = xyzw[i * 4 + 3] // w
      rotations[i * 4 + 1] = xyzw[i * 4] // x
      rotations[i * 4 + 2] = xyzw[i * 4 + 1] // y
      rotations[i * 4 + 3] = xyzw[i * 4 + 2] // z
    }

    const data: GaussianSplatData = {
      count,
      positions,
      scales,
      rotations,
      colors
    }
    return new GaussianSplatMesh(data)
  }
}
