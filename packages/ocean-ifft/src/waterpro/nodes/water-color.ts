// WaterPro program 4 (water color) ported as Three.js TSL node functions.
// Returns the four outputs the original WASM program 4 exposes:
// waterColor, waterColumnDepth, isObjectInFront, isDynamic. The first two
// drive deep/shallow blending; the latter two flag occluding/dynamic objects
// so the foam compositor (AF.build) can suppress foam where it would be wrong.

import {
  texture as tslTexture,
  float,
  mix,
  min,
  max,
  abs,
  smoothstep,
  normalize,
  positionView,
  positionWorld,
  cameraPosition,
  cameraNear,
  cameraFar,
  screenUV,
} from 'three/tsl'
import type { Texture } from 'three'

export interface WaterColumnDepthParams {
  depthTexture: Texture
  depthTextureEnabled: any
  waterDepth: any
  // Optional override for the ocean fragment's view-space depth. Required when
  // the host material has a custom positionNode (e.g. WGSL vertex stage with
  // morphing / IFFT displacement) because TSL's built-in `positionView` is not
  // always re-derived from a custom positionNode.
  oceanDepth?: any
  // Optional override for the world-space ocean position used to compute the
  // grazing-angle openWaterDepth divisor. Defaults to TSL `positionWorld`.
  oceanPositionWorld?: any
}

export interface WaterColorParams extends WaterColumnDepthParams {
  depthFalloff: any
  shallowColor: any
  deepColor: any
  // WaterPro program 4 also takes alpha + transmissionColor uniforms but
  // doesn't actually consume them in the waterColor output we use here; kept
  // optional in case downstream wants to expose them.
  alpha?: any
  transmissionColor?: any
}

export interface WaterColorOutputs {
  waterColor: any
  waterColumnDepth: any
  isObjectInFront: any  // 1 when terrain is closer than ocean (occludes from camera)
  isDynamic: any        // 1 when underwater geometry is dynamic; 0 from our static pre-pass
}

export function buildWaterColumnDepth(params: WaterColumnDepthParams): any {
  const posWorld = params.oceanPositionWorld ?? positionWorld
  const viewDir = normalize(cameraPosition.sub(posWorld))
  const viewDirY = viewDir.y
  const openWaterDepth = params.waterDepth.div(min(abs(viewDirY), float(0.1)))

  const depthR = tslTexture(params.depthTexture, screenUV).r
  const terrainDepth = depthR.mul(cameraFar.sub(cameraNear)).add(cameraNear)

  const oceanDepth = params.oceanDepth ?? positionView.z.negate()
  const wcdRaw = terrainDepth.sub(oceanDepth)

  const noGeometry = terrainDepth
    .greaterThanEqual(cameraFar.mul(float(0.99)))
    .toFloat()

  // Keep positive wcdRaw so smoothstep(0, range/2, wcd) in shoreline-foam can
  // produce a smooth shore-to-deep ramp. Negative wcdRaw (terrain in front of
  // ocean) is non-visible / edge-case → clamp to 0 (treat as at-shore).
  const wcdFromTex = mix(max(wcdRaw, float(0)), openWaterDepth, noGeometry)

  return mix(openWaterDepth, wcdFromTex, params.depthTextureEnabled)
}

export function buildIsObjectInFront(params: WaterColumnDepthParams): any {
  const depthR = tslTexture(params.depthTexture, screenUV).r
  const terrainDepth = depthR.mul(cameraFar.sub(cameraNear)).add(cameraNear)
  const oceanDepth = params.oceanDepth ?? positionView.z.negate()
  // 1 when terrain is strictly closer than the ocean fragment and the depth
  // texture is enabled.
  const closer = terrainDepth.lessThan(oceanDepth).toFloat()
  return closer.mul(params.depthTextureEnabled)
}

export function waterColorNode(params: WaterColorParams): WaterColorOutputs {
  const waterColumnDepth = buildWaterColumnDepth(params)
  const isObjectInFront = buildIsObjectInFront(params)
  // No dynamic-object channel in our static pre-pass — always 0.
  const isDynamic = float(0)

  const colorT = smoothstep(float(0), params.depthFalloff, waterColumnDepth)
  const waterColor = mix(params.shallowColor, params.deepColor, colorT)

  return { waterColor, waterColumnDepth, isObjectInFront, isDynamic }
}
