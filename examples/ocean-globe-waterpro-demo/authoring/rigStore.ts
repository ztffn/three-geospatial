// Server-side store for authored @huma/path-creator RigDocuments: read-
// modify-write over the rigs.json manifest in the twin-authoring store,
// mirroring siteStore's lock/cache pattern. Documents are keyed by scenario
// id; validation delegates to the package (parse + buildRigRuntime cross-ref
// checks) so the schema stays owned by @huma/path-creator. Admin gate: api.ts.

import { buildRigRuntime, parseRigDocument } from '@huma/path-creator/core'

import { AuthoringHttpError } from './slideshowStore'
import { createMutationLock, getJson, nowIso, putJson } from './storage'
import { RIG_MANIFEST_VERSION, type StoredRigManifest } from './types'

const AUTHORING_STORE = 'twin-authoring'
const RIGS_KEY = 'rigs.json'
// A rig document is a handful of paths/carts/timelines of structured JSON;
// 1 MB is far above any legitimate document.
export const MAX_RIG_BYTES = 1 * 1024 * 1024

function emptyManifest(): StoredRigManifest {
  return {
    version: RIG_MANIFEST_VERSION,
    updatedAt: nowIso(),
    rigs: {}
  }
}

// In-memory cache; every mutation rebuilds the manifest immutably (see
// slideshowStore for the reasoning), so the cached object is never mutated.
let cachedManifest: StoredRigManifest | null = null

async function readManifest(): Promise<StoredRigManifest | null> {
  if (cachedManifest != null) return cachedManifest
  const raw = await getJson<StoredRigManifest>(AUTHORING_STORE, RIGS_KEY)
  if (
    raw?.version !== RIG_MANIFEST_VERSION ||
    raw.rigs == null ||
    typeof raw.rigs !== 'object' ||
    Array.isArray(raw.rigs)
  ) {
    return null
  }
  // Benign race: concurrent readers can only fill the cache with the same
  // freshly-read manifest; mutations are serialized by the manifest lock.
  // eslint-disable-next-line require-atomic-updates
  cachedManifest = raw
  return raw
}

async function writeManifest(
  manifest: StoredRigManifest
): Promise<StoredRigManifest> {
  const next: StoredRigManifest = { ...manifest, updatedAt: nowIso() }
  await putJson(AUTHORING_STORE, RIGS_KEY, next)
  cachedManifest = next
  return next
}

const withManifestLock = createMutationLock()

function bad(message: string): AuthoringHttpError {
  return new AuthoringHttpError(400, message)
}

// Full-document validation via the package itself: parseRigDocument checks
// the schema version, buildRigRuntime instantiates every path/cart/vcam/
// timeline and throws on dangling id references or malformed geometry. What
// the runtime accepts, the scene's driver can render — no parallel schema.
export function validateRigDocument(input: unknown): void {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    throw bad('rig document object is required')
  }
  try {
    buildRigRuntime(parseRigDocument(JSON.stringify(input)))
  } catch (err: unknown) {
    throw bad(err instanceof Error ? err.message : 'invalid rig document')
  }
}

// The authored manifest, or null when nothing has been saved yet.
export async function getRigManifest(): Promise<StoredRigManifest | null> {
  return await readManifest()
}

// Upsert one RigDocument by scenario id.
export async function putRig(
  scenarioId: string,
  input: unknown
): Promise<StoredRigManifest> {
  return await withManifestLock(async () => {
    if (scenarioId.trim().length === 0) throw bad('scenario id is required')
    validateRigDocument(input)
    // Backstop for a missing/understated Content-Length on the request that
    // carried this body — mirrors siteStore's putSite.
    if (Buffer.byteLength(JSON.stringify(input), 'utf-8') > MAX_RIG_BYTES) {
      throw bad('rig document exceeds 1MB limit')
    }
    const manifest = (await readManifest()) ?? emptyManifest()
    return await writeManifest({
      ...manifest,
      rigs: { ...manifest.rigs, [scenarioId]: input }
    })
  })
}
