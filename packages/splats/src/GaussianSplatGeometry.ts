import {
  BufferAttribute,
  DataTexture,
  FloatType,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  NearestFilter,
  RGBAFormat,
  Sphere,
  StaticDrawUsage,
  DynamicDrawUsage,
  UnsignedByteType,
  Vector2,
  Vector3
} from 'three'

import {
  computeSplatBounds,
  validateGaussianSplatData,
  type GaussianSplatData
} from './GaussianSplatData'

// Width of the square-ish data textures that hold per-splat attributes. Splats
// index into these textures via `texelFetch`, so the only constraint is staying
// within `MAX_TEXTURE_SIZE` (2048 is universally supported).
const TEXTURE_WIDTH = 2048

// Quad corners in standard-deviation units. The fragment shader discards beyond
// ~2 sigma, so a half-extent of 2 fully covers each Gaussian's support.
const QUAD_OFFSETS = new Float32Array([-2, -2, 2, -2, 2, 2, -2, 2])
const QUAD_INDICES = [0, 1, 2, 0, 2, 3]

function quatToCovariance(
  sx: number,
  sy: number,
  sz: number,
  w: number,
  x: number,
  y: number,
  z: number,
  out: Float32Array
): void {
  // Rotation matrix columns from the (already normalized) quaternion.
  const r00 = 1 - 2 * (y * y + z * z)
  const r01 = 2 * (x * y - w * z)
  const r02 = 2 * (x * z + w * y)
  const r10 = 2 * (x * y + w * z)
  const r11 = 1 - 2 * (x * x + z * z)
  const r12 = 2 * (y * z - w * x)
  const r20 = 2 * (x * z - w * y)
  const r21 = 2 * (y * z + w * x)
  const r22 = 1 - 2 * (x * x + y * y)

  // M = R * diag(s); columns scaled by the exponentiated scales.
  const m00 = r00 * sx
  const m01 = r01 * sy
  const m02 = r02 * sz
  const m10 = r10 * sx
  const m11 = r11 * sy
  const m12 = r12 * sz
  const m20 = r20 * sx
  const m21 = r21 * sy
  const m22 = r22 * sz

  // Sigma = M * M^T (symmetric; store the 6 unique entries).
  out[0] = m00 * m00 + m01 * m01 + m02 * m02 // 00
  out[1] = m00 * m10 + m01 * m11 + m02 * m12 // 01
  out[2] = m00 * m20 + m01 * m21 + m02 * m22 // 02
  out[3] = m10 * m10 + m11 * m11 + m12 * m12 // 11
  out[4] = m10 * m20 + m11 * m21 + m12 * m22 // 12
  out[5] = m20 * m20 + m21 * m21 + m22 * m22 // 22
}

function createFloatTexture(data: Float32Array, height: number): DataTexture {
  const texture = new DataTexture(
    data,
    TEXTURE_WIDTH,
    height,
    RGBAFormat,
    FloatType
  )
  texture.minFilter = NearestFilter
  texture.magFilter = NearestFilter
  texture.needsUpdate = true
  return texture
}

/**
 * An {@link InstancedBufferGeometry} that renders one screen-aligned quad per
 * splat. Per-splat attributes are uploaded once into data textures; the only
 * per-frame upload is the `splatIndex` ordering produced by the sorter.
 */
export class GaussianSplatGeometry extends InstancedBufferGeometry {
  readonly count: number
  readonly textureSize: Vector2
  readonly centroid: Vector3

  /** `count * 3` splat centers retained on the CPU for the sorter. */
  readonly splatPositions: Float32Array

  readonly positionTexture: DataTexture
  readonly covATexture: DataTexture
  readonly covBTexture: DataTexture
  readonly colorTexture: DataTexture

  private readonly splatIndexAttribute: InstancedBufferAttribute

  constructor(data: GaussianSplatData) {
    super()
    validateGaussianSplatData(data)
    const { count, positions, scales, rotations, colors } = data
    this.count = count
    this.splatPositions = positions

    const height = Math.max(1, Math.ceil(count / TEXTURE_WIDTH))
    const texels = TEXTURE_WIDTH * height
    this.textureSize = new Vector2(TEXTURE_WIDTH, height)

    // RGBA32F: position.xyz + opacity (opacity copied from the color alpha so
    // it is available without sampling the byte texture in the vertex stage).
    const positionData = new Float32Array(texels * 4)
    // Two RGBA32F textures hold the 6 covariance entries (last channel unused).
    const covAData = new Float32Array(texels * 4)
    const covBData = new Float32Array(texels * 4)
    const colorData = new Uint8Array(texels * 4)

    const covScratch = new Float32Array(6)
    for (let i = 0; i < count; ++i) {
      positionData[i * 4] = positions[i * 3]
      positionData[i * 4 + 1] = positions[i * 3 + 1]
      positionData[i * 4 + 2] = positions[i * 3 + 2]
      positionData[i * 4 + 3] = colors[i * 4 + 3] / 255

      quatToCovariance(
        Math.exp(scales[i * 3]),
        Math.exp(scales[i * 3 + 1]),
        Math.exp(scales[i * 3 + 2]),
        rotations[i * 4],
        rotations[i * 4 + 1],
        rotations[i * 4 + 2],
        rotations[i * 4 + 3],
        covScratch
      )
      covAData[i * 4] = covScratch[0]
      covAData[i * 4 + 1] = covScratch[1]
      covAData[i * 4 + 2] = covScratch[2]
      covBData[i * 4] = covScratch[3]
      covBData[i * 4 + 1] = covScratch[4]
      covBData[i * 4 + 2] = covScratch[5]

      colorData[i * 4] = colors[i * 4]
      colorData[i * 4 + 1] = colors[i * 4 + 1]
      colorData[i * 4 + 2] = colors[i * 4 + 2]
      colorData[i * 4 + 3] = colors[i * 4 + 3]
    }

    this.positionTexture = createFloatTexture(positionData, height)
    this.covATexture = createFloatTexture(covAData, height)
    this.covBTexture = createFloatTexture(covBData, height)
    this.colorTexture = new DataTexture(
      colorData,
      TEXTURE_WIDTH,
      height,
      RGBAFormat,
      UnsignedByteType
    )
    this.colorTexture.minFilter = NearestFilter
    this.colorTexture.magFilter = NearestFilter
    this.colorTexture.needsUpdate = true

    // Base quad shared by every instance (per-vertex attribute).
    const quadAttribute = new BufferAttribute(QUAD_OFFSETS, 2)
    quadAttribute.setUsage(StaticDrawUsage)
    this.setAttribute('quadOffset', quadAttribute)
    this.setIndex(QUAD_INDICES)

    // Per-instance ordering, rewritten each sort. Stored as float to match the
    // `in float splatIndex` vertex attribute (integers are exact in f32 up to
    // 2^24, far beyond the ~4.2M-splat texture capacity).
    const splatIndices = new Float32Array(count)
    for (let i = 0; i < count; ++i) {
      splatIndices[i] = i
    }
    this.splatIndexAttribute = new InstancedBufferAttribute(splatIndices, 1)
    this.splatIndexAttribute.setUsage(DynamicDrawUsage)
    this.setAttribute('splatIndex', this.splatIndexAttribute)
    this.instanceCount = count

    const bounds = computeSplatBounds(data)
    this.centroid = bounds.getCenter(new Vector3())
    this.boundingBox = bounds.clone()
    this.boundingSphere = bounds.getBoundingSphere(new Sphere())
  }

  /** Uploads a new draw order produced by the sorter. */
  setSortedIndices(indices: Uint32Array): void {
    const array = this.splatIndexAttribute.array as Float32Array
    array.set(indices.subarray(0, this.count))
    this.splatIndexAttribute.needsUpdate = true
  }

  override dispose(): void {
    this.positionTexture.dispose()
    this.covATexture.dispose()
    this.covBTexture.dispose()
    this.colorTexture.dispose()
    super.dispose()
  }
}
