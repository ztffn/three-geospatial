// Default WaterPro wave-simulation parameters.
// Values transcribed from the decompiled WaterPro source:
//   - vF quality presets ({low,medium,high,ultra} → cascades, resolution)
//   - FIRST_WAVE_DATASET / SECOND_WAVE_DATASET (spectrum tuning)
//   - LENGTH_SCALES / LAMBDA / FOAM defaults
// Two superposed wave spectra are summed at the spectrum stage — primary swell
// + secondary cross-swell — matching WaterPro's two-spectrum-per-cascade design.

import { uniform } from 'three/tsl'

export interface SpectrumParams {
  // Phillips/JONSWAP-derived inputs (per-spectrum, per-cascade)
  depth: any
  scaleHeight: any
  windSpeed: any
  windDirection: any  // radians
  fetch: any
  spreadBlend: any    // 0..1
  swell: any          // 0..1
  peakEnhancement: any
  shortWaveFade: any
  fadeLimit: any
}

export interface DualSpectrumParams {
  primary: SpectrumParams
  secondary: SpectrumParams
}

export function makePrimarySpectrum(): SpectrumParams {
  return {
    depth: uniform(20),
    scaleHeight: uniform(1),
    windSpeed: uniform(1),
    windDirection: uniform(0),
    fetch: uniform(100000),
    spreadBlend: uniform(1),
    swell: uniform(0.198),
    peakEnhancement: uniform(3.3),
    shortWaveFade: uniform(0.0),
    fadeLimit: uniform(0.0),
  }
}

export function makeSecondarySpectrum(): SpectrumParams {
  return {
    depth: uniform(20),
    scaleHeight: uniform(1),
    windSpeed: uniform(1),
    windDirection: uniform((240 / 360) * 2 * Math.PI),
    fetch: uniform(300000),
    spreadBlend: uniform(1),
    swell: uniform(0.5),
    peakEnhancement: uniform(3.3),
    shortWaveFade: uniform(0.0),
    fadeLimit: uniform(0.0),
  }
}

export interface CascadeConfig {
  lengthScale: number  // world meters covered by one IFFT tile
  lambda: number       // horizontal displacement steepness multiplier (0..1)
  boundaryLow: number  // low frequency cutoff (1/m wavenumber)
  boundaryHigh: number // high frequency cutoff
}

// WaterPro three-cascade defaults from src/waves/wave-constants.js
// LENGTH_SCALES = [250, 17, 5], LAMBDA = [0.9, 0.9, 0.9]
export const DEFAULT_CASCADES: CascadeConfig[] = [
  { lengthScale: 250, lambda: 0.9, boundaryLow: 0.0001, boundaryHigh: 0.5 },
  { lengthScale: 17, lambda: 0.9, boundaryLow: 0.5, boundaryHigh: 6 },
  { lengthScale: 5, lambda: 0.9, boundaryLow: 6, boundaryHigh: 1e6 },
]

export const DEFAULT_RESOLUTION = 256
export const DEFAULT_WORKGROUP: [number, number, number] = [16, 16, 1]
