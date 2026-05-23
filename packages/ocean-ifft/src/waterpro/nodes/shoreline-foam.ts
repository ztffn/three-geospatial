// WaterPro program 6 (shorelineFoam) ported as a TSL node.
// Mirrors decompiled BF.build({worldX, worldZ, waterColumnDepth}, [...]).
// Returns {strength, color, zoneMask}. zoneMask falls off as the water column
// gets deeper; strength threshold-masks a tiled noise texture by coverage,
// modulated by zoneMask + opacity. Size is tile-size in world meters
// (UV = worldXZ / size), matching WaterPro's _size=50 default.

import {
  texture as tslTexture,
  float,
  vec2,
  smoothstep,
  positionWorld,
} from 'three/tsl'
import type { Texture } from 'three'

export interface ShorelineFoamParams {
  foamTexture: Texture
  enabled?: any         // 0|1; default 1
  range: any            // depth at which foam fully fades (m)
  size: any             // foam texture tile size in world meters
  coverage: any         // 0..1 threshold; higher = more of the noise becomes foam
  opacity: any          // 0..1 multiplier on the masked foam
  foamColor: any        // vec3 foam tint
  oceanPositionWorld?: any  // override world position (defaults to TSL positionWorld)
}

export interface ShorelineFoamOutputs {
  strength: any
  color: any
  zoneMask: any
}

export function shorelineFoamNode(
  waterColumnDepth: any,
  params: ShorelineFoamParams
): ShorelineFoamOutputs {
  const enabled = params.enabled ?? float(1)
  const posWorld = params.oceanPositionWorld ?? positionWorld

  // zoneMask = 1 at the shore (wcd≈0), fades to 0 past range/2.
  const zoneMask = float(1).sub(
    smoothstep(float(0), params.range.mul(float(0.5)), waterColumnDepth)
  )

  // Tile the foam texture in world-space XZ — UV cycles every `size` meters.
  const foamUV = vec2(posWorld.x, posWorld.z).div(params.size)
  const noise = tslTexture(params.foamTexture, foamUV).r

  // Coverage acts as a threshold on the noise (WaterPro convention).
  const masked = smoothstep(float(1).sub(params.coverage), float(1), noise)

  const strength = masked.mul(params.opacity).mul(zoneMask).mul(enabled)

  return { strength, color: params.foamColor, zoneMask }
}
