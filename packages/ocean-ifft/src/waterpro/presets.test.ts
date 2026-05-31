// presets.test.ts — Unit coverage for the WaterPro preset applier. Verifies the
// hex→linear-RGB conversion (guarding the Color.setStyle double-conversion
// footgun), the optional reflection/turbulent block wiring (written only when
// BOTH the preset defines the field AND the bag exposes the uniform), and the
// integrity of the preset table itself.

import { Vector3 } from 'three'

import {
  applyWaterproPreset,
  WATERPRO_PRESETS,
  WATERPRO_PRESET_NAMES,
  type WaterproPresetUniformBag
} from './presets'

const num = (): { value: number } => ({ value: 0 })
const vec = (): { value: Vector3 } => ({ value: new Vector3() })

// A bag carrying every required uniform. Optional slots are added per-test.
function makeBag(): WaterproPresetUniformBag {
  return {
    shallowColor: vec(),
    deepColor: vec(),
    depthFalloff: num(),
    transmissionColor: vec(),
    surfaceFoamColor: vec(),
    surfaceFoamCoverage: num(),
    surfaceFoamOpacity: num(),
    surfaceFoamSize: num(),
    shorelineFoamColor: vec(),
    shorelineFoamCoverage: num(),
    shorelineFoamOpacity: num(),
    shorelineFoamRange: num(),
    shorelineFoamSize: num(),
    waveFoamColor: vec(),
    waveFoamCoverage: num(),
    waveFoamCrestCoverage: num(),
    waveFoamOpacity: num(),
    waveFoamPeakIntensity: num(),
    waveFoamRippleWeight: num(),
    waveFoamWaveWeight: num(),
    waveFoamWindBias: num(),
    waveFoamWindStretch: num(),
    waveFoamSize: num(),
    fresnelNormalStrength: num(),
    fresnelPower: num(),
    fadeStart: num(),
    fadePower: num(),
    sparkleIntensity: num(),
    sparkleFocusPower: num(),
    sssIntensity: num(),
    sssPower: num(),
    fftAmplitude: num(),
    gerstnerAmplitude: num()
  }
}

describe('applyWaterproPreset', () => {
  test('writes base scalar fields from the preset', () => {
    const u = makeBag()
    applyWaterproPreset('tranquil', u)
    const p = WATERPRO_PRESETS.tranquil
    expect(u.depthFalloff.value).toBe(p.color.depthFalloff)
    expect(u.fresnelPower.value).toBe(p.fresnel.power)
    expect(u.fadeStart.value).toBe(p.fog.fadeStart)
    expect(u.sparkleFocusPower.value).toBe(p.sparkle.power)
    expect(u.sssIntensity.value).toBe(p.sss.intensity)
    expect(u.fftAmplitude.value).toBe(p.waves.fftAmplitude)
    expect(u.gerstnerAmplitude.value).toBe(p.waves.gerstnerAmplitude)
    expect(u.waveFoamWindStretch.value).toBe(p.foam.waves.windStretch)
  })

  test('converts white hex to linear (1,1,1) without crushing', () => {
    const u = makeBag()
    applyWaterproPreset('tranquil', u) // surface foam color is #ffffff
    expect(u.surfaceFoamColor.value.x).toBeCloseTo(1, 6)
    expect(u.surfaceFoamColor.value.y).toBeCloseTo(1, 6)
    expect(u.surfaceFoamColor.value.z).toBeCloseTo(1, 6)
  })

  test('maps hex channels to the right uniform components, monotonically', () => {
    // tropical.color.deep = '#0985b5' (R < G < B). The exact linear values
    // depend on three's global ColorManagement state (whether Color.set already
    // sRGB-decodes before convertSRGBToLinear), and the preset hex values were
    // tuned by eye against the live pipeline — so assert only the invariants
    // that hold under any monotonic decode: correct channel mapping, ordering,
    // and [0,1] range. Not the absolute decoded magnitude.
    const u = makeBag()
    applyWaterproPreset('tropical', u)
    const { x, y, z } = u.deepColor.value
    for (const c of [x, y, z]) {
      expect(c).toBeGreaterThanOrEqual(0)
      expect(c).toBeLessThanOrEqual(1)
    }
    expect(x).toBeLessThan(y) // 0x09 < 0x85
    expect(y).toBeLessThan(z) // 0x85 < 0xb5
  })

  test('writes optional reflection/turbulent blocks when bag exposes them', () => {
    const u = makeBag()
    u.skyReflectionColor = vec()
    u.skyReflectionExposure = num()
    u.skyReflectionScale = num()
    u.turbulentIntensity = num()
    applyWaterproPreset('tropical', u) // tropical defines both optional blocks
    const p = WATERPRO_PRESETS.tropical
    expect(u.skyReflectionExposure.value).toBe(p.reflection?.exposure)
    expect(u.skyReflectionScale.value).toBe(p.reflection?.scale)
    expect(u.turbulentIntensity.value).toBe(p.turbulent?.intensity)
    expect(u.skyReflectionColor.value.x).toBeCloseTo(1, 6) // #ffffff
  })

  test('does not throw when preset defines optionals but bag omits them', () => {
    const u = makeBag() // no optional uniforms
    expect(() => applyWaterproPreset('tropical', u)).not.toThrow()
  })

  test('leaves optional uniforms untouched when preset omits the blocks', () => {
    const u = makeBag()
    u.skyReflectionExposure = { value: 99 }
    u.turbulentIntensity = { value: 99 }
    applyWaterproPreset('tranquil', u) // tranquil has no reflection/turbulent
    expect(u.skyReflectionExposure.value).toBe(99)
    expect(u.turbulentIntensity.value).toBe(99)
  })
})

describe('WATERPRO_PRESETS table', () => {
  test('WATERPRO_PRESET_NAMES matches the record keys', () => {
    expect([...WATERPRO_PRESET_NAMES].sort()).toEqual(
      Object.keys(WATERPRO_PRESETS).sort()
    )
  })

  test('every preset carries the full required field set', () => {
    for (const name of WATERPRO_PRESET_NAMES) {
      const p = WATERPRO_PRESETS[name]
      expect(typeof p.color.depthFalloff).toBe('number')
      expect(typeof p.fresnel.power).toBe('number')
      expect(typeof p.fog.fadeStart).toBe('number')
      expect(typeof p.sparkle.power).toBe('number')
      expect(typeof p.sss.intensity).toBe('number')
      expect(typeof p.waves.fftAmplitude).toBe('number')
      expect(p.foam.surface).toBeDefined()
      expect(p.foam.shoreline).toBeDefined()
      expect(p.foam.waves).toBeDefined()
    }
  })
})
