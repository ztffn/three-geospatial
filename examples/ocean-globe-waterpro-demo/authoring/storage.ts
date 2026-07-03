// Filesystem-backed object store for the authoring feature: a put/get/delete
// (+ JSON variants) keyed by (store, key) under a configurable root
// (TWIN_STORAGE_ROOT). Guards every key against path traversal (isSafeObjectKey
// / assertSafePart) so a malicious key can't escape the store root. The
// slideshow manifest and uploaded media both persist through this layer.

import fs from 'node:fs/promises'
import path from 'node:path'

export interface ObjectMetadata {
  contentType?: string
  originalName?: string
}

export interface PutObjectInput {
  store: string
  key: string
  data: ArrayBuffer | Uint8Array | Buffer | Blob | string
  contentType?: string
  metadata?: ObjectMetadata
}

export interface GetObjectResult {
  data: Uint8Array
  contentType: string
  metadata: ObjectMetadata
}

// Dev and self-hosted runtime both write under the process cwd by default.
// Production deploys should set TWIN_STORAGE_ROOT to a mounted volume path.
const DEFAULT_ROOT = path.resolve(process.cwd(), '.local/authoring')

const configuredRoot = process.env.TWIN_STORAGE_ROOT?.trim()
const STORAGE_ROOT =
  configuredRoot != null && configuredRoot.length > 0
    ? configuredRoot
    : DEFAULT_ROOT

async function toBuffer(
  data: ArrayBuffer | Uint8Array | Buffer | Blob | string
): Promise<Buffer> {
  if (typeof data === 'string') return Buffer.from(data, 'utf-8')
  if (Buffer.isBuffer(data)) return data
  if (data instanceof Uint8Array) return Buffer.from(data)
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return Buffer.from(await data.arrayBuffer())
  }
  throw new TypeError('[authoring-storage] unsupported data type')
}

function assertSafePart(value: string, label: string): void {
  if (value.length === 0) throw new Error(`${label} is empty`)
  if (value.startsWith('/') || value.includes('..') || value.includes('//')) {
    throw new Error(`${label} contains an unsafe path segment`)
  }
}

export function isSafeObjectKey(key: string): boolean {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,1022}[A-Za-z0-9])?$/.test(key)) {
    return false
  }
  return !key.includes('..') && !key.includes('//')
}

function filePath(store: string, key: string): string {
  assertSafePart(store, 'store')
  assertSafePart(key, 'key')
  if (!isSafeObjectKey(key)) throw new Error('unsafe object key')
  return path.join(STORAGE_ROOT, store, key)
}

function metaPath(store: string, key: string): string {
  return `${filePath(store, key)}.meta.json`
}

export async function putObject(input: PutObjectInput): Promise<void> {
  const { store, key, data, contentType, metadata } = input
  const target = filePath(store, key)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, await toBuffer(data))
  await fs.writeFile(
    metaPath(store, key),
    JSON.stringify({
      contentType: contentType ?? 'application/octet-stream',
      metadata: metadata ?? {}
    })
  )
}

export async function getObject(
  store: string,
  key: string
): Promise<GetObjectResult | null> {
  try {
    const data = await fs.readFile(filePath(store, key))
    let contentType = 'application/octet-stream'
    let metadata: ObjectMetadata = {}
    try {
      const raw = await fs.readFile(metaPath(store, key), 'utf-8')
      const parsed = JSON.parse(raw) as {
        contentType?: string
        metadata?: ObjectMetadata
      }
      contentType = parsed.contentType ?? contentType
      metadata = parsed.metadata ?? metadata
    } catch {
      // Missing sidecars are tolerated so existing objects remain readable.
    }
    return { data: new Uint8Array(data), contentType, metadata }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

export async function deleteObject(store: string, key: string): Promise<void> {
  await Promise.allSettled([
    fs.unlink(filePath(store, key)),
    fs.unlink(metaPath(store, key))
  ])
}

export async function putJson(
  store: string,
  key: string,
  value: unknown
): Promise<void> {
  await putObject({
    store,
    key,
    data: `${JSON.stringify(value, null, 2)}\n`,
    contentType: 'application/json; charset=utf-8'
  })
}

export async function getJson<T>(
  store: string,
  key: string
): Promise<T | null> {
  const object = await getObject(store, key)
  if (object == null) return null
  return JSON.parse(Buffer.from(object.data).toString('utf-8')) as T
}
