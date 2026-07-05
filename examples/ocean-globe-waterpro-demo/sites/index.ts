// Site catalogue barrel: the committed seed SiteDefinitions (defaults the
// server-side site manifest starts from / falls back to), the shared schema
// types, and the ENU→world helpers. Seeds are keyed by site id; the author
// panel offers saving a seed into the server manifest, after which the
// manifest copy wins for that id.

export * from './types'
// Client-side only (pulls in three); server code imports from './types'.
export * from './enu'
export * from './runtime'
export { KARMOY_SITE } from './karmoy.site'
export * from './static-sites'

import type { SiteDefinition } from './types'
import { KARMOY_SITE } from './karmoy.site'
import {
  BODO_SITE,
  KARMOY_ISLAND_SITE,
  NORWEGIAN_SEA_SITE,
  UTSIRA_NORD_SITE
} from './static-sites'

// One seed per anchor the twin uses — every scenario has a host site, so
// viewpoint capture always has a truthful place to write.
export const SITE_SEEDS: readonly SiteDefinition[] = [
  KARMOY_SITE,
  KARMOY_ISLAND_SITE,
  UTSIRA_NORD_SITE,
  BODO_SITE,
  NORWEGIAN_SEA_SITE
]
