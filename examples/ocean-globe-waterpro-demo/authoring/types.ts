// Shared authoring type contract: the on-disk slideshow manifest schema
// (versioned decks + slides), the on-disk site manifest schema (authored
// SiteDefinitions), the request-input shapes for the CRUD API, and the runtime
// shapes the client consumes. Imported by both the server (slideshowStore,
// siteStore, api) and the client hooks so both sides agree on the wire format.

import type { SiteDefinition } from '../sites/types'

export const AUTHORING_MANIFEST_VERSION = 1

export type SlideshowMediaType = 'image' | 'video'

export interface SiteContentManifest {
  version: typeof AUTHORING_MANIFEST_VERSION
  updatedAt: string
  slideshows: SlideshowDeck[]
}

export interface SlideshowDeck {
  id: string
  scenarioId: string
  label: string
  enabled: boolean
  order: number
  slides: SlideshowSlide[]
  createdAt: string
  updatedAt: string
}

export interface SlideshowSlide {
  id: string
  type: SlideshowMediaType
  objectKey: string
  mimeType: string
  title?: string
  order: number
  createdAt: string
}

export interface RuntimeSlideshowDeck {
  id: string
  scenarioId: string
  label: string
  // Publish state, so the author panel (which fetches includeDisabled) can
  // show and toggle it. Visitors only ever receive enabled decks.
  enabled: boolean
  order: number
  slides: RuntimeSlideshowSlide[]
}

export interface RuntimeSlideshowSlide {
  id: string
  type: SlideshowMediaType
  src: string
  title?: string
  order: number
}

export interface AuthoringManifestResponse {
  slideshows: RuntimeSlideshowDeck[]
}

export interface ScenarioSlideshowsResponse {
  slideshows: RuntimeSlideshowDeck[]
}

export interface CreateDeckInput {
  scenarioId: string
  label?: string
}

export interface PatchDeckInput {
  label?: string
  enabled?: boolean
}

export interface PatchSlideInput {
  title?: string
}

export interface OrderInput {
  ids: string[]
}

export interface AuthoringErrorResponse {
  error: string
}

// --- authored site manifest ---------------------------------------------------
// Server-persisted SiteDefinitions (sites.json in the twin-authoring store).
// Committed seeds in sites/ are the defaults; a manifest entry with the same
// id supersedes its seed. Reads are public, writes are admin-gated.

export const SITE_MANIFEST_VERSION = 1

export interface StoredSiteManifest {
  version: typeof SITE_MANIFEST_VERSION
  updatedAt: string
  sites: SiteDefinition[]
}

export interface SitesResponse {
  sites: SiteDefinition[]
  // Null when no authored manifest exists yet (client should use its seeds).
  updatedAt: string | null
}

export interface PutSiteResponse {
  site: SiteDefinition
  updatedAt: string
}
