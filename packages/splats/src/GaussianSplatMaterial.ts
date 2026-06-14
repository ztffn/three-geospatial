import {
  AddEquation,
  CustomBlending,
  DoubleSide,
  GLSL3,
  OneFactor,
  OneMinusSrcAlphaFactor,
  ShaderMaterial,
  Vector2,
  type Camera,
  type WebGLRenderer
} from 'three'

import type { GaussianSplatGeometry } from './GaussianSplatGeometry'

// EWA (Elliptical Weighted Average) splatting in the formulation popularized by
// Kerbl et al. (2023) and the antimatter15 / mkkellogg WebGL implementations,
// adapted to three.js view-space conventions (camera looks down -Z).
const vertexShader = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D positionTexture;
uniform sampler2D covATexture;
uniform sampler2D covBTexture;
uniform sampler2D colorTexture;
uniform vec2 textureSize;
uniform vec2 viewport;
uniform vec2 focal;

in vec2 quadOffset;
in float splatIndex;

out vec4 vColor;
out vec2 vPosition;

ivec2 texelOf(int index) {
  int w = int(textureSize.x);
  return ivec2(index % w, index / w);
}

void main() {
  int index = int(splatIndex + 0.5);
  ivec2 texel = texelOf(index);

  vec4 posOpacity = texelFetch(positionTexture, texel, 0);
  vec3 center = posOpacity.xyz;
  float opacity = posOpacity.w;
  vec4 covA = texelFetch(covATexture, texel, 0);
  vec4 covB = texelFetch(covBTexture, texel, 0);
  vColor = vec4(texelFetch(colorTexture, texel, 0).rgb, opacity);

  // Symmetric 3D covariance reconstructed from its 6 stored entries.
  mat3 Vrk = mat3(
    covA.x, covA.y, covA.z,
    covA.y, covB.x, covB.y,
    covA.z, covB.y, covB.z
  );

  vec4 viewCenter = modelViewMatrix * vec4(center, 1.0);
  vec4 clipCenter = projectionMatrix * viewCenter;

  // Frustum cull by emitting a degenerate vertex outside the clip volume.
  float clip = 1.2 * clipCenter.w;
  if (clipCenter.z < -clip ||
      clipCenter.x < -clip || clipCenter.x > clip ||
      clipCenter.y < -clip || clipCenter.y > clip) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }

  // Jacobian of the perspective projection at the splat center. The 2x2 result
  // below is a quadratic form, so the sign of view-space z does not affect it.
  float invZ = 1.0 / viewCenter.z;
  mat3 J = mat3(
    focal.x * invZ, 0.0, -focal.x * viewCenter.x * invZ * invZ,
    0.0, focal.y * invZ, -focal.y * viewCenter.y * invZ * invZ,
    0.0, 0.0, 0.0
  );
  mat3 W = transpose(mat3(modelViewMatrix));
  mat3 T = W * J;
  mat3 cov2Dm = transpose(T) * Vrk * T;

  // Dilate by ~one pixel so sub-pixel splats remain visible (low-pass filter).
  cov2Dm[0][0] += 0.3;
  cov2Dm[1][1] += 0.3;
  vec3 cov2D = vec3(cov2Dm[0][0], cov2Dm[0][1], cov2Dm[1][1]);

  // Eigen-decomposition of the symmetric 2x2 covariance.
  float mid = 0.5 * (cov2D.x + cov2D.z);
  float radius = length(vec2((cov2D.x - cov2D.z) * 0.5, cov2D.y));
  float lambda1 = mid + radius;
  float lambda2 = max(mid - radius, 0.1);
  vec2 majorDir = normalize(vec2(cov2D.y, lambda1 - cov2D.x));
  vec2 majorAxis = min(sqrt(2.0 * lambda1), 1024.0) * majorDir;
  vec2 minorAxis = min(sqrt(2.0 * lambda2), 1024.0) * vec2(majorDir.y, -majorDir.x);

  vPosition = quadOffset;
  vec2 center2d = clipCenter.xy / clipCenter.w;
  gl_Position = vec4(
    center2d
      + quadOffset.x * majorAxis / viewport
      + quadOffset.y * minorAxis / viewport,
    clipCenter.z / clipCenter.w,
    1.0
  );
}
`

const fragmentShader = /* glsl */ `
precision highp float;

in vec4 vColor;
in vec2 vPosition;

out vec4 fragColor;

void main() {
  // Evaluate the Gaussian; quadOffset is in standard-deviation units.
  float power = -dot(vPosition, vPosition);
  if (power < -4.0) {
    discard;
  }
  float alpha = exp(power) * vColor.a;
  if (alpha < 1.0 / 255.0) {
    discard;
  }
  // Pre-multiplied alpha for back-to-front "over" compositing.
  fragColor = vec4(vColor.rgb * alpha, alpha);
}
`

export class GaussianSplatMaterial extends ShaderMaterial {
  constructor(geometry: GaussianSplatGeometry) {
    super({
      glslVersion: GLSL3,
      uniforms: {
        positionTexture: { value: geometry.positionTexture },
        covATexture: { value: geometry.covATexture },
        covBTexture: { value: geometry.covBTexture },
        colorTexture: { value: geometry.colorTexture },
        textureSize: { value: geometry.textureSize.clone() },
        viewport: { value: new Vector2() },
        focal: { value: new Vector2() }
      },
      vertexShader,
      fragmentShader,
      transparent: true,
      depthTest: true,
      // Splats never write depth; mutual order comes from the sorter, and
      // opaque geometry still occludes them via the shared depth buffer.
      depthWrite: false,
      blending: CustomBlending,
      blendEquation: AddEquation,
      blendSrc: OneFactor,
      blendDst: OneMinusSrcAlphaFactor,
      blendEquationAlpha: AddEquation,
      blendSrcAlpha: OneFactor,
      blendDstAlpha: OneMinusSrcAlphaFactor,
      side: DoubleSide
    })
  }

  /** Updates viewport and focal-length uniforms from the active camera. */
  update(renderer: WebGLRenderer, camera: Camera): void {
    // Writes the drawing-buffer size directly into the viewport uniform value.
    const size = renderer.getDrawingBufferSize(
      this.uniforms.viewport.value as Vector2
    )
    const projection = camera.projectionMatrix.elements
    const focal = this.uniforms.focal.value as Vector2
    // Pixel focal lengths derived from the perspective projection matrix.
    focal.set(0.5 * size.x * projection[0], 0.5 * size.y * projection[5])
  }
}
