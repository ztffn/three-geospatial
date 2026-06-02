// WaterPro foam compositor — direct TSL port of decompiled AF.build().
// Combines surfaceFoam (program 5), waveFoam (program 7), shorelineFoam
// (program 6), and optional wakeFoam (program 12) into:
//   - combinedFoamColor  : weighted blend of surface/wave/wake foam tints
//   - combinedFoamStrength: clamp(S+M+P, 0, 1) * (1 - isObjectInFront)
//   - earlyFoamStrength  : the pre-occlusion-mask clamp result (used for fresnel)
//   - shorelineFoamStrength / shorelineZoneMask / shorelineFoamTint:
//        passed through with (1 - isObjectInFront) * (1 - isDynamic) modulation
//   - effectiveFresnel   : fresnel * (1 - earlyFoamStrength * 0.8)
//
// Decompiled reference (full-shader-decoded.js):
//   F = clamp(S+M+P, 0, 1)
//   D = y * (1 - F*0.8)
//   k = 1 - isObjectInFront
//   I = F * k
//   L = S + M + 1e-4
//   U = S / L
//   O = mix(C_wave, T_surface, U)
//   z = P / (F + 1e-4)
//   V = mix(O, B_wake, z)
//   G = k * (1 - isDynamic)

import { float, mix, clamp, vec3 } from 'three/tsl'

export interface CombineFoamSurface {
  strength: any
  color: any
}

export interface CombineFoamWave {
  strength: any
  color: any
}

export interface CombineFoamShoreline {
  strength: any
  color: any
  zoneMask: any
}

export interface CombineFoamWake {
  strength?: any
  color?: any
}

export interface CombineFoamSceneInputs {
  isObjectInFront: any  // 0|1 from waterColorNode
  isDynamic: any        // 0|1 from waterColorNode
  fresnel: any          // base fresnel value to be modulated
}

export interface CombineFoamParams {
  surfaceFoam: CombineFoamSurface
  waveFoam: CombineFoamWave
  shorelineFoam: CombineFoamShoreline
  wakeFoam?: CombineFoamWake
  scene: CombineFoamSceneInputs
}

export interface CombineFoamOutputs {
  combinedFoamColor: any
  combinedFoamStrength: any
  earlyFoamStrength: any
  shorelineFoamStrength: any
  shorelineZoneMask: any
  shorelineFoamTint: any
  effectiveFresnel: any
}

export function combineFoamNode(params: CombineFoamParams): CombineFoamOutputs {
  const S = params.surfaceFoam.strength
  const T = params.surfaceFoam.color
  const M = params.waveFoam.strength
  const C = params.waveFoam.color
  const A = params.shorelineFoam.strength
  const R = params.shorelineFoam.color
  const E = params.shorelineFoam.zoneMask

  const P = params.wakeFoam?.strength ?? float(0)
  const B = params.wakeFoam?.color ?? vec3(float(1), float(1), float(1))

  const { isObjectInFront, isDynamic, fresnel } = params.scene

  const F = clamp(S.add(M).add(P), float(0), float(1))
  const D = fresnel.mul(float(1).sub(F.mul(float(0.8))))
  const k = float(1).sub(isObjectInFront)
  const I = F.mul(k)

  const L = S.add(M).add(float(1e-4))
  const U = S.div(L)
  const O = mix(C, T, U)

  const z = P.div(F.add(float(1e-4)))
  const V = mix(O, B, z)

  const G = k.mul(float(1).sub(isDynamic))

  return {
    combinedFoamColor: V,
    combinedFoamStrength: I,
    earlyFoamStrength: F,
    shorelineFoamStrength: A.mul(G),
    shorelineZoneMask: E.mul(G),
    shorelineFoamTint: R,
    effectiveFresnel: D,
  }
}
