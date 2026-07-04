// Server-side store for authored SiteDefinitions: read-modify-write over the
// sites.json manifest in the twin-authoring store, mirroring slideshowStore's
// lock/cache pattern. Reads return the raw authored manifest (committed seeds
// stay client-side and are merged there); writes structurally validate the
// incoming SiteDefinition and upsert it by id. Admin gating happens in api.ts.

import type {
  SiteAnchor,
  SiteDefinition,
  SiteTransform
} from '../sites/types'
import { createMutationLock, getJson, nowIso, putJson } from './storage'
import { AuthoringHttpError } from './slideshowStore'
import {
  SITE_MANIFEST_VERSION,
  type StoredSiteManifest
} from './types'

const AUTHORING_STORE = 'twin-authoring'
const SITES_KEY = 'sites.json'
// Serialized SiteDefinitions are small structured JSON; 2 MB is far above any
// legitimate site and bounds what an admin session can persist per request.
export const MAX_SITE_BYTES = 2 * 1024 * 1024

function emptyManifest(): StoredSiteManifest {
  return {
    version: SITE_MANIFEST_VERSION,
    updatedAt: nowIso(),
    sites: []
  }
}

// In-memory cache; every mutation rebuilds the manifest immutably (see
// slideshowStore for the reasoning), so the cached object is never mutated.
let cachedManifest: StoredSiteManifest | null = null

async function readManifest(): Promise<StoredSiteManifest | null> {
  if (cachedManifest != null) return cachedManifest
  const raw = await getJson<StoredSiteManifest>(AUTHORING_STORE, SITES_KEY)
  if (raw?.version !== SITE_MANIFEST_VERSION || !Array.isArray(raw.sites)) {
    return null
  }
  cachedManifest = raw
  return raw
}

async function writeManifest(
  manifest: StoredSiteManifest
): Promise<StoredSiteManifest> {
  const next: StoredSiteManifest = { ...manifest, updatedAt: nowIso() }
  await putJson(AUTHORING_STORE, SITES_KEY, next)
  cachedManifest = next
  return next
}

const withManifestLock = createMutationLock()

function bad(message: string): AuthoringHttpError {
  return new AuthoringHttpError(400, message)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isVec3(value: unknown): value is [number, number, number] {
  return (
    Array.isArray(value) && value.length === 3 && value.every(isFiniteNumber)
  )
}

function validateAnchor(anchor: unknown): asserts anchor is SiteAnchor {
  const a = anchor as SiteAnchor | null
  if (a == null || typeof a !== 'object') throw bad('anchor is required')
  if (!isFiniteNumber(a.longitude) || a.longitude < -180 || a.longitude > 180) {
    throw bad('anchor.longitude must be a number in [-180, 180]')
  }
  if (!isFiniteNumber(a.latitude) || a.latitude < -90 || a.latitude > 90) {
    throw bad('anchor.latitude must be a number in [-90, 90]')
  }
  if (a.height != null && !isFiniteNumber(a.height)) {
    throw bad('anchor.height must be a number')
  }
  if (a.frame !== 'wgs84-enu') throw bad("anchor.frame must be 'wgs84-enu'")
}

function validateTransform(
  transform: unknown,
  where: string
): asserts transform is SiteTransform {
  const t = transform as SiteTransform | null
  if (t == null || typeof t !== 'object') {
    throw bad(`${where}: transform is required`)
  }
  if (!isVec3(t.positionENU)) {
    throw bad(`${where}: transform.positionENU must be [east, north, up]`)
  }
}

function requireId(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw bad(`${where}: id is required`)
  }
  return value
}

// Structural validation of an incoming SiteDefinition: ids/labels present,
// anchor sane, layers carry a type + transform, scenario viewpoints carry a
// targetENU. Deliberately shape-level (no deep semantic checks) — the schema
// is young; this catches malformed payloads, not bad authoring.
export function validateSiteDefinition(
  input: unknown
): asserts input is SiteDefinition {
  const site = input as SiteDefinition | null
  if (site == null || typeof site !== 'object') {
    throw bad('site definition object is required')
  }
  requireId(site.id, 'site')
  if (typeof site.label !== 'string' || site.label.trim().length === 0) {
    throw bad('site.label is required')
  }
  validateAnchor(site.anchor)
  if (!Array.isArray(site.layers)) throw bad('site.layers must be an array')
  for (const layer of site.layers) {
    const id = requireId((layer as { id?: unknown }).id, 'layer')
    if (typeof (layer as { type?: unknown }).type !== 'string') {
      throw bad(`layer '${id}': type is required`)
    }
    validateTransform((layer as { transform?: unknown }).transform, `layer '${id}'`)
  }
  if (!Array.isArray(site.scenarios)) {
    throw bad('site.scenarios must be an array')
  }
  for (const scenario of site.scenarios) {
    const id = requireId((scenario as { id?: unknown }).id, 'scenario')
    if (!Array.isArray(scenario.viewpoints)) {
      throw bad(`scenario '${id}': viewpoints must be an array`)
    }
    for (const viewpoint of scenario.viewpoints) {
      const vpId = requireId(
        (viewpoint as { id?: unknown }).id,
        `scenario '${id}' viewpoint`
      )
      if (!isVec3(viewpoint.targetENU)) {
        throw bad(
          `scenario '${id}' viewpoint '${vpId}': targetENU must be [east, north, up]`
        )
      }
    }
  }
  if (!Array.isArray(site.annotations)) {
    throw bad('site.annotations must be an array')
  }
  for (const annotation of site.annotations) {
    const id = requireId((annotation as { id?: unknown }).id, 'annotation')
    if (!isVec3(annotation.positionENU)) {
      throw bad(`annotation '${id}': positionENU must be [east, north, up]`)
    }
  }
}

// The authored manifest, or null when nothing has been saved yet.
export async function getSiteManifest(): Promise<StoredSiteManifest | null> {
  return await readManifest()
}

// Upsert one SiteDefinition by id. The URL id must match the body id so a
// misdirected PUT can't silently overwrite a different site.
export async function putSite(
  siteId: string,
  input: unknown
): Promise<StoredSiteManifest> {
  return withManifestLock(async () => {
    validateSiteDefinition(input)
    if (input.id !== siteId) {
      throw bad(`body id '${input.id}' does not match route id '${siteId}'`)
    }
    const manifest = (await readManifest()) ?? emptyManifest()
    const existing = manifest.sites.findIndex(site => site.id === siteId)
    const sites =
      existing >= 0
        ? manifest.sites.map(site => (site.id === siteId ? input : site))
        : [...manifest.sites, input]
    return await writeManifest({ ...manifest, sites })
  })
}
