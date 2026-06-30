// WebGPU/TSL node material for 3D Gaussian splats. Ports the verified WebGL
// `GaussianSplatMaterial` EWA projection into a full TSL `vertexNode` (clip-space
// covariance expansion) plus an `outputNode` (Gaussian falloff, premultiplied
// alpha). Consumes the same `GaussianSplatGeometry` data textures and sort buffer
// as the WebGL path, so the sorter and mesh are shared across both renderers.

import {
  AddEquation,
  CustomBlending,
  DoubleSide,
  Matrix4,
  OneFactor,
  OneMinusSrcAlphaFactor,
  Vector2,
  type Camera,
  type PerspectiveCamera,
  type Vector3
} from 'three'
import {
  attribute,
  float,
  Fn,
  If,
  instancedArray,
  instanceIndex,
  int,
  ivec2,
  mat3,
  storage,
  struct,
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
  StorageInstancedBufferAttribute,
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

// Per-splat data the vertex stage needs, packed into one struct so it is a single
// coherent buffer read (one cache line per instance) rather than several scattered
// texture/buffer fetches. `center` = NDC centre (xy), depth (z), cull flag (w);
// `axes` = major (xy) / minor (zw) ellipse axes in pixels; `color` = resolved
// linear radiance (rgb) + opacity (w). Filled by the prepare compute pass.
const splatStruct = /*#__PURE__*/ struct({
  center: 'vec4',
  axes: 'vec4',
  color: 'vec4'
})

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

  /**
   * Screen-space LOD cull, in pixels. The prepare pass collapses any splat whose
   * projected major-axis standard deviation is below this — its quad becomes a
   * degenerate offscreen triangle, producing zero fragments. This bounds the
   * transparent OVERDRAW that dominates GPU cost on dense multi-million-splat
   * clouds (the steady-state bottleneck), at the cost of thinning the far field.
   * 0 = draw every splat. A coarse stand-in for PlayCanvas's octree LOD budget —
   * a flat SPZ has no LOD octree to drive a true budget.
   */
  readonly lodSize = uniform(0)

  private readonly logarithmicDepthBuffer: boolean

  // Everything the vertex stage needs per splat — screen-space ellipse (centre,
  // axes, depth, cull flag) AND resolved colour+opacity — is computed once per
  // splat in a single "prepare" compute pass and packed into `prepared` (one
  // struct per splat), so the vertex does ONE coherent buffer read instead of
  // several scattered texture fetches (the dominant cost for large clouds).
  // Recomputed only when the view changes (see updatePrepare); a static camera
  // costs nothing. Camera-local position + matrices are uniforms (reassigned /
  // copied so the WebGPU backend re-uploads them; mat4 via .value.copy, as in
  // HighpVelocityNode).
  private prepared: ReturnType<typeof instancedArray> | null = null
  private prepareNode: ComputeNode | null = null

  // Draw order: per-instance splat id (sorted back-to-front), in a GPU storage
  // buffer the vertex reads via `instanceIndex`. Rewritten each sort — by
  // GpuSplatSorter (GPU-GPU copy, no upload) or a CPU sorter (uploadOrder).
  private orderAttribute: StorageInstancedBufferAttribute | null = null
  private orderArray: ReturnType<typeof storage> | null = null
  // Per-instance LOD-transition fade [0,1]; the LOD selector writes it so splats
  // crossing a LOD boundary dissolve instead of popping. 1 = fully opaque.
  private fadeAttribute: StorageInstancedBufferAttribute | null = null
  private fadeArray: ReturnType<typeof storage> | null = null
  private count = 0

  private readonly cameraLocalX = uniform(0)
  private readonly cameraLocalY = uniform(0)
  private readonly cameraLocalZ = uniform(0)
  private readonly modelViewUniform = uniform('mat4')
  private readonly projectionUniform = uniform('mat4')
  private readonly nearUniform = uniform(0)
  private readonly farUniform = uniform(1)
  // Number of active splats this frame: the prepare pass dispatches this many
  // invocations and reads `order[invocation]` to project only the drawn subset
  // (LOD budget), instead of every loaded splat. Guards over-dispatch rounding.
  private readonly activeCountUniform = uniform(0)
  private lastActiveCount = -1
  private readonly lastModelView = new Matrix4()
  private readonly lastProjection = new Matrix4()
  private preparedOnce = false

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
    this.count = geometry.count
    const quadOffset = attribute('quadOffset', 'vec2')

    // Draw order (instance → splat id), in a GPU storage buffer rewritten each
    // sort/LOD-select. Identity-initialised so the first frame is coherent. Built
    // before the prepare pass because the prepare reads it (projects only the
    // active subset, `order[0..activeCount)`).
    const orderData = new Uint32Array(geometry.count)
    for (let i = 0; i < geometry.count; i++) {
      orderData[i] = i
    }
    const orderAttribute = new StorageInstancedBufferAttribute(orderData, 1)
    this.orderAttribute = orderAttribute
    this.orderArray = storage(orderAttribute, 'uint', geometry.count)

    // Per-instance LOD fade, parallel to the order buffer. Identity-initialised to
    // 1 (opaque) so the non-LOD path is unaffected.
    const fadeData = new Float32Array(geometry.count).fill(1)
    const fadeAttribute = new StorageInstancedBufferAttribute(fadeData, 1)
    this.fadeAttribute = fadeAttribute
    this.fadeArray = storage(fadeAttribute, 'float', geometry.count)

    // One prepare compute pass (projection + colour) fills a per-splat struct,
    // indexed by the splat's own id, for the active subset only.
    this.prepared = instancedArray(geometry.count, splatStruct)
    this.prepareNode = this.buildPrepare(geometry)

    // Draw instance j reads order[j] = sorted splat id, then that splat's prepared
    // record. instanceIndex is the per-instance builtin; quadOffset is per-vertex.
    const splatId = this.orderArray.element(instanceIndex)
    const splat = this.prepared.element(int(splatId))
    const viewport = vec2(this.viewportX, this.viewportY)

    // color: rgb = resolved linear radiance, a = opacity (flat across the quad).
    const vColor = varying(splat.get('color'))
    const vQuad = varying(quadOffset)
    // Per-instance LOD-transition fade (constant across the quad's verts).
    const vFade = varying(this.fadeArray.element(instanceIndex))

    this.vertexNode = Fn(() => {
      const pc = splat.get('center') // xy = NDC centre, z = depth, w = valid flag
      const pa = splat.get('axes') // xy = major axis (px), zw = minor axis (px)
      const ndc = pc.xy
        .add(pa.xy.mul(quadOffset.x).div(viewport))
        .add(pa.zw.mul(quadOffset.y).div(viewport))
      const position = vec4(ndc, pc.z, 1)
      // Splats the prepare pass frustum-culled carry valid = 0 → collapse offscreen.
      return pc.w.lessThan(0.5).select(vec4(0, 0, 2, 1), position)
    })()

    this.outputNode = Fn(() => {
      // quadOffset is in standard-deviation units; fade out beyond ~2σ.
      const power = vQuad.dot(vQuad).negate()
      const alpha = power.exp().mul(vColor.a)
      // LOD-transition fade scales coverage so margin splats dissolve smoothly.
      const masked = power.lessThan(-4).select(float(0), alpha).mul(vFade)
      // Premultiplied "over"; `intensity` scales radiance only, not coverage.
      return vec4(vColor.rgb.mul(this.intensity).mul(masked), masked)
    })()
  }

  // Resolves everything the vertex stage needs for one splat — the EWA screen-space
  // ellipse (centre, axes, depth, frustum-cull flag) AND the view-dependent colour
  // (DC + SH degrees 1-3, clamped, display→linear) — and packs it into the prepared
  // struct. One coherent compute invocation per splat, replacing the EWA done ×4 per
  // quad vertex plus the scattered covariance/SH fetches. SH is evaluated against the
  // splat→camera direction in the splat-local frame the (flip-baked) coeffs live in.
  private buildPrepare(geometry: GaussianSplatGeometry): ComputeNode {
    const textureWidth = int(geometry.textureSize.x)
    const positionTexture = texture(geometry.positionTexture)
    const covATexture = texture(geometry.covATexture)
    const covBTexture = texture(geometry.covBTexture)
    const colorTexture = texture(geometry.colorTexture)
    const prepared = this.prepared!
    const focal = vec2(this.focalX, this.focalY)
    const modelView = this.modelViewUniform
    const projection = this.projectionUniform
    const near = this.nearUniform
    const far = this.farUniform
    const lodSize = this.lodSize
    const useLogDepth = this.logarithmicDepthBuffer
    const cameraLocal = vec3(
      this.cameraLocalX,
      this.cameraLocalY,
      this.cameraLocalZ
    )

    const shCount = geometry.shCoefficientCount
    const hasSh = geometry.shTexture != null && shCount > 0
    const shTexture = hasSh ? texture(geometry.shTexture) : null
    const shWidth = int(geometry.shTextureSize.x)
    const shStride = int(shCount)
    const shScale = float(geometry.shRangeScale)
    const shMin = float(geometry.shRangeMin)
    const orderArray = this.orderArray!
    const activeCount = this.activeCountUniform

    return Fn(() => {
      // Each invocation projects one active splat: `order[invocation]`. Dispatched
      // over `activeCount` (the LOD budget), so only drawn splats are projected —
      // not the whole loaded cloud. The guard ignores over-dispatch rounding.
      const invocation = int(instanceIndex)
      If(invocation.lessThan(activeCount), () => {
      const i = int(orderArray.element(invocation))
      const ty = i.div(textureWidth)
      const tx = i.sub(ty.mul(textureWidth))
      const texel = ivec2(tx, ty)
      const posOpacity = positionTexture.load(texel)
      const center = posOpacity.xyz
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

      const viewCenter = modelView.mul(vec4(center, 1))
      const clipCenter = projection.mul(viewCenter)

      // 2D covariance via the first two columns of T = Wᵀ J.
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
      const W = transpose(mat3(modelView))
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
      // Depth must share the scene's buffer scale: logarithmic when the renderer
      // uses a log depth buffer (globe twin), linear NDC otherwise (standalone).
      const depthZ = useLogDepth
        ? viewZToLogarithmicDepth(viewCenter.z, near, far)
        : clipCenter.z.div(clipCenter.w)

      // Frustum cull → valid flag the vertex stage uses to collapse the quad.
      const clip = clipCenter.w.mul(1.2)
      const culled = clipCenter.z
        .lessThan(clip.negate())
        .or(clipCenter.x.abs().greaterThan(clip))
        .or(clipCenter.y.abs().greaterThan(clip))
      // Screen-space LOD: also collapse splats whose major-axis stddev is below
      // `lodSize` px. lambda1 is the major eigenvalue (variance in px²), so the
      // test is lambda1 < lodSize² — no sqrt. Bounds transparent overdraw on
      // dense clouds; lodSize 0 keeps every splat (compares against 0).
      const tooSmall = lambda1.lessThan(lodSize.mul(lodSize))
      const valid = culled.or(tooSmall).select(float(0), float(1))

      // Colour: DC display colour + view-dependent SH, clamped, display→linear.
      const dc = colorTexture.load(texel).rgb
      let displayColor: SplatNode = dc
      if (hasSh && shTexture != null) {
        // Dequantized RGB of the j-th rest-coefficient (one RGBA8 texel each).
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
        displayColor = dc.add(sh)
      }
      const linear = srgbToLinear(displayColor.clamp(0, 1))

      const out = prepared.element(i)
      out.get('center').assign(vec4(center2d, depthZ, valid))
      out.get('axes').assign(vec4(majorAxis, minorAxis))
      out.get('color').assign(vec4(linear, posOpacity.w))
      })
    })().compute(geometry.count)
  }

  /**
   * Resolves the per-splat render data (projection + colour) for the current view
   * via the prepare compute pass. Call each frame with the splat mesh's model-view
   * matrix, the camera in mesh-local space, and the active splat count (the LOD
   * budget, or the full count without LOD). Only `activeCount` splats — read from
   * the order buffer — are projected, so the prepare cost tracks the drawn count,
   * not the loaded count. Skips the dispatch when neither the view nor the active
   * count changed, so a static camera costs nothing.
   */
  updatePrepare(
    renderer: RendererLike,
    modelView: Matrix4,
    cameraLocal: Vector3,
    camera: Camera,
    activeCount: number
  ): void {
    if (this.prepareNode == null) {
      return
    }
    const projectionMatrix = camera.projectionMatrix
    if (
      this.preparedOnce &&
      this.lastActiveCount === activeCount &&
      this.lastModelView.equals(modelView) &&
      this.lastProjection.equals(projectionMatrix)
    ) {
      return
    }
    this.modelViewUniform.value.copy(modelView)
    this.projectionUniform.value.copy(projectionMatrix)
    const perspective = camera as PerspectiveCamera
    this.nearUniform.value = perspective.near
    this.farUniform.value = perspective.far
    this.cameraLocalX.value = cameraLocal.x
    this.cameraLocalY.value = cameraLocal.y
    this.cameraLocalZ.value = cameraLocal.z
    this.activeCountUniform.value = activeCount
    this.lastModelView.copy(modelView)
    this.lastProjection.copy(projectionMatrix)
    this.lastActiveCount = activeCount
    this.preparedOnce = true
    // Dispatch only `activeCount` invocations (the backend caches the workgroup
    // split per count), so projection scales with the drawn subset.
    void (
      renderer as unknown as {
        compute: (node: ComputeNode, dispatchSize: number) => unknown
      }
    ).compute(this.prepareNode, Math.max(1, activeCount))
  }

  /**
   * The order storage attribute (per-instance splat id). {@link GpuSplatSorter}
   * writes the sorted order straight into its GPU buffer; the mesh passes this in.
   */
  getOrderAttribute(): StorageInstancedBufferAttribute | null {
    return this.orderAttribute
  }

  /**
   * Uploads a CPU-computed draw order (instance → splat id) into the order buffer.
   * Used when the WebGPU node path is paired with a CPU/worker sorter instead of
   * {@link GpuSplatSorter} (which writes the buffer on-GPU with no upload).
   */
  uploadOrder(indices: Uint32Array): void {
    if (this.orderAttribute == null) {
      return
    }
    ;(this.orderAttribute.array as Uint32Array).set(
      indices.subarray(0, this.count)
    )
    this.orderAttribute.needsUpdate = true
  }

  /**
   * Uploads the per-instance LOD-transition fade (parallel to the draw order), so
   * splats crossing a LOD boundary dissolve instead of popping. Length matches the
   * uploaded order; unused tail entries are ignored (instanceCount bounds the draw).
   */
  uploadFade(fade: Float32Array): void {
    if (this.fadeAttribute == null) {
      return
    }
    ;(this.fadeAttribute.array as Float32Array).set(fade.subarray(0, this.count))
    this.fadeAttribute.needsUpdate = true
  }

  override dispose(): void {
    this.prepared?.dispose()
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
