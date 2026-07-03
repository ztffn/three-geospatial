// Sea-state severity ladder for the WaterPro ocean — the "how rough" axis,
// orthogonal to the look/style presets in presets.ts (the "how it looks"
// axis). Five parameter bags (dead → calm → moderate → rough → storm) anchored
// to MET metrics; callers crossfade between adjacent presets and either ease
// them in (globe story) or apply instantly (applySeaState, atmosphere story).

export interface SeaStateParams {
  fftAmplitude: number
  gerstnerAmplitude: number
  swellStrength: number
  swellScale: number
  waveFoamCoverage: number
  waveFoamOpacity: number
  waveFoamCrestCoverage: number
  waveFoamWindBias: number
  waveFoamWindStretch: number
  surfaceFoamCoverage: number
  surfaceFoamOpacity: number
  surfaceFoamRegionThreshold: number
  tipFoamIntensity: number
  tipFoamHeightThreshold: number
}

export type SeaStateName = 'dead' | 'calm' | 'moderate' | 'rough' | 'storm'

export interface SeaStatePreset {
  name: SeaStateName
  /** Significant wave height anchor (m) — primary MET driver (oceanforecast). */
  waveHeight: number
  /** 10 m wind speed anchor (m/s) — fallback driver (locationforecast). */
  windSpeed: number
  params: SeaStateParams
}

// 'moderate' mirrors the tuned slider/uniform defaults; the rest are artistic.
// Tune a preset with the manual panels (Sea State source = 'off'), press the
// 'logPreset' button, and paste the printed block over the entry here.
export const SEA_STATE_PRESETS: SeaStatePreset[] = [
  {
    name: 'dead',
    waveHeight: 0,
    windSpeed: 0,
    params: {
      fftAmplitude: 0.3,
      gerstnerAmplitude: 0,
      swellStrength: 0.15,
      swellScale: 600,
      waveFoamCoverage: 0,
      waveFoamOpacity: 0,
      waveFoamCrestCoverage: 0,
      waveFoamWindBias: 0,
      waveFoamWindStretch: 0,
      surfaceFoamCoverage: 0,
      surfaceFoamOpacity: 0,
      surfaceFoamRegionThreshold: 0.2,
      tipFoamIntensity: 0,
      tipFoamHeightThreshold: 0.3
    }
  },
  {
    name: 'calm',
    waveHeight: 0.3,
    windSpeed: 3.5,
    params: {
      fftAmplitude: 0.6,
      gerstnerAmplitude: 0.35,
      swellStrength: 0.35,
      swellScale: 700,
      waveFoamCoverage: 0.12,
      waveFoamOpacity: 0.25,
      waveFoamCrestCoverage: 0.05,
      waveFoamWindBias: 0.3,
      waveFoamWindStretch: 0.1,
      surfaceFoamCoverage: 0.01,
      surfaceFoamOpacity: 0.1,
      surfaceFoamRegionThreshold: 0.35,
      tipFoamIntensity: 0.3,
      tipFoamHeightThreshold: 0.4
    }
  },
  {
    name: 'moderate',
    waveHeight: 1.25,
    windSpeed: 8,
    params: {
      fftAmplitude: 1.0,
      gerstnerAmplitude: 1.0,
      swellStrength: 0.5,
      swellScale: 800,
      waveFoamCoverage: 0.5,
      waveFoamOpacity: 0.6,
      waveFoamCrestCoverage: 0.3,
      waveFoamWindBias: 0.8,
      waveFoamWindStretch: 0.5,
      surfaceFoamCoverage: 0.02,
      surfaceFoamOpacity: 0.25,
      surfaceFoamRegionThreshold: 0.5,
      tipFoamIntensity: 1.0,
      tipFoamHeightThreshold: 0.6
    }
  },
  {
    name: 'rough',
    waveHeight: 3,
    windSpeed: 14,
    params: {
      fftAmplitude: 1.3,
      gerstnerAmplitude: 1.55,
      swellStrength: 0.55,
      swellScale: 2200,
      waveFoamCoverage: 0.62,
      waveFoamOpacity: 0.7,
      waveFoamCrestCoverage: 0.45,
      waveFoamWindBias: 0.85,
      waveFoamWindStretch: 0.6,
      surfaceFoamCoverage: 0.06,
      surfaceFoamOpacity: 0.3,
      surfaceFoamRegionThreshold: 0.62,
      tipFoamIntensity: 1.6,
      tipFoamHeightThreshold: 1.0
    }
  },
  {
    // User-tuned 2026-07-03 (logPreset round-trip).
    name: 'storm',
    waveHeight: 6,
    windSpeed: 21,
    params: {
      fftAmplitude: 1.55,
      gerstnerAmplitude: 1.9,
      swellStrength: 0.82,
      swellScale: 2570,
      waveFoamCoverage: 0.27,
      waveFoamOpacity: 0.12,
      waveFoamCrestCoverage: 0,
      waveFoamWindBias: 0.58,
      waveFoamWindStretch: 0.16,
      surfaceFoamCoverage: 0.32,
      surfaceFoamOpacity: 0.18,
      surfaceFoamRegionThreshold: 0.81,
      tipFoamIntensity: 0.45,
      tipFoamHeightThreshold: 2.25
    }
  }
]

export const SEA_STATE_NAMES: SeaStateName[] = SEA_STATE_PRESETS.map(
  p => p.name
)

export const SEA_STATE_PARAM_KEYS = Object.keys(
  SEA_STATE_PRESETS[0].params
) as Array<keyof SeaStateParams>

/** Ladder index (0 = dead … 4 = storm) of a named preset; 0 if unknown. */
export function severityIndexOf(name: SeaStateName): number {
  const i = SEA_STATE_PRESETS.findIndex(p => p.name === name)
  return i < 0 ? 0 : i
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

/**
 * Interpolated parameter bag at a severity expressed in ladder-index space (0 =
 * dead … 4 = storm, fractional between). Clamped at both ends.
 */
export function sampleSeaState(severity: number): SeaStateParams {
  const max = SEA_STATE_PRESETS.length - 1
  const s = Math.min(Math.max(severity, 0), max)
  const lo = SEA_STATE_PRESETS[Math.floor(s)].params
  const hi = SEA_STATE_PRESETS[Math.min(Math.floor(s) + 1, max)].params
  const t = s - Math.floor(s)
  const out = {} as SeaStateParams
  for (const key of SEA_STATE_PARAM_KEYS) {
    out[key] = lerp(lo[key], hi[key], t)
  }
  return out
}

// Piecewise-linear position of `value` along per-preset anchors, in ladder-
// index space. Clamped; anchors are strictly increasing by construction.
function severityFromAnchors(value: number, anchors: number[]): number {
  if (value <= anchors[0]) return 0
  const last = anchors.length - 1
  if (value >= anchors[last]) return last
  let i = 0
  while (value > anchors[i + 1]) i++
  return i + (value - anchors[i]) / (anchors[i + 1] - anchors[i])
}

/**
 * Severity from live MET metrics. Prefers significant wave height — the
 * oceanforecast wave model bakes in coastal shelter, fetch and bathymetry, so
 * the same wind reads calmer near land than in open sea. Falls back to wind
 * speed (locationforecast) outside ocean coverage; null when neither exists
 * (caller falls back to the manual severity slider).
 */
export function severityFromMetrics(
  waveHeight: number | null | undefined,
  windSpeed: number | null | undefined
): number | null {
  if (typeof waveHeight === 'number') {
    return severityFromAnchors(
      waveHeight,
      SEA_STATE_PRESETS.map(p => p.waveHeight)
    )
  }
  if (typeof windSpeed === 'number') {
    return severityFromAnchors(
      windSpeed,
      SEA_STATE_PRESETS.map(p => p.windSpeed)
    )
  }
  return null
}

// Uniform bag applySeaState writes into. The 9 core fields exist on every
// WaterPro material; the 5 vertex-stage-only fields (swell / tip / region
// threshold) are optional — applySeaState skips whichever the bag omits, so
// the TSL-only atmosphere story (no WGSL swell/tip) can share the applier.
export interface SeaStateUniformBag {
  fftAmplitude: { value: number }
  gerstnerAmplitude: { value: number }
  waveFoamCoverage: { value: number }
  waveFoamOpacity: { value: number }
  waveFoamCrestCoverage: { value: number }
  waveFoamWindBias: { value: number }
  waveFoamWindStretch: { value: number }
  surfaceFoamCoverage: { value: number }
  surfaceFoamOpacity: { value: number }
  swellStrength?: { value: number }
  swellScale?: { value: number }
  surfaceFoamRegionThreshold?: { value: number }
  tipFoamIntensity?: { value: number }
  tipFoamHeightThreshold?: { value: number }
}

/**
 * Write a sea-state parameter bag into a uniform bag instantly (no easing).
 * Used by callers with no MET-driven crossfade loop (the atmosphere story); the
 * globe story eases the same fields per-frame instead.
 */
export function applySeaState(
  params: SeaStateParams,
  bag: SeaStateUniformBag
): void {
  bag.fftAmplitude.value = params.fftAmplitude
  bag.gerstnerAmplitude.value = params.gerstnerAmplitude
  bag.waveFoamCoverage.value = params.waveFoamCoverage
  bag.waveFoamOpacity.value = params.waveFoamOpacity
  bag.waveFoamCrestCoverage.value = params.waveFoamCrestCoverage
  bag.waveFoamWindBias.value = params.waveFoamWindBias
  bag.waveFoamWindStretch.value = params.waveFoamWindStretch
  bag.surfaceFoamCoverage.value = params.surfaceFoamCoverage
  bag.surfaceFoamOpacity.value = params.surfaceFoamOpacity
  if (bag.swellStrength != null) bag.swellStrength.value = params.swellStrength
  if (bag.swellScale != null) bag.swellScale.value = params.swellScale
  if (bag.surfaceFoamRegionThreshold != null) {
    bag.surfaceFoamRegionThreshold.value = params.surfaceFoamRegionThreshold
  }
  if (bag.tipFoamIntensity != null) {
    bag.tipFoamIntensity.value = params.tipFoamIntensity
  }
  if (bag.tipFoamHeightThreshold != null) {
    bag.tipFoamHeightThreshold.value = params.tipFoamHeightThreshold
  }
}

/**
 * Paste-ready preset block for the tuning round-trip: sculpt the ocean with the
 * manual panels, press the Sea State 'logPreset' button, paste the printed
 * params over the matching entry in SEA_STATE_PRESETS above.
 */
export function formatSeaStatePreset(
  name: string,
  params: SeaStateParams
): string {
  const round = (v: number): number => Math.round(v * 1000) / 1000
  const lines = SEA_STATE_PARAM_KEYS.map(
    key => `      ${key}: ${round(params[key])}`
  )
  return `// sea-state preset '${name}'\n    params: {\n${lines.join(',\n')}\n    }`
}
