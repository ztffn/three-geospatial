// Shared authoring type contract: the on-disk site-content manifest schema
// (versioned decks + slides), the request-input shapes for the CRUD API, and
// the runtime deck/slide shapes the client consumes. Imported by both the
// server (slideshowStore, api) and the client (useScenarioSlideshows,
// SlideshowAuthoring) so both sides agree on the wire format.

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
