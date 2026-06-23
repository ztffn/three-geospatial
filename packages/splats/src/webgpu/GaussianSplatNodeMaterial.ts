// WebGPU/TSL node material for 3D Gaussian splats. Ports the verified WebGL
// `GaussianSplatMaterial` EWA projection into a full TSL `vertexNode` (clip-space
// covariance expansion) plus an `outputNode` with two compositing modes:
// `premultiplied` (sort-ordered "over" blend, standalone default) and `dither`
// (stochastic discard → opaque geometry that occludes + tints under TAA, for the
// deferred-atmosphere twin). Shares `GaussianSplatGeometry` + sorter with WebGL.

import {
  AddEquation,
  CustomBlending,
  DoubleSide,
  NoBlending,
  OneFactor,
  OneMinusSrcAlphaFactor,
  Vector2,
  type Camera
} from 'three'
import {
  attribute,
  cameraFar,
  cameraNear,
  cameraProjectionMatrix,
  Discard,
  float,
  Fn,
  int,
  ivec2,
  mat3,
  modelViewMatrix,
  screenCoordinate,
  texture,
  transpose,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
  viewZToLogarithmicDepth,
  viewZToPerspectiveDepth
} from 'three/tsl'
import { MeshBasicNodeMaterial } from 'three/webgpu'

import type { GaussianSplatGeometry } from '../GaussianSplatGeometry'

// Structural view of the renderer parts `update` needs. Satisfied by both
// `WebGLRenderer` and the WebGPU `Renderer`.
interface RendererLike {
  getDrawingBufferSize: (target: Vector2) => Vector2
}

export interface GaussianSplatNodeMaterialOptions {
  /**
   * Emit logarithmic depth from the vertex stage so the splats depth-test
   * correctly against a scene rendered with `renderer.logarithmicDepthBuffer`
   * (e.g. the globe twin). Must match the renderer's setting. Default `false`.
   */
  logarithmicDepthBuffer?: boolean
  /**
   * Write depth so a deferred atmosphere / aerial-perspective post-pass treats
   * splat pixels as scene geometry (tinting them) instead of painting sky over
   * them where there is no opaque geometry behind. Default `false` (canonical
   * splat compositing: sort-ordered, no depth write).
   *
   * NOTE: enabled WITHOUT `alphaTest` on purpose — an alpha-test `discard` on
   * 50k heavily-overlapping splats defeats early-z and tanks the framerate. The
   * cost is a faint depth fringe at quad corners (alpha ~0); acceptable, and far
   * cheaper than per-fragment discard.
   *
   * Ignored when {@link dither} is set (dither owns the render state).
   */
  depthWrite?: boolean
  /**
   * Dither-opaque mode (SuperSplat/PlayCanvas technique). The Gaussian alpha is
   * resolved as usual, then the fragment is stochastically discarded with a
   * per-frame-jittered 8x8 Bayer threshold so coverage ∝ alpha, and the kept
   * fragments output OPAQUE color with `NoBlending` + `depthWrite`. The splats
   * thus behave as opaque geometry: hardware depth gives correct occlusion and a
   * deferred atmosphere tints them, with no translucent silhouette (no black halo
   * over an unrendered-sky clear color) and no dedicated composite pass.
   *
   * REQUIRES temporal antialiasing in the pipeline — the dither MUST vary per
   * frame so TAA averages the stochastic coverage back into smooth transparency;
   * without TAA the splats look like static noise. Default `false`.
   */
  dither?: boolean
}

const scratchSize = /*#__PURE__*/ new Vector2()

/**
 * Renders {@link GaussianSplatGeometry} under the Three.js WebGPU renderer. Drop
 * it into a {@link GaussianSplatMesh} via the `createMaterial` option; the mesh
 * drives {@link update} (projection-dependent uniforms) and re-sorting per frame.
 */
export class GaussianSplatNodeMaterial extends MeshBasicNodeMaterial {
  // Projection-derived uniforms, refreshed each frame in `update`. Kept as scalar
  // uniforms and reassigned (not mutated in place) so the WebGPU backend reliably
  // re-uploads them.
  private readonly viewportX = uniform(1)
  private readonly viewportY = uniform(1)
  private readonly focalX = uniform(1)
  private readonly focalY = uniform(1)

  /**
   * Linear scale applied to the resolved splat radiance. Lets a tone-mapped HDR
   * scene (e.g. the twin's AgX pipeline) pull the splats into its exposure range
   * instead of clipping to white. 1 = raw.
   */
  readonly intensity = uniform(1)

  private readonly logarithmicDepthBuffer: boolean
  private readonly dither: boolean

  // Per-frame Bayer-pattern jitter for dither mode. Kept as two scalar uniforms
  // and reassigned each frame (not mutated in place) so the WebGPU backend
  // reliably re-uploads them — see the viewport/focal uniforms above.
  private readonly ditherJitterX = uniform(0)
  private readonly ditherJitterY = uniform(0)
  private frameIndex = 0

  constructor(
    geometry: GaussianSplatGeometry,
    options: GaussianSplatNodeMaterialOptions = {}
  ) {
    super()
    this.type = 'GaussianSplatNodeMaterial'
    this.logarithmicDepthBuffer = options.logarithmicDepthBuffer ?? false
    this.dither = options.dither ?? false

    this.depthTest = true
    this.side = DoubleSide
    // Splats carry their own resolved radiance; no scene tone mapping at the
    // material (the twin's post AgX pass still applies to the framebuffer).
    this.toneMapped = false

    if (this.dither) {
      // Opaque geometry: no blending, write depth. The stochastic discard in the
      // outputNode produces the apparent transparency (resolved by TAA).
      this.transparent = false
      this.depthWrite = true
      this.blending = NoBlending
    } else {
      this.transparent = true
      // Default off (sort establishes order). A caller may opt in so a deferred
      // aerial-perspective post-pass treats splats as geometry — see the doc.
      this.depthWrite = options.depthWrite ?? false

      // Pre-multiplied-alpha "over" blending, matching the WebGL material.
      this.blending = CustomBlending
      this.blendEquation = AddEquation
      this.blendSrc = OneFactor
      this.blendDst = OneMinusSrcAlphaFactor
      this.blendEquationAlpha = AddEquation
      this.blendSrcAlpha = OneFactor
      this.blendDstAlpha = OneMinusSrcAlphaFactor
    }

    this.buildNodes(geometry)
  }

  private buildNodes(geometry: GaussianSplatGeometry): void {
    const textureWidth = int(geometry.textureSize.x)
    const positionTexture = texture(geometry.positionTexture)
    const covATexture = texture(geometry.covATexture)
    const covBTexture = texture(geometry.covBTexture)
    const colorTexture = texture(geometry.colorTexture)

    const quadOffset = attribute('quadOffset', 'vec2')
    const splatIndex = attribute('splatIndex', 'float')

    // Resolve the per-instance splat index to a data-texture texel. Integer
    // arithmetic only (y = i / w, x = i - y * w) to avoid a separate modulo op.
    const index = int(splatIndex.add(0.5))
    const texelY = index.div(textureWidth)
    const texelX = index.sub(texelY.mul(textureWidth))
    const texel = ivec2(texelX, texelY)

    const positionOpacity = positionTexture.load(texel)
    const colorTexel = colorTexture.load(texel)

    // Interpolated across the quad for the fragment Gaussian; color is flat.
    const vColor = varying(vec4(colorTexel.rgb, positionOpacity.w))
    const vQuad = varying(quadOffset)
    // Per-splat decorrelation seed for the dither pattern (constant per splat).
    const vId = varying(splatIndex)

    const viewport = vec2(this.viewportX, this.viewportY)
    const focal = vec2(this.focalX, this.focalY)
    const useLogDepth = this.logarithmicDepthBuffer

    // Per-splat view-space center and its (flat) interpolated z. The written
    // fragment depth is driven from THIS via an explicit `depthNode`, not the
    // default path: the geometry's `position` attribute is only the quad corners,
    // so the built-in `viewZToLogarithmicDepth(positionView.z)` would stamp the
    // group-origin depth onto every splat and break occlusion. A per-splat center
    // depth (Cesium/PlayCanvas convention) gives correct hardware occlusion + the
    // deferred-atmosphere tint.
    const center = positionOpacity.xyz
    const viewCenter = modelViewMatrix.mul(vec4(center, 1))
    const vViewZ = varying(viewCenter.z)
    this.depthNode = useLogDepth
      ? viewZToLogarithmicDepth(vViewZ, cameraNear, cameraFar)
      : viewZToPerspectiveDepth(vViewZ, cameraNear, cameraFar)

    this.vertexNode = Fn(() => {
      const covA = covATexture.load(texel)
      const covB = covBTexture.load(texel)
      // Symmetric 3D covariance from its 6 stored entries.
      const Vrk = mat3(
        covA.x,
        covA.y,
        covA.z,
        covA.y,
        covB.x,
        covB.y,
        covA.z,
        covB.y,
        covB.z
      )

      const clipCenter = cameraProjectionMatrix.mul(viewCenter)

      // 2D covariance = Jᵀ Wᵀ Σ W J, reduced to the three unique entries via the
      // first two columns of T = Wᵀ J (avoids matrix element extraction in TSL).
      const invZ = float(1).div(viewCenter.z)
      const jColumn0 = vec3(
        focal.x.mul(invZ),
        0,
        focal.x.mul(viewCenter.x).mul(invZ).mul(invZ).negate()
      )
      const jColumn1 = vec3(
        0,
        focal.y.mul(invZ),
        focal.y.mul(viewCenter.y).mul(invZ).mul(invZ).negate()
      )
      const W = transpose(mat3(modelViewMatrix))
      const t0 = W.mul(jColumn0)
      const t1 = W.mul(jColumn1)
      const Vt0 = Vrk.mul(t0)
      const Vt1 = Vrk.mul(t1)
      // Dilate the diagonal by ~one pixel so sub-pixel splats stay visible.
      const a = t0.dot(Vt0).add(0.3)
      const b = t0.dot(Vt1)
      const c = t1.dot(Vt1).add(0.3)

      // Eigen-decomposition of the symmetric 2x2 covariance.
      const mid = a.add(c).mul(0.5)
      const radius = vec2(a.sub(c).mul(0.5), b).length()
      const lambda1 = mid.add(radius)
      const lambda2 = mid.sub(radius).max(0.1)
      const majorDir = vec2(b, lambda1.sub(a)).normalize()
      const majorAxis = majorDir.mul(lambda1.mul(2).sqrt().min(1024))
      const minorAxis = vec2(majorDir.y, majorDir.x.negate()).mul(
        lambda2.mul(2).sqrt().min(1024)
      )

      const center2d = clipCenter.xy.div(clipCenter.w)
      const ndc = center2d
        .add(majorAxis.mul(quadOffset.x).div(viewport))
        .add(minorAxis.mul(quadOffset.y).div(viewport))
      // The clip-space z here only needs to be valid for near/far frustum
      // clipping; the actual written depth comes from `depthNode` (set above),
      // which carries the scene's buffer scale (log on the twin, perspective for
      // the standalone story).
      const position = vec4(ndc, clipCenter.z.div(clipCenter.w), 1)

      // Frustum cull by collapsing to a vertex outside the clip volume.
      const clip = clipCenter.w.mul(1.2)
      const culled = clipCenter.z
        .lessThan(clip.negate())
        .or(clipCenter.x.abs().greaterThan(clip))
        .or(clipCenter.y.abs().greaterThan(clip))
      return culled.select(vec4(0, 0, 2, 1), position)
    })()

    const useDither = this.dither
    this.outputNode = Fn(() => {
      // quadOffset is in standard-deviation units; fade out beyond ~2σ.
      const power = vQuad.dot(vQuad).negate()
      const alpha = power
        .lessThan(-4)
        .select(float(0), power.exp().mul(vColor.a))

      if (useDither) {
        // Stochastic coverage: keep this fragment with probability ∝ alpha using
        // a per-frame-jittered 8x8 Bayer threshold (PlayCanvas/SuperSplat). The
        // jitter (set in update()) decorrelates the pattern every frame so the
        // pipeline's TAA averages the kept/discarded fragments back into smooth
        // transparency. The output is OPAQUE — coverage is the discard, not the
        // alpha channel — so the splats composite as ordinary depth-writing
        // geometry (correct occlusion + deferred-atmosphere tint, no halo).
        const seed = screenCoordinate
          .add(vec2(this.ditherJitterX, this.ditherJitterY))
          .add(vId.mul(0.013))
        const p = seed.mod(8).floor()
        const p1 = p.mod(2)
        const p2 = p.mod(4).mul(0.5).floor()
        const p4 = p.mod(8).mul(0.25).floor()
        // bayer2(q) = mod(2*q.y + q.x + 1, 4); bayer8 = 16*b1 + 4*b2 + b4 ∈ [0,63].
        const b1 = p1.y.mul(2).add(p1.x).add(1).mod(4)
        const b2 = p2.y.mul(2).add(p2.x).add(1).mod(4)
        const b4 = p4.y.mul(2).add(p4.x).add(1).mod(4)
        const bayer8 = b1.mul(4).add(b2).mul(4).add(b4)
        // Bayer values are perceptual; compare in linear space (sRGB→linear).
        const threshold = bayer8.div(64).pow(2.2)
        // `<=` so alpha==0 (beyond 2σ) always discards even at Bayer cell 0.
        Discard(alpha.lessThanEqual(threshold))
        return vec4(vColor.rgb.mul(this.intensity), 1)
      }

      // Premultiplied "over"; `intensity` scales radiance only, not coverage.
      return vec4(vColor.rgb.mul(this.intensity).mul(alpha), alpha)
    })()
  }

  /** Refreshes viewport and focal-length uniforms from the active camera. */
  update(renderer: RendererLike, camera: Camera): void {
    const size = renderer.getDrawingBufferSize(scratchSize)
    const projection = camera.projectionMatrix.elements
    this.viewportX.value = size.x
    this.viewportY.value = size.y
    // Pixel focal lengths derived from the perspective projection matrix.
    this.focalX.value = 0.5 * size.x * projection[0]
    this.focalY.value = 0.5 * size.y * projection[5]

    if (this.dither) {
      // Advance the dither pattern every frame so TAA averages the stochastic
      // coverage into smooth transparency. An R2 low-discrepancy sequence (1/φ₂
      // and its square, fractional part scaled to the 8x8 Bayer period) sweeps
      // the threshold set quickly with minimal temporal clumping.
      this.frameIndex = (this.frameIndex + 1) % 8192
      const n = this.frameIndex
      this.ditherJitterX.value = ((n * 0.7548776662466927) % 1) * 8
      this.ditherJitterY.value = ((n * 0.5698402909980532) % 1) * 8
    }
  }
}
