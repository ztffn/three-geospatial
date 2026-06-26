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
  shDegreeToCoefficientCount,
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
// Same corners as a vec3 `position` attribute. The WebGPU node material fully
// overrides the clip position in its `vertexNode`, but `MeshBasicNodeMaterial`'s
// default depth/MRT nodes still reference the built-in `position` attribute, so
// the geometry must provide one or the node builder throws ("attribute position
// not found"). Unused by the WebGL ShaderMaterial path.
const QUAD_POSITIONS = new Float32Array([
  -2, -2, 0, 2, -2, 0, 2, 2, 0, -2, 2, 0
])
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

function clampByte(x: number): number {
  const r = Math.round(x)
  return r < 0 ? 0 : r > 255 ? 255 : r
}

interface ShTextureResult {
  texture: DataTexture | null
  size: Vector2
  degree: 0 | 1 | 2 | 3
  coefficientCount: number
  rangeMin: number
  rangeScale: number
}

/**
 * Byte-quantizes the view-dependent SH rest-coefficients into an RGBA8 data
 * texture, one texel per coefficient (RGB = the coefficient's three channels, A
 * unused). Texels are packed `count * coefficientCount` in row-major order,
 * addressed `splatIndex * coefficientCount + coefficient`. Values map from a
 * global `[min, max]` range to bytes (mkkellogg-style 8-bit SH compression);
 * the material recovers them with the returned `rangeMin` / `rangeScale`.
 * Returns a null texture when the source carries no SH.
 */
function buildShTexture(data: GaussianSplatData): ShTextureResult {
  const empty: ShTextureResult = {
    texture: null,
    size: new Vector2(1, 1),
    degree: 0,
    coefficientCount: 0,
    rangeMin: 0,
    rangeScale: 1
  }
  const { sh, shDegree, count } = data
  if (sh == null || shDegree == null || shDegree === 0 || count === 0) {
    return empty
  }
  const coefficientCount = shDegreeToCoefficientCount(shDegree)
  if (coefficientCount === 0) {
    return empty
  }

  // Global value range for the byte quantization.
  let min = Infinity
  let max = -Infinity
  for (let i = 0; i < sh.length; ++i) {
    const v = sh[i]
    if (v < min) min = v
    if (v > max) max = v
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    min = -1
    max = 1
  }
  const range = max - min
  const invRange = 255 / range

  const totalTexels = count * coefficientCount
  // Square-ish; width rounded to a multiple of 64 so the RGBA8 row is a multiple
  // of 256 bytes (WebGPU writeTexture alignment). Minimal dimensions so large
  // clouds stay within the adapter's max-texture limit.
  const width = Math.max(
    64,
    Math.ceil(Math.ceil(Math.sqrt(totalTexels)) / 64) * 64
  )
  const height = Math.max(1, Math.ceil(totalTexels / width))

  const texData = new Uint8Array(width * height * 4)
  for (let i = 0; i < count; ++i) {
    for (let j = 0; j < coefficientCount; ++j) {
      const dst = (i * coefficientCount + j) * 4
      const src = (i * coefficientCount + j) * 3
      texData[dst] = clampByte((sh[src] - min) * invRange)
      texData[dst + 1] = clampByte((sh[src + 1] - min) * invRange)
      texData[dst + 2] = clampByte((sh[src + 2] - min) * invRange)
      texData[dst + 3] = 255
    }
  }

  const texture = new DataTexture(
    texData,
    width,
    height,
    RGBAFormat,
    UnsignedByteType
  )
  texture.minFilter = NearestFilter
  texture.magFilter = NearestFilter
  texture.needsUpdate = true

  return {
    texture,
    size: new Vector2(width, height),
    degree: shDegree,
    coefficientCount,
    rangeMin: min,
    rangeScale: range
  }
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

  /**
   * View-dependent SH rest-coefficients (degrees 1-3), byte-quantized one RGBA8
   * texel per coefficient (RGB = coefficient, A unused). Null when the source
   * carries no SH. The material samples `shCoefficientCount` consecutive texels
   * per splat and dequantizes via `[shRangeMin, shRangeMin + shRangeScale]`.
   */
  readonly shTexture: DataTexture | null
  readonly shTextureSize: Vector2
  readonly shDegree: 0 | 1 | 2 | 3
  readonly shCoefficientCount: number
  readonly shRangeMin: number
  readonly shRangeScale: number

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
    // Left as raw bytes (no sRGB colour-space flag): the byte colours are 3DGS
    // display values (`0.5 + SH_C0 * f_dc`), and the material does the colour
    // management in-shader — it adds the view-dependent SH in this display space,
    // clamps, then converts display→linear once before output so the renderer's
    // linear→sRGB encode round-trips the result (see GaussianSplatNodeMaterial).
    this.colorTexture.needsUpdate = true

    const sh = buildShTexture(data)
    this.shTexture = sh.texture
    this.shTextureSize = sh.size
    this.shDegree = sh.degree
    this.shCoefficientCount = sh.coefficientCount
    this.shRangeMin = sh.rangeMin
    this.shRangeScale = sh.rangeScale

    // Base quad shared by every instance (per-vertex attribute).
    const quadAttribute = new BufferAttribute(QUAD_OFFSETS, 2)
    quadAttribute.setUsage(StaticDrawUsage)
    this.setAttribute('quadOffset', quadAttribute)
    // Placeholder `position` so node-material depth/MRT nodes resolve; the
    // material's vertexNode supplies the real clip position.
    const positionAttribute = new BufferAttribute(QUAD_POSITIONS, 3)
    positionAttribute.setUsage(StaticDrawUsage)
    this.setAttribute('position', positionAttribute)
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
    this.shTexture?.dispose()
    super.dispose()
  }
}
