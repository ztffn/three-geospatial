// Shared authoring type contract: the on-disk slideshow manifest schema
// (versioned decks + slides), the on-disk site manifest schema (authored
// SiteDefinitions), the request-input shapes for the CRUD API, and the runtime
// shapes the client consumes. Imported by both the server (slideshowStore,
// siteStore, api) and the client hooks so both sides agree on the wire format.

import type { SiteDefinition } from '../sites/types'

export const AUTHORING_MANIFEST_VERSION = 1

export type SlideshowMediaType = 'image' | 'video' | 'html' | 'jsx'

// 'html' and 'jsx' slides carry no uploaded file — the author pastes/uploads
// source text and it round-trips as `code`, sandboxed at render time (see
// ui/microApp.ts). 'image'/'video' slides carry no `code` — they reference an
// uploaded object instead.
export const CODE_SLIDE_TYPES: SlideshowMediaType[] = ['html', 'jsx']

export interface AddCodeSlideInput {
  type: 'html' | 'jsx'
  code: string
  title?: string
}

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
  // Present for 'image'/'video' slides; absent for 'html'/'jsx' slides.
  objectKey?: string
  mimeType?: string
  // Present for 'html'/'jsx' slides; absent for 'image'/'video' slides.
  code?: string
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
  // Present for 'image'/'video' slides.
  src?: string
  // Present for 'html'/'jsx' slides.
  code?: string
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

// --- authored path-rig manifest -------------------------------------------------
// Server-persisted @huma/path-creator RigDocuments (rigs.json in the
// twin-authoring store), keyed by the scenario whose author panel edits them.
// Committed seeds in rig/rigSeeds.ts are the defaults; a manifest entry with
// the same scenario id supersedes its seed. Reads public, writes admin-gated.

export const RIG_MANIFEST_VERSION = 1

export interface StoredRigManifest {
  version: typeof RIG_MANIFEST_VERSION
  updatedAt: string
  // scenarioId → serialized RigDocument (opaque to the server beyond
  // validation; the schema is owned by @huma/path-creator).
  rigs: Record<string, unknown>
}

export interface RigsResponse {
  rigs: Record<string, unknown>
  // Null when no authored manifest exists yet (client should use its seeds).
  updatedAt: string | null
}

export interface PutRigResponse {
  updatedAt: string
}
