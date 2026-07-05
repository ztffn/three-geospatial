// Seed sites for every anchor the static scenario catalogue uses (beyond the
// Karmøy offshore site in karmoy.site.ts). Each carries only its identity and
// anchor — no scenarios; authored content (captured views, new scenarios)
// materializes into the server manifest under these ids. Anchors mirror the
// scene's locationPresets exactly, so every static scenario has a host site.

import type { SiteDefinition } from './types'

// Waste Handling + Realtime Geospatial share this anchor (the land patch on
// Karmøy island) — one site hosts both scenarios.
export const KARMOY_ISLAND_SITE: SiteDefinition = {
  id: 'karmoy-island',
  label: 'Karmøy Island',
  anchor: {
    longitude: 5.300927,
    latitude: 59.402448,
    height: 20,
    frame: 'wgs84-enu'
  },
  layers: [],
  scenarios: [],
  annotations: []
}

export const UTSIRA_NORD_SITE: SiteDefinition = {
  id: 'utsira-nord',
  label: 'Utsira Nord',
  anchor: { longitude: 4.55, latitude: 59.3, height: 20, frame: 'wgs84-enu' },
  layers: [],
  scenarios: [],
  annotations: []
}

export const BODO_SITE: SiteDefinition = {
  id: 'bodo',
  label: 'Bodø',
  anchor: { longitude: 14.25, latitude: 67.3, height: 20, frame: 'wgs84-enu' },
  layers: [],
  scenarios: [],
  annotations: []
}

export const NORWEGIAN_SEA_SITE: SiteDefinition = {
  id: 'norwegian-sea',
  label: 'Norwegian Sea',
  anchor: { longitude: 13.2, latitude: 67.5, height: 20, frame: 'wgs84-enu' },
  layers: [],
  scenarios: [],
  annotations: []
}

// Site ↔ scene-preset pairing, keyed by NAME (the one table asserting which
// locationPresets a site's anchor is). Static↔site matching goes through this
// key, never through float coordinate equality — a coordinate tweak in either
// table can't silently unlink authoring. Keep anchors above in sync with the
// story's locationPresets values.
export const SITE_PRESETS: Record<string, readonly string[]> = {
  karmoy: ['Karmøy'],
  'karmoy-island': ['Waste Handling', 'Realtime Geospatial'],
  'utsira-nord': ['Utsira Nord'],
  bodo: ['Bodø'],
  'norwegian-sea': ['Norwegian Sea']
}
