// WebGPU/TSL node material for 3D Gaussian splats. Ports the verified WebGL
// `GaussianSplatMaterial` EWA projection into a full TSL `vertexNode` (clip-space
// covariance expansion) plus an `outputNode` (Gaussian falloff, premultiplied
// alpha). Consumes the same `GaussianSplatGeometry` data textures and sort buffer
// as the WebGL path, so the sorter and mesh are shared across both renderers.

import {
  AddEquation,
  CustomBlending,
  DoubleSide,
  OneFactor,
  OneMinusSrcAlphaFactor,
  Vector2,
  type Camera,
  type Vector3
} from 'three'
import {
  attribute,
  cameraFar,
  cameraNear,
  cameraProjectionMatrix,
  float,
  Fn,
  instancedArray,
  instanceIndex,
  int,
  ivec2,
  mat3,
  modelViewMatrix,
  texture,
  transpose,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
  viewZToLogarithmicDepth
} from 'three/tsl'
import {
  MeshBasicNodeMaterial,
  type ComputeNode,
  type Node
} from 'three/webgpu'

import type { GaussianSplatGeometry } from '../GaussianSplatGeometry'

// Broad TSL node type for the SH helper closures. @types/three augments the math
// and swizzle methods onto `Node` itself, so the concrete factory return types
// (JoinNode, OperatorNode, MathNode, …) are all assignable to it.
type SplatNode = Node

// sRGB EOTF (display→linear), per channel. The 3DGS display colour is sRGB; the
// renderer re-encodes linear→sRGB on output, so this round-trips it correctly.
const srgbToLinear = (c: SplatNode): SplatNode =>
  c.lessThanEqual(0.04045).select(c.div(12.92), c.add(0.055).div(1.055).pow(2.4))

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
   */
  depthWrite?: boolean
}

// Real spherical-harmonics basis constants (degrees 1-3), matching the canonical
// 3DGS evaluation (INRIA / PlayCanvas / mkkellogg). Degree 0 (DC) is folded into
// the base colour, so only the rest-coefficient constants appear here.
const SH_C1 = 0.4886025119029199
const SH_C2 = [
  1.0925484305920792, -1.0925484305920792, 0.31539156525252005,
  -1.0925484305920792, 0.5462742152960396
]
const SH_C3 = [
  -0.5900435899266435, 2.890611442640554, -0.4570457994644658,
  0.3731763325901154, -0.4570457994644658, 1.445305721320277,
  -0.5900435899266435
]

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

  // View-dependent SH is resolved per splat in a compute pre-pass (not per quad
  // vertex) into this storage buffer; the vertex stage reads one resolved colour.
  // Null when the cloud carries no SH (the colour is then resolved inline). Camera
  // position is supplied in splat-local space as scalar uniforms (reassigned, not
  // mutated, so the WebGPU backend reliably re-uploads them).
  private resolvedColor: ReturnType<typeof instancedArray> | null = null
  private computeNode: ComputeNode | null = null
  private readonly cameraLocalX = uniform(0)
  private readonly cameraLocalY = uniform(0)
  private readonly cameraLocalZ = uniform(0)

  constructor(
    geometry: GaussianSplatGeometry,
    options: GaussianSplatNodeMaterialOptions = {}
  ) {
    super()
    this.type = 'GaussianSplatNodeMaterial'
    this.logarithmicDepthBuffer = options.logarithmicDepthBuffer ?? false

    this.transparent = true
    this.depthTest = true
    // Default off (sort establishes order). Twin opts in so the aerial-perspective
    // post-pass treats splats as geometry — see the option doc.
    this.depthWrite = options.depthWrite ?? false
    this.side = DoubleSide
    // Splats carry their own resolved radiance; no scene tone mapping at the
    // material (the twin's post AgX pass still applies to the framebuffer).
    this.toneMapped = false

    // Pre-multiplied-alpha "over" blending, matching the WebGL material.
    this.blending = CustomBlending
    this.blendEquation = AddEquation
    this.blendSrc = OneFactor
    this.blendDst = OneMinusSrcAlphaFactor
    this.blendEquationAlpha = AddEquation
    this.blendSrcAlpha = OneFactor
    this.blendDstAlpha = OneMinusSrcAlphaFactor

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

    // Resolve the flat per-splat colour. View-dependent SH (degrees 1-3) is a
    // per-splat sum over up to 15 coefficients; doing it here would cost that work
    // ×4 per quad vertex with scattered, sort-ordered texture reads — the dominant
    // GPU cost for large clouds. Instead resolve it ONCE per splat in a compute
    // pre-pass (`buildColorCompute`, recomputed only when the camera moves) into
    // `resolvedColor`, and read a single element here. With no SH the DC display
    // colour is view-independent, so it is resolved inline (sRGB→linear).
    const shCount = geometry.shCoefficientCount
    let linearColor: SplatNode
    if (geometry.shTexture != null && shCount > 0) {
      this.resolvedColor = instancedArray(geometry.count, 'vec3')
      this.computeNode = this.buildColorCompute(geometry)
      linearColor = this.resolvedColor.element(index)
    } else {
      linearColor = srgbToLinear(colorTexel.rgb)
    }

    // Interpolated across the quad for the fragment Gaussian; color is flat.
    const vColor = varying(vec4(linearColor, positionOpacity.w))
    const vQuad = varying(quadOffset)

    const viewport = vec2(this.viewportX, this.viewportY)
    const focal = vec2(this.focalX, this.focalY)
    const useLogDepth = this.logarithmicDepthBuffer

    this.vertexNode = Fn(() => {
      const center = positionOpacity.xyz
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

      const viewCenter = modelViewMatrix.mul(vec4(center, 1))
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
      // Depth must share the scene's buffer scale: logarithmic when the renderer
      // uses a log depth buffer (globe twin), linear NDC otherwise (standalone).
      const depthZ = useLogDepth
        ? viewZToLogarithmicDepth(viewCenter.z, cameraNear, cameraFar)
        : clipCenter.z.div(clipCenter.w)
      const position = vec4(ndc, depthZ, 1)

      // Frustum cull by collapsing to a vertex outside the clip volume.
      const clip = clipCenter.w.mul(1.2)
      const culled = clipCenter.z
        .lessThan(clip.negate())
        .or(clipCenter.x.abs().greaterThan(clip))
        .or(clipCenter.y.abs().greaterThan(clip))
      return culled.select(vec4(0, 0, 2, 1), position)
    })()

    this.outputNode = Fn(() => {
      // quadOffset is in standard-deviation units; fade out beyond ~2σ.
      const power = vQuad.dot(vQuad).negate()
      const alpha = power.exp().mul(vColor.a)
      const masked = power.lessThan(-4).select(float(0), alpha)
      // Premultiplied "over"; `intensity` scales radiance only, not coverage.
      return vec4(vColor.rgb.mul(this.intensity).mul(masked), masked)
    })()
  }

  // Resolves the view-dependent colour of every splat (DC + SH degrees 1-3) into
  // `resolvedColor`, one compute invocation per splat — coherent access in splat
  // order, not the scattered ×4-per-quad-vertex reads of evaluating it inline.
  // Writes the premultiply-ready LINEAR colour (display + SH, clamped, sRGB→linear)
  // the vertex stage reads. View direction is per splat in the splat-local frame
  // the (already flip-baked) coefficients live in.
  private buildColorCompute(geometry: GaussianSplatGeometry): ComputeNode {
    const textureWidth = int(geometry.textureSize.x)
    const positionTexture = texture(geometry.positionTexture)
    const colorTexture = texture(geometry.colorTexture)
    const shTexture = texture(geometry.shTexture!)
    const shWidth = int(geometry.shTextureSize.x)
    const shStride = int(geometry.shCoefficientCount)
    const shScale = float(geometry.shRangeScale)
    const shMin = float(geometry.shRangeMin)
    const shCount = geometry.shCoefficientCount
    const resolvedColor = this.resolvedColor!
    const cameraLocal = vec3(
      this.cameraLocalX,
      this.cameraLocalY,
      this.cameraLocalZ
    )

    return Fn(() => {
      const i = int(instanceIndex)
      const ty = i.div(textureWidth)
      const tx = i.sub(ty.mul(textureWidth))
      const texel = ivec2(tx, ty)
      const center = positionTexture.load(texel).xyz
      const dc = colorTexture.load(texel).rgb

      // Dequantized RGB of the j-th rest-coefficient (one RGBA8 texel each,
      // addressed splatIndex * coeffCount + j in the SH texture's own grid).
      const coeff = (j: number): SplatNode => {
        const gt = i.mul(shStride).add(int(j))
        const gy = gt.div(shWidth)
        const gx = gt.sub(gy.mul(shWidth))
        return shTexture.load(ivec2(gx, gy)).rgb.mul(shScale).add(shMin)
      }

      const dir = center.sub(cameraLocal).normalize()
      const x = dir.x
      const y = dir.y
      const z = dir.z
      let sh: SplatNode = coeff(0)
        .mul(y.negate())
        .add(coeff(1).mul(z))
        .add(coeff(2).mul(x.negate()))
        .mul(SH_C1)
      if (shCount >= 8) {
        const xx = x.mul(x)
        const yy = y.mul(y)
        const zz = z.mul(z)
        const xy = x.mul(y)
        const yz = y.mul(z)
        const xz = x.mul(z)
        sh = sh
          .add(coeff(3).mul(xy).mul(SH_C2[0]))
          .add(coeff(4).mul(yz).mul(SH_C2[1]))
          .add(coeff(5).mul(zz.mul(2).sub(xx).sub(yy)).mul(SH_C2[2]))
          .add(coeff(6).mul(xz).mul(SH_C2[3]))
          .add(coeff(7).mul(xx.sub(yy)).mul(SH_C2[4]))
        if (shCount >= 15) {
          sh = sh
            .add(coeff(8).mul(y.mul(xx.mul(3).sub(yy))).mul(SH_C3[0]))
            .add(coeff(9).mul(xy.mul(z)).mul(SH_C3[1]))
            .add(coeff(10).mul(y.mul(zz.mul(4).sub(xx).sub(yy))).mul(SH_C3[2]))
            .add(
              coeff(11)
                .mul(z.mul(zz.mul(2).sub(xx.mul(3)).sub(yy.mul(3))))
                .mul(SH_C3[3])
            )
            .add(coeff(12).mul(x.mul(zz.mul(4).sub(xx).sub(yy))).mul(SH_C3[4]))
            .add(coeff(13).mul(z.mul(xx.sub(yy))).mul(SH_C3[5]))
            .add(coeff(14).mul(x.mul(xx.sub(yy.mul(3)))).mul(SH_C3[6]))
        }
      }
      const display = dc.add(sh).clamp(0, 1)
      resolvedColor.element(i).assign(srgbToLinear(display))
    })().compute(geometry.count)
  }

  /**
   * Resolves the per-splat view-dependent colour for the current camera via the
   * compute pre-pass. No-op when the cloud carries no SH. Call when the camera
   * moves; `cameraLocal` is the camera position in the splat mesh's local space.
   */
  updateColors(renderer: RendererLike, cameraLocal: Vector3): void {
    if (this.computeNode == null) {
      return
    }
    this.cameraLocalX.value = cameraLocal.x
    this.cameraLocalY.value = cameraLocal.y
    this.cameraLocalZ.value = cameraLocal.z
    void (
      renderer as unknown as { compute: (node: ComputeNode) => unknown }
    ).compute(this.computeNode)
  }

  override dispose(): void {
    this.resolvedColor?.dispose()
    super.dispose()
  }

  // Suppress the base NodeMaterial's automatic fragment-depth write. Under
  // `logarithmicDepthBuffer` it would assign `gl_FragDepth` from `positionView.z`,
  // which for this material is the quad-corner `position` attribute (≈ the mesh
  // origin) — so every splat would write the SAME near-origin depth, making the
  // whole cloud occlude/reveal as one flat layer (untethered, "on top of
  // everything"). The vertexNode already encodes the correct per-splat centre
  // depth in clip-z; with no frag-depth override the rasterizer writes THAT, so
  // each splat depth-composites against the scene per-pixel. depthTest/depthWrite
  // pipeline state is unaffected (it comes from the material flags, not here).
  override setupDepth(): void {}

  /** Refreshes viewport and focal-length uniforms from the active camera. */
  update(renderer: RendererLike, camera: Camera): void {
    const size = renderer.getDrawingBufferSize(scratchSize)
    const projection = camera.projectionMatrix.elements
    this.viewportX.value = size.x
    this.viewportY.value = size.y
    // Pixel focal lengths derived from the perspective projection matrix.
    this.focalX.value = 0.5 * size.x * projection[0]
    this.focalY.value = 0.5 * size.y * projection[5]
  }
}
