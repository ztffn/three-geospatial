// cloud-presets.ts — Weather/mood presets for the lightweight CloudLayer shell.
// Each preset is a bag of the CloudLayer knobs (coverage/opacity/colour/etc.)
// describing a sky mood. Mirrors the WaterPro preset pattern: a typed field set
// + a named record, consumed by the globe story's preset selector. Pure data —
// no three/TSL imports, so it can be reused by any cloud-layer host.

export interface CloudPresetFields {
  /** Metres above the WGS84 ellipsoid. Storms sit lower, fair weather higher. */
  altitude: number
  /** Coverage threshold — LOWER = more cloud cover. */
  coverage: number
  /** Global opacity multiplier. */
  opacity: number
  /** Noise frequency — higher = smaller, more numerous blobs. */
  tiles: number
  /** UV scroll speed (wind). */
  windSpeed: number
  /** Lit (day) cloud colour. Grey/dark for overcast + storm moods. */
  dayColor: string
  /** Ambient floor at night so clouds aren't pure black. */
  nightAmbient: number
  /** Density darkening — dense cores go darker (0 = flat, 1 = black cores). */
  density: number
  /** Radiance multiplier — higher punches through the atmosphere; lower = moodier. */
  intensity: number
}

export type CloudPresetName =
  | 'clear'
  | 'fair'
  | 'overcast'
  | 'moody'
  | 'stormy'

export const CLOUD_PRESETS: Record<CloudPresetName, CloudPresetFields> = {
  // Sparse high wisps — mostly blue sky.
  clear: {
    altitude: 6000,
    coverage: 0.74,
    opacity: 0.55,
    tiles: 8,
    windSpeed: 0.003,
    dayColor: '#ffffff',
    nightAmbient: 0.05,
    density: 0.0,
    intensity: 2.6,
  },
  // Scattered white fair-weather cumulus (the default look).
  fair: {
    altitude: 4000,
    coverage: 0.71,
    opacity: 0.24,
    tiles: 10,
    windSpeed: 0.004,
    dayColor: '#ffffff',
    nightAmbient: 0.03,
    density: 0,
    intensity: 2.5,
  },
  // Broad grey deck, low contrast, high cover.
  overcast: {
    altitude: 3000,
    coverage: 0.2,
    opacity: 0.95,
    tiles: 8,
    windSpeed: 0.006,
    dayColor: '#e2e6e9',
    nightAmbient: 0.04,
    density: 0.35,
    intensity: 1.8,
  },
  // Darker, dramatic, faster — pre-storm mood.
  moody: {
    altitude: 2500,
    coverage: 0.3,
    opacity: 0.92,
    tiles: 12,
    windSpeed: 0.011,
    dayColor: '#c2c7cc',
    nightAmbient: 0.02,
    density: 0.55,
    intensity: 1.3,
  },
  // Dense, dark, low and fast.
  stormy: {
    altitude: 2000,
    coverage: 0.12,
    opacity: 1.0,
    tiles: 14,
    windSpeed: 0.018,
    dayColor: '#9aa0a6',
    nightAmbient: 0.015,
    density: 0.8,
    intensity: 0.95,
  },
}

export const CLOUD_PRESET_NAMES = Object.keys(CLOUD_PRESETS) as CloudPresetName[]
