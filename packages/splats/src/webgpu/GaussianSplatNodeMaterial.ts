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
  type Camera
} from 'three'
import {
  attribute,
  cameraProjectionMatrix,
  float,
  Fn,
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
  vec4
} from 'three/tsl'
import { MeshBasicNodeMaterial } from 'three/webgpu'

import type { GaussianSplatGeometry } from '../GaussianSplatGeometry'

// Structural view of the renderer parts `update` needs. Satisfied by both
// `WebGLRenderer` and the WebGPU `Renderer`.
interface RendererLike {
  getDrawingBufferSize: (target: Vector2) => Vector2
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

  constructor(geometry: GaussianSplatGeometry) {
    super()
    this.type = 'GaussianSplatNodeMaterial'

    this.transparent = true
    this.depthTest = true
    // Splats never write depth; mutual order comes from the sorter, and opaque
    // geometry still occludes them via the shared depth buffer.
    this.depthWrite = false
    this.side = DoubleSide
    // Splats carry their own resolved radiance; no scene tone mapping.
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

    // Interpolated across the quad for the fragment Gaussian; color is flat.
    const vColor = varying(vec4(colorTexel.rgb, positionOpacity.w))
    const vQuad = varying(quadOffset)

    const viewport = vec2(this.viewportX, this.viewportY)
    const focal = vec2(this.focalX, this.focalY)

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
      const position = vec4(ndc, clipCenter.z.div(clipCenter.w), 1)

      // Frustum cull by collapsing to a vertex outside the clip volume.
      const clip = clipCenter.w.mul(1.2)
      const culled = clipCenter.z
        .lessThan(clip.negate())
        .or(clipCenter.x.abs().greaterThan(clip))
        .or(clipCenter.y.abs().greaterThan(clip))
      return culled.select(vec4(0, 0, 2, 1), position)
    })()

    this.outputNode = Fn(() => {
      // quadOffset is in standard-deviation units; discard beyond ~2σ.
      const power = vQuad.dot(vQuad).negate()
      const alpha = power.exp().mul(vColor.a)
      const masked = power.lessThan(-4).select(float(0), alpha)
      return vec4(vColor.rgb.mul(masked), masked)
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
  }
}
