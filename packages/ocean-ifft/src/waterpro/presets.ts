// Water-only subset of the WaterPro scene presets. Strips atmosphere, caustics,
// oceanFloor, postProcessing, fresnel.underwater, ssr — those concerns live on
// the AtmosphereContextNode and post-processing pipeline, not the ocean
// material. Source: tools/waterpro-decoder/extracted-presets.json.
// Applier converts hex strings to linear-space Vector3 and writes into a
// caller-supplied uniform bag.

import { Color, Vector3 } from 'three'

export interface WaterproPresetWaterFields {
  color: {
    shallow: string
    deep: string
    depthFalloff: number
    transmission: string
  }
  foam: {
    surface: { color: string; coverage: number; opacity: number; size: number }
    shoreline: {
      color: string
      coverage: number
      opacity: number
      range: number
      size: number
    }
    waves: {
      color: string
      coverage: number
      crestCoverage: number
      opacity: number
      peakIntensity: number
      rippleWeight: number
      waveWeight: number
      windBias: number
      windStretch: number
      size: number
    }
  }
  fresnel: { normalStrength: number; power: number }
  fog: { fadeStart: number; fadePower: number }
  sparkle: { intensity: number; power: number }
  sss: { intensity: number; power: number }
  waves: { fftAmplitude: number; gerstnerAmplitude: number }
}

export type WaterproPresetName =
  | 'arctic'
  | 'choppy'
  | 'foggy'
  | 'hurricane'
  | 'moonlit'
  | 'seaOfThieves'
  | 'storm'
  | 'sunset'
  | 'tranquil'
  | 'tropical'

export const WATERPRO_PRESETS: Record<WaterproPresetName, WaterproPresetWaterFields> = {
  arctic: {
    color: { shallow: '#263a42', deep: '#152535', depthFalloff: 45, transmission: '#719cb8' },
    foam: {
      surface: { color: '#ffffff', coverage: 0.11, opacity: 0.85, size: 134 },
      shoreline: { color: '#edf9fd', coverage: 0.69, opacity: 0.45, range: 87, size: 178 },
      waves: { color: '#ffffff', coverage: 0.25, crestCoverage: 0.35, opacity: 0.25, peakIntensity: 0.35, rippleWeight: 0.7, waveWeight: 1, windBias: 0.45, windStretch: 0.3, size: 150 },
    },
    fresnel: { normalStrength: 0.95, power: 3.5 },
    fog: { fadeStart: 1200, fadePower: 1 },
    sparkle: { intensity: 1, power: 960 },
    sss: { intensity: 0.5, power: 2.8 },
    waves: { fftAmplitude: 0.36, gerstnerAmplitude: 3 },
  },
  choppy: {
    color: { shallow: '#153c38', deep: '#223f3f', depthFalloff: 60, transmission: '#4cbdac' },
    foam: {
      surface: { color: '#ffffff', coverage: 0.14, opacity: 0.25, size: 206 },
      shoreline: { color: '#edf9fd', coverage: 0.77, opacity: 0.2, range: 35, size: 178 },
      waves: { color: '#ffffff', coverage: 0.33, crestCoverage: 0, opacity: 0.35, peakIntensity: 0.35, rippleWeight: 0.65, waveWeight: 1, windBias: 0, windStretch: 0, size: 500 },
    },
    fresnel: { normalStrength: 0.5, power: 3.6 },
    fog: { fadeStart: 500, fadePower: 1 },
    sparkle: { intensity: 1, power: 960 },
    sss: { intensity: 0.6, power: 2.3 },
    waves: { fftAmplitude: 0.4, gerstnerAmplitude: 0 },
  },
  foggy: {
    color: { shallow: '#3a4a55', deep: '#1a2a35', depthFalloff: 35, transmission: '#506570' },
    foam: {
      surface: { color: '#e0e0e0', coverage: 0.13, opacity: 0.45, size: 189 },
      shoreline: { color: '#edf9fd', coverage: 0.69, opacity: 0.45, range: 87, size: 178 },
      waves: { color: '#e0e0e0', coverage: 0.35, crestCoverage: 0.35, opacity: 0.25, peakIntensity: 0.3, rippleWeight: 0.7, waveWeight: 1, windBias: 0.6, windStretch: 0.25, size: 140 },
    },
    fresnel: { normalStrength: 0.8, power: 3 },
    fog: { fadeStart: 200, fadePower: 1 },
    sparkle: { intensity: 1, power: 960 },
    sss: { intensity: 0.3, power: 3.5 },
    waves: { fftAmplitude: 0.1, gerstnerAmplitude: 1.5 },
  },
  hurricane: {
    color: { shallow: '#142828', deep: '#02191d', depthFalloff: 55, transmission: '#3a5a50' },
    foam: {
      surface: { color: '#ffffff', coverage: 0.16, opacity: 0.2, size: 94 },
      shoreline: { color: '#edf9fd', coverage: 0.81, opacity: 0.1, range: 75, size: 178 },
      waves: { color: '#ffffff', coverage: 0.31, crestCoverage: 0.45, opacity: 0.25, peakIntensity: 0.3, rippleWeight: 0.85, waveWeight: 1, windBias: 0.6, windStretch: 0.51, size: 136 },
    },
    fresnel: { normalStrength: 0.63, power: 6.1 },
    fog: { fadeStart: 900, fadePower: 1 },
    sparkle: { intensity: 1, power: 960 },
    sss: { intensity: 1.03, power: 1.28 },
    waves: { fftAmplitude: 0.65, gerstnerAmplitude: 5.42 },
  },
  moonlit: {
    color: { shallow: '#000000', deep: '#000005', depthFalloff: 45, transmission: '#ffffff' },
    foam: {
      surface: { color: '#c0c8d0', coverage: 0.27, opacity: 0.05, size: 206 },
      shoreline: { color: '#edf9fd', coverage: 0.69, opacity: 0.45, range: 87, size: 178 },
      waves: { color: '#c0c8d0', coverage: 0.4, crestCoverage: 0.2, opacity: 0.12, peakIntensity: 0.2, rippleWeight: 0.5, waveWeight: 0.8, windBias: 0.5, windStretch: 0.2, size: 150 },
    },
    fresnel: { normalStrength: 0.4, power: 1.8 },
    fog: { fadeStart: 300, fadePower: 1 },
    sparkle: { intensity: 1, power: 960 },
    sss: { intensity: 0.2, power: 3 },
    waves: { fftAmplitude: 0.2, gerstnerAmplitude: 0 },
  },
  seaOfThieves: {
    color: { shallow: '#063828', deep: '#0d2f3b', depthFalloff: 65, transmission: '#50a890' },
    foam: {
      surface: { color: '#ffffff', coverage: 0.22, opacity: 0.07, size: 130 },
      shoreline: { color: '#edf9fd', coverage: 0.69, opacity: 0.45, range: 87, size: 178 },
      waves: { color: '#ffffff', coverage: 0.16, crestCoverage: 0.25, opacity: 0.45, peakIntensity: 0.4, rippleWeight: 0.7, waveWeight: 1, windBias: 0.7, windStretch: 0.3, size: 180 },
    },
    fresnel: { normalStrength: 0.85, power: 5.5 },
    fog: { fadeStart: 500, fadePower: 1 },
    sparkle: { intensity: 1, power: 960 },
    sss: { intensity: 0.5, power: 0.92 },
    waves: { fftAmplitude: 1, gerstnerAmplitude: 5 },
  },
  storm: {
    color: { shallow: '#1a3035', deep: '#021112', depthFalloff: 1, transmission: '#4a7068' },
    foam: {
      surface: { color: '#ffffff', coverage: 0.2, opacity: 0.07, size: 110 },
      shoreline: { color: '#edf9fd', coverage: 0.69, opacity: 0.45, range: 87, size: 178 },
      waves: { color: '#ffffff', coverage: 0.32, crestCoverage: 0.35, opacity: 0.2, peakIntensity: 0.2, rippleWeight: 0.8, waveWeight: 1, windBias: 0.75, windStretch: 0.43, size: 94 },
    },
    fresnel: { normalStrength: 0.51, power: 6.2 },
    fog: { fadeStart: 1050, fadePower: 3 },
    sparkle: { intensity: 1, power: 960 },
    sss: { intensity: 0.6, power: 2.5 },
    waves: { fftAmplitude: 0.7, gerstnerAmplitude: 2.06 },
  },
  sunset: {
    color: { shallow: '#1a4038', deep: '#0c2a28', depthFalloff: 55, transmission: '#e8a060' },
    foam: {
      surface: { color: '#fff8e8', coverage: 0.26, opacity: 0.05, size: 130 },
      shoreline: { color: '#edf9fd', coverage: 0.69, opacity: 0.45, range: 87, size: 178 },
      waves: { color: '#fff8e8', coverage: 0.35, crestCoverage: 0.35, opacity: 0.3, peakIntensity: 0.3, rippleWeight: 0.6, waveWeight: 1, windBias: 0.65, windStretch: 0.25, size: 160 },
    },
    fresnel: { normalStrength: 0.9, power: 3.5 },
    fog: { fadeStart: 400, fadePower: 1 },
    sparkle: { intensity: 1, power: 960 },
    sss: { intensity: 0.3, power: 2.5 },
    waves: { fftAmplitude: 0.45, gerstnerAmplitude: 2 },
  },
  tranquil: {
    color: { shallow: '#0a4a45', deep: '#062e30', depthFalloff: 80, transmission: '#5abda8' },
    foam: {
      surface: { color: '#ffffff', coverage: 0.3, opacity: 0.03, size: 140 },
      shoreline: { color: '#edf9fd', coverage: 0.69, opacity: 0.45, range: 87, size: 178 },
      waves: { color: '#ffffff', coverage: 0.4, crestCoverage: 0.15, opacity: 0.15, peakIntensity: 0.2, rippleWeight: 0.4, waveWeight: 0.8, windBias: 0.5, windStretch: 0.15, size: 150 },
    },
    fresnel: { normalStrength: 0.9, power: 6.5 },
    fog: { fadeStart: 500, fadePower: 1 },
    sparkle: { intensity: 1, power: 960 },
    sss: { intensity: 0.4, power: 3 },
    waves: { fftAmplitude: 0.25, gerstnerAmplitude: 0.8 },
  },
  tropical: {
    color: { shallow: '#227272', deep: '#0a5e6b', depthFalloff: 250, transmission: '#30c4a8' },
    foam: {
      surface: { color: '#ffffff', coverage: 0.2, opacity: 0.06, size: 150 },
      shoreline: { color: '#e8fcff', coverage: 0.72, opacity: 0.35, range: 30, size: 178 },
      waves: { color: '#ffffff', coverage: 0.2, crestCoverage: 0.2, opacity: 0.15, peakIntensity: 0.2, rippleWeight: 0.4, waveWeight: 0.8, windBias: 0.5, windStretch: 0.15, size: 160 },
    },
    fresnel: { normalStrength: 0.97, power: 4.7 },
    fog: { fadeStart: 1150, fadePower: 1 },
    sparkle: { intensity: 1, power: 960 },
    sss: { intensity: 1.6, power: 2.2 },
    waves: { fftAmplitude: 0.43, gerstnerAmplitude: 2.12 },
  },
}

// Uniform bag the applier writes into. Caller owns the uniform identities; the
// applier only mutates `.value`. Vector3 uniforms are written as linear-space
// RGB — preset hex strings are sRGB-encoded.
export interface WaterproPresetUniformBag {
  shallowColor: { value: Vector3 }
  deepColor: { value: Vector3 }
  depthFalloff: { value: number }
  transmissionColor: { value: Vector3 }

  surfaceFoamColor: { value: Vector3 }
  surfaceFoamCoverage: { value: number }
  surfaceFoamOpacity: { value: number }
  surfaceFoamSize: { value: number }

  shorelineFoamColor: { value: Vector3 }
  shorelineFoamCoverage: { value: number }
  shorelineFoamOpacity: { value: number }
  shorelineFoamRange: { value: number }
  shorelineFoamSize: { value: number }

  waveFoamColor: { value: Vector3 }
  waveFoamCoverage: { value: number }
  waveFoamCrestCoverage: { value: number }
  waveFoamOpacity: { value: number }
  waveFoamPeakIntensity: { value: number }
  waveFoamRippleWeight: { value: number }
  waveFoamWaveWeight: { value: number }
  waveFoamWindBias: { value: number }
  waveFoamWindStretch: { value: number }
  waveFoamSize: { value: number }

  fresnelNormalStrength: { value: number }
  fresnelPower: { value: number }

  fadeStart: { value: number }
  fadePower: { value: number }

  sparkleIntensity: { value: number }
  sparkleFocusPower: { value: number }

  sssIntensity: { value: number }
  sssPower: { value: number }

  fftAmplitude: { value: number }
  gerstnerAmplitude: { value: number }
}

const scratchColor = new Color()
function setHexAsLinearVec3(target: Vector3, hex: string): void {
  scratchColor.set(hex).convertSRGBToLinear()
  target.set(scratchColor.r, scratchColor.g, scratchColor.b)
}

export function applyWaterproPreset(
  name: WaterproPresetName,
  u: WaterproPresetUniformBag
): void {
  const p = WATERPRO_PRESETS[name]

  setHexAsLinearVec3(u.shallowColor.value, p.color.shallow)
  setHexAsLinearVec3(u.deepColor.value, p.color.deep)
  setHexAsLinearVec3(u.transmissionColor.value, p.color.transmission)
  u.depthFalloff.value = p.color.depthFalloff

  setHexAsLinearVec3(u.surfaceFoamColor.value, p.foam.surface.color)
  u.surfaceFoamCoverage.value = p.foam.surface.coverage
  u.surfaceFoamOpacity.value = p.foam.surface.opacity
  u.surfaceFoamSize.value = p.foam.surface.size

  setHexAsLinearVec3(u.shorelineFoamColor.value, p.foam.shoreline.color)
  u.shorelineFoamCoverage.value = p.foam.shoreline.coverage
  u.shorelineFoamOpacity.value = p.foam.shoreline.opacity
  u.shorelineFoamRange.value = p.foam.shoreline.range
  u.shorelineFoamSize.value = p.foam.shoreline.size

  setHexAsLinearVec3(u.waveFoamColor.value, p.foam.waves.color)
  u.waveFoamCoverage.value = p.foam.waves.coverage
  u.waveFoamCrestCoverage.value = p.foam.waves.crestCoverage
  u.waveFoamOpacity.value = p.foam.waves.opacity
  u.waveFoamPeakIntensity.value = p.foam.waves.peakIntensity
  u.waveFoamRippleWeight.value = p.foam.waves.rippleWeight
  u.waveFoamWaveWeight.value = p.foam.waves.waveWeight
  u.waveFoamWindBias.value = p.foam.waves.windBias
  u.waveFoamWindStretch.value = p.foam.waves.windStretch
  u.waveFoamSize.value = p.foam.waves.size

  u.fresnelNormalStrength.value = p.fresnel.normalStrength
  u.fresnelPower.value = p.fresnel.power

  u.fadeStart.value = p.fog.fadeStart
  u.fadePower.value = p.fog.fadePower

  u.sparkleIntensity.value = p.sparkle.intensity
  u.sparkleFocusPower.value = p.sparkle.power

  u.sssIntensity.value = p.sss.intensity
  u.sssPower.value = p.sss.power

  u.fftAmplitude.value = p.waves.fftAmplitude
  u.gerstnerAmplitude.value = p.waves.gerstnerAmplitude
}

export const WATERPRO_PRESET_NAMES: WaterproPresetName[] = Object.keys(
  WATERPRO_PRESETS
) as WaterproPresetName[]
