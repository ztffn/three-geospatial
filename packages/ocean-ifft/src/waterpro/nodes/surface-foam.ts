// WaterPro program 5 (surfaceFoam) ported as a TSL node.
// Mirrors decompiled EF.build({worldX, worldZ}, [enabled, size, texture,
// coverage, opacity, color]). Returns {strength, color}. Pure world-space
// noise foam, no depth or wave dependency — used as the always-on ambient
// foam layer that runs across the whole ocean surface. Tile size convention
// matches shoreline foam: UV = worldXZ / size, with size in world meters.

import {
  texture as tslTexture,
  float,
  vec2,
  smoothstep,
  positionWorld,
} from 'three/tsl'
import type { Texture } from 'three'

export interface SurfaceFoamParams {
  foamTexture: Texture
  enabled?: any   // 0|1; default 1
  size: any       // foam texture tile size in world meters
  coverage: any   // 0..1 threshold
  opacity: any    // 0..1 multiplier
  foamColor: any  // vec3 tint
  oceanPositionWorld?: any
}

export interface SurfaceFoamOutputs {
  strength: any
  color: any
}

export function surfaceFoamNode(params: SurfaceFoamParams): SurfaceFoamOutputs {
  const enabled = params.enabled ?? float(1)
  const posWorld = params.oceanPositionWorld ?? positionWorld

  const foamUV = vec2(posWorld.x, posWorld.z).div(params.size)
  const noise = tslTexture(params.foamTexture, foamUV).r

  const masked = smoothstep(float(1).sub(params.coverage), float(1), noise)
  const strength = masked.mul(params.opacity).mul(enabled)

  return { strength, color: params.foamColor }
}
