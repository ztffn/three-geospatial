import path from 'node:path'

import {
  deleteObject,
  getJson,
  getObject,
  isSafeObjectKey,
  putJson,
  putObject
} from './storage'
import {
  AUTHORING_MANIFEST_VERSION,
  type CreateDeckInput,
  type OrderInput,
  type PatchDeckInput,
  type PatchSlideInput,
  type RuntimeSlideshowDeck,
  type SiteContentManifest,
  type SlideshowDeck,
  type SlideshowMediaType,
  type SlideshowSlide
} from './types'

const AUTHORING_STORE = 'twin-authoring'
const MEDIA_STORE = 'twin-media'
const MANIFEST_KEY = 'manifest.json'
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024

const IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif'
])

const VIDEO_TYPES = new Set(['video/mp4'])

export class AuthoringHttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'AuthoringHttpError'
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

function id(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`
}

function emptyManifest(): SiteContentManifest {
  return {
    version: AUTHORING_MANIFEST_VERSION,
    updatedAt: nowIso(),
    slideshows: []
  }
}

function sortByOrder<T extends { order: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.order - b.order)
}

function normalizeOrders<T extends { order: number }>(items: T[]): T[] {
  return sortByOrder(items).map((item, order) => ({ ...item, order }))
}

function normalizeManifest(
  raw: SiteContentManifest | null
): SiteContentManifest {
  if (raw?.version !== AUTHORING_MANIFEST_VERSION) {
    return emptyManifest()
  }
  return {
    ...raw,
    slideshows: normalizeOrders(raw.slideshows).map(deck => ({
      ...deck,
      slides: normalizeOrders(deck.slides)
    }))
  }
}

async function readManifest(): Promise<SiteContentManifest> {
  return normalizeManifest(
    await getJson<SiteContentManifest>(AUTHORING_STORE, MANIFEST_KEY)
  )
}

async function writeManifest(
  manifest: SiteContentManifest
): Promise<SiteContentManifest> {
  const normalized = normalizeManifest({
    ...manifest,
    updatedAt: nowIso()
  })
  await putJson(AUTHORING_STORE, MANIFEST_KEY, normalized)
  return normalized
}

function publicMediaUrl(objectKey: string): string {
  return `/api/authoring/media/${encodeURIComponent(objectKey)}`
}

function toRuntimeDeck(deck: SlideshowDeck): RuntimeSlideshowDeck {
  return {
    id: deck.id,
    scenarioId: deck.scenarioId,
    label: deck.label,
    order: deck.order,
    slides: sortByOrder(deck.slides).map(slide => ({
      id: slide.id,
      type: slide.type,
      src: publicMediaUrl(slide.objectKey),
      title: slide.title,
      order: slide.order
    }))
  }
}

function toRuntimeDecks(
  manifest: SiteContentManifest,
  includeDisabled: boolean
): RuntimeSlideshowDeck[] {
  return sortByOrder(manifest.slideshows)
    .filter(deck => includeDisabled || deck.enabled)
    .map(toRuntimeDeck)
}

function deckOrThrow(
  manifest: SiteContentManifest,
  deckId: string
): SlideshowDeck {
  const deck = manifest.slideshows.find(candidate => candidate.id === deckId)
  if (deck == null) throw new AuthoringHttpError(404, 'slideshow not found')
  return deck
}

function mediaTypeFor(mimeType: string): SlideshowMediaType {
  if (IMAGE_TYPES.has(mimeType)) return 'image'
  if (VIDEO_TYPES.has(mimeType)) return 'video'
  throw new AuthoringHttpError(400, 'unsupported media type')
}

function extensionFor(mimeType: string): string {
  const ext: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/avif': '.avif',
    'video/mp4': '.mp4'
  }
  return ext[mimeType] ?? '.bin'
}

function cleanLabel(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed.slice(0, 80) : fallback
}

function cleanOptionalTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed.slice(0, 120) : undefined
}

function reordered<T extends { id: string; order: number }>(
  items: T[],
  input: OrderInput
): T[] {
  const known = new Set(items.map(item => item.id))
  const incoming = input.ids.filter(itemId => known.has(itemId))
  const missing = items
    .map(item => item.id)
    .filter(itemId => !incoming.includes(itemId))
  const order = [...incoming, ...missing]
  return items.map(item => ({ ...item, order: order.indexOf(item.id) }))
}

export async function getRuntimeManifest(
  includeDisabled = false
): Promise<RuntimeSlideshowDeck[]> {
  return toRuntimeDecks(await readManifest(), includeDisabled)
}

export async function getScenarioSlideshows(
  scenarioId: string,
  includeDisabled = false
): Promise<RuntimeSlideshowDeck[]> {
  const manifest = await readManifest()
  return toRuntimeDecks(manifest, includeDisabled).filter(
    deck => deck.scenarioId === scenarioId
  )
}

export async function createDeck(
  input: CreateDeckInput
): Promise<SlideshowDeck> {
  const scenarioId = cleanLabel(input.scenarioId, '')
  if (scenarioId.length === 0) {
    throw new AuthoringHttpError(400, 'scenarioId is required')
  }
  const manifest = await readManifest()
  const at = nowIso()
  const scenarioDecks = manifest.slideshows.filter(
    deck => deck.scenarioId === scenarioId
  )
  const deck: SlideshowDeck = {
    id: id('deck'),
    scenarioId,
    label: cleanLabel(input.label, 'Untitled slideshow'),
    enabled: true,
    order: scenarioDecks.length,
    slides: [],
    createdAt: at,
    updatedAt: at
  }
  await writeManifest({
    ...manifest,
    slideshows: [...manifest.slideshows, deck]
  })
  return deck
}

export async function patchDeck(
  deckId: string,
  input: PatchDeckInput
): Promise<SlideshowDeck> {
  const manifest = await readManifest()
  let updated: SlideshowDeck | null = null
  const slideshows = manifest.slideshows.map(deck => {
    if (deck.id !== deckId) return deck
    updated = {
      ...deck,
      ...(input.label != null
        ? { label: cleanLabel(input.label, deck.label) }
        : {}),
      ...(typeof input.enabled === 'boolean' ? { enabled: input.enabled } : {}),
      updatedAt: nowIso()
    }
    return updated
  })
  if (updated == null) throw new AuthoringHttpError(404, 'slideshow not found')
  await writeManifest({ ...manifest, slideshows })
  return updated
}

export async function deleteDeck(deckId: string): Promise<void> {
  const manifest = await readManifest()
  const deck = deckOrThrow(manifest, deckId)
  await Promise.all(
    deck.slides.map(async slide => {
      await deleteObject(MEDIA_STORE, slide.objectKey)
    })
  )
  await writeManifest({
    ...manifest,
    slideshows: normalizeOrders(
      manifest.slideshows.filter(candidate => candidate.id !== deckId)
    )
  })
}

export async function reorderScenarioDecks(
  scenarioId: string,
  input: OrderInput
): Promise<RuntimeSlideshowDeck[]> {
  const manifest = await readManifest()
  const scenarioDecks = manifest.slideshows.filter(
    deck => deck.scenarioId === scenarioId
  )
  const ordered = reordered(scenarioDecks, input)
  const slideshows = manifest.slideshows.map(deck => {
    const replacement = ordered.find(candidate => candidate.id === deck.id)
    return replacement ?? deck
  })
  const written = await writeManifest({ ...manifest, slideshows })
  return toRuntimeDecks(written, true).filter(
    deck => deck.scenarioId === scenarioId
  )
}

export async function addSlide(
  deckId: string,
  file: File,
  title?: string
): Promise<SlideshowSlide> {
  const mediaType = mediaTypeFor(file.type)
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new AuthoringHttpError(400, 'file exceeds 50MB limit')
  }
  const manifest = await readManifest()
  const deck = deckOrThrow(manifest, deckId)
  const slideId = id('slide')
  const objectKey = `slideshows/${deckId}/${slideId}${extensionFor(file.type)}`
  if (!isSafeObjectKey(objectKey)) {
    throw new AuthoringHttpError(500, 'generated unsafe object key')
  }
  const slide: SlideshowSlide = {
    id: slideId,
    type: mediaType,
    objectKey,
    mimeType: file.type,
    title: cleanOptionalTitle(title) ?? cleanOptionalTitle(file.name),
    order: deck.slides.length,
    createdAt: nowIso()
  }
  await putObject({
    store: MEDIA_STORE,
    key: objectKey,
    data: file,
    contentType: file.type,
    metadata: { originalName: file.name, contentType: file.type }
  })
  await writeManifest({
    ...manifest,
    slideshows: manifest.slideshows.map(candidate =>
      candidate.id === deckId
        ? {
            ...candidate,
            slides: [...candidate.slides, slide],
            updatedAt: nowIso()
          }
        : candidate
    )
  })
  return slide
}

export async function patchSlide(
  deckId: string,
  slideId: string,
  input: PatchSlideInput
): Promise<SlideshowSlide> {
  const manifest = await readManifest()
  let updated: SlideshowSlide | null = null
  const slideshows = manifest.slideshows.map(deck => {
    if (deck.id !== deckId) return deck
    const slides = deck.slides.map(slide => {
      if (slide.id !== slideId) return slide
      updated = { ...slide, title: cleanOptionalTitle(input.title) }
      return updated
    })
    return { ...deck, slides, updatedAt: nowIso() }
  })
  if (updated == null) throw new AuthoringHttpError(404, 'slide not found')
  await writeManifest({ ...manifest, slideshows })
  return updated
}

export async function deleteSlide(
  deckId: string,
  slideId: string
): Promise<void> {
  const manifest = await readManifest()
  const deck = deckOrThrow(manifest, deckId)
  const slide = deck.slides.find(candidate => candidate.id === slideId)
  if (slide == null) throw new AuthoringHttpError(404, 'slide not found')
  await deleteObject(MEDIA_STORE, slide.objectKey)
  await writeManifest({
    ...manifest,
    slideshows: manifest.slideshows.map(candidate =>
      candidate.id === deckId
        ? {
            ...candidate,
            slides: normalizeOrders(
              candidate.slides.filter(
                candidateSlide => candidateSlide.id !== slideId
              )
            ),
            updatedAt: nowIso()
          }
        : candidate
    )
  })
}

export async function reorderSlides(
  deckId: string,
  input: OrderInput
): Promise<RuntimeSlideshowDeck> {
  const manifest = await readManifest()
  let updatedDeck: SlideshowDeck | null = null
  const slideshows = manifest.slideshows.map(deck => {
    if (deck.id !== deckId) return deck
    updatedDeck = {
      ...deck,
      slides: reordered(deck.slides, input),
      updatedAt: nowIso()
    }
    return updatedDeck
  })
  if (updatedDeck == null) {
    throw new AuthoringHttpError(404, 'slideshow not found')
  }
  await writeManifest({ ...manifest, slideshows })
  return toRuntimeDeck(updatedDeck)
}

export async function getMedia(objectKey: string): Promise<{
  data: Uint8Array
  contentType: string
} | null> {
  const normalizedKey = objectKey.replace(/^\/+/, '')
  if (!isSafeObjectKey(normalizedKey)) {
    throw new AuthoringHttpError(400, 'unsafe media key')
  }
  const object = await getObject(MEDIA_STORE, normalizedKey)
  if (object == null) return null
  return {
    data: object.data,
    contentType:
      object.contentType !== 'application/octet-stream'
        ? object.contentType
        : contentTypeFromExtension(normalizedKey)
  }
}

function contentTypeFromExtension(filename: string): string {
  const ext = path.extname(filename).toLowerCase()
  const map: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.avif': 'image/avif',
    '.mp4': 'video/mp4'
  }
  return map[ext] ?? 'application/octet-stream'
}
