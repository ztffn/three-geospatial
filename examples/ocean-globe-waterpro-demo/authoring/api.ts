// HTTP routing for the authoring API (mounted under /api/authoring by both the
// prod server and the dev Vite plugin): slideshow deck/slide CRUD + media, and
// the authored site manifest (GET public, PUT admin). Owns request parsing,
// the admin-cookie session (HMAC of TWIN_ADMIN_TOKEN, timing-safe compare) and
// the requireAdmin gate on every mutation; persistence lives in slideshowStore
// and siteStore. Public GETs strip admin-only concerns (disabled decks).

import { createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  addCodeSlide,
  addSlide,
  AuthoringHttpError,
  createDeck,
  deleteDeck,
  deleteSlide,
  getMedia,
  getRuntimeManifest,
  getScenarioSlideshows,
  MAX_CODE_BYTES,
  MAX_UPLOAD_BYTES,
  patchDeck,
  patchSlide,
  reorderScenarioDecks,
  reorderSlides
} from './slideshowStore'
import { getSiteManifest, MAX_SITE_BYTES, putSite } from './siteStore'
import type {
  AddCodeSlideInput,
  CreateDeckInput,
  OrderInput,
  PatchDeckInput,
  PatchSlideInput
} from './types'

const API_PREFIX = '/api/authoring'
const ADMIN_COOKIE = 'twin_authoring_admin'
const ADMIN_COOKIE_MAX_AGE = 7 * 24 * 60 * 60

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  cacheControl = 'no-store'
): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.setHeader('cache-control', cacheControl)
  res.end(JSON.stringify(body))
}

function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof AuthoringHttpError) {
    sendJson(res, err.status, { error: err.message })
    return
  }
  const message =
    err instanceof Error ? err.message : 'authoring request failed'
  sendJson(res, 500, { error: message })
}

function adminToken(): string | null {
  const token = process.env.TWIN_ADMIN_TOKEN?.trim()
  return token != null && token.length > 0 ? token : null
}

function adminCookieValue(token: string): string {
  return createHmac('sha256', token)
    .update('twin-authoring-admin-v1')
    .digest('base64url')
}

function cookieValue(req: IncomingMessage, name: string): string | null {
  const raw = req.headers.cookie
  if (raw == null) return null
  for (const part of raw.split(';')) {
    const [key, ...valueParts] = part.trim().split('=')
    if (key === name) return valueParts.join('=')
  }
  return null
}

function sameValue(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

function hasAdminSession(req: IncomingMessage): boolean {
  const token = adminToken()
  if (token == null) return process.env.NODE_ENV !== 'production'
  const value = cookieValue(req, ADMIN_COOKIE)
  return value != null && sameValue(value, adminCookieValue(token))
}

function adminCookieHeader(value: string, maxAge: number): string {
  return [
    `${ADMIN_COOKIE}=${value}`,
    'Path=/api/authoring',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
    ...(process.env.NODE_ENV === 'production' ? ['Secure'] : [])
  ].join('; ')
}

function requireAdmin(req: IncomingMessage, res: ServerResponse): boolean {
  const token = adminToken()
  if (token == null) {
    if (process.env.NODE_ENV === 'production') {
      sendJson(res, 503, { error: 'admin mutations are not configured' })
      return false
    }
    return true
  }

  if (!hasAdminSession(req)) {
    sendJson(res, 401, { error: 'admin token required' })
    return false
  }
  return true
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    )
  }
  return Buffer.concat(chunks)
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const body = await readBody(req)
  const parsed: T = body.length === 0 ? {} : JSON.parse(body.toString('utf-8'))
  return parsed
}

async function readFormData(req: IncomingMessage): Promise<FormData> {
  const init: RequestInit & { duplex: 'half' } = {
    method: req.method,
    headers: requestHeaders(req),
    body: req as unknown as BodyInit,
    duplex: 'half'
  }
  const request = new Request(`http://localhost${req.url ?? '/'}`, init)
  return await request.formData()
}

function requestHeaders(req: IncomingMessage): Headers {
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value == null) continue
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item)
    } else {
      headers.set(key, value)
    }
  }
  return headers
}

function method(req: IncomingMessage): string {
  return (req.method ?? 'GET').toUpperCase()
}

function pathParts(pathname: string): string[] {
  return pathname
    .slice(API_PREFIX.length)
    .split('/')
    .filter(part => part.length > 0)
    .map(part => decodeURIComponent(part))
}

// Disabled/draft decks are admin-only. Honor ?includeDisabled=1 only for an
// authenticated admin session — otherwise an anonymous caller could enumerate
// unpublished decks (and their media URLs) by appending the flag.
function includeDisabled(url: URL, req: IncomingMessage): boolean {
  return url.searchParams.get('includeDisabled') === '1' && hasAdminSession(req)
}

async function routeAuthoringRequest(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const parts = pathParts(url.pathname)
  const reqMethod = method(req)

  if (parts[0] === 'admin' && parts[1] === 'session' && parts.length === 2) {
    if (reqMethod === 'GET') {
      sendJson(res, 200, { ok: hasAdminSession(req) })
      return
    }
    if (reqMethod === 'POST') {
      const configuredToken = adminToken()
      if (configuredToken == null) {
        if (process.env.NODE_ENV === 'production') {
          sendJson(res, 503, { error: 'admin mutations are not configured' })
        } else {
          sendJson(res, 200, { ok: true })
        }
        return
      }
      const body = await readJson<{ token?: unknown }>(req)
      if (
        typeof body.token !== 'string' ||
        !sameValue(body.token, configuredToken)
      ) {
        sendJson(res, 401, { error: 'invalid admin token' })
        return
      }
      res.setHeader(
        'set-cookie',
        adminCookieHeader(
          adminCookieValue(configuredToken),
          ADMIN_COOKIE_MAX_AGE
        )
      )
      sendJson(res, 200, { ok: true })
      return
    }
    if (reqMethod === 'DELETE') {
      res.setHeader('set-cookie', adminCookieHeader('', 0))
      sendJson(res, 200, { ok: true })
      return
    }
    sendJson(res, 405, { error: 'method not allowed' })
    return
  }

  // Authored site manifest. GET is public and returns only what has been
  // authored (committed seeds stay client-side; the client merges them),
  // minus any draft (enabled: false) scenarios unless an authenticated admin
  // session asks for them via ?includeDisabled=1. PUT upserts one validated
  // SiteDefinition and is admin-gated.
  if (parts[0] === 'sites' && parts.length === 1) {
    if (reqMethod !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }
    const manifest = await getSiteManifest(includeDisabled(url, req))
    sendJson(res, 200, {
      sites: manifest?.sites ?? [],
      updatedAt: manifest?.updatedAt ?? null
    })
    return
  }

  if (parts[0] === 'sites' && parts.length === 2) {
    if (reqMethod !== 'PUT') {
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }
    if (!requireAdmin(req, res)) return
    const declaredLength = Number(req.headers['content-length'])
    if (Number.isFinite(declaredLength) && declaredLength > MAX_SITE_BYTES) {
      sendJson(res, 413, { error: 'site definition exceeds 2MB limit' })
      return
    }
    const manifest = await putSite(parts[1], await readJson<unknown>(req))
    sendJson(res, 200, {
      site: manifest.sites.find(site => site.id === parts[1]),
      updatedAt: manifest.updatedAt
    })
    return
  }

  if (reqMethod === 'GET' && parts[0] === 'manifest' && parts.length === 1) {
    sendJson(res, 200, {
      slideshows: await getRuntimeManifest(includeDisabled(url, req))
    })
    return
  }

  if (reqMethod === 'GET' && parts[0] === 'media' && parts.length === 2) {
    const media = await getMedia(parts[1])
    if (media == null) {
      res.statusCode = 404
      res.end('not found')
      return
    }
    res.statusCode = 200
    res.setHeader('content-type', media.contentType)
    res.setHeader('cache-control', 'public, max-age=31536000, immutable')
    res.end(Buffer.from(media.data))
    return
  }

  if (
    parts[0] === 'scenarios' &&
    parts[2] === 'slideshows' &&
    parts.length === 3
  ) {
    if (reqMethod !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }
    sendJson(res, 200, {
      slideshows: await getScenarioSlideshows(
        parts[1],
        includeDisabled(url, req)
      )
    })
    return
  }

  if (
    parts[0] === 'scenarios' &&
    parts[2] === 'slideshow-order' &&
    parts.length === 3
  ) {
    if (reqMethod !== 'PATCH') {
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }
    if (!requireAdmin(req, res)) return
    sendJson(res, 200, {
      slideshows: await reorderScenarioDecks(
        parts[1],
        await readJson<OrderInput>(req)
      )
    })
    return
  }

  if (parts[0] === 'slideshows' && parts.length === 1) {
    if (reqMethod !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }
    if (!requireAdmin(req, res)) return
    sendJson(res, 200, {
      deck: await createDeck(await readJson<CreateDeckInput>(req))
    })
    return
  }

  if (parts[0] === 'slideshows' && parts.length === 2) {
    if (!requireAdmin(req, res)) return
    if (reqMethod === 'PATCH') {
      sendJson(res, 200, {
        deck: await patchDeck(parts[1], await readJson<PatchDeckInput>(req))
      })
      return
    }
    if (reqMethod === 'DELETE') {
      await deleteDeck(parts[1])
      sendJson(res, 200, { ok: true })
      return
    }
    sendJson(res, 405, { error: 'method not allowed' })
    return
  }

  if (
    parts[0] === 'slideshows' &&
    parts[2] === 'slide-order' &&
    parts.length === 3
  ) {
    if (reqMethod !== 'PATCH') {
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }
    if (!requireAdmin(req, res)) return
    sendJson(res, 200, {
      deck: await reorderSlides(parts[1], await readJson<OrderInput>(req))
    })
    return
  }

  if (
    parts[0] === 'slideshows' &&
    parts[2] === 'slides' &&
    parts.length === 3
  ) {
    if (reqMethod !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }
    if (!requireAdmin(req, res)) return
    // 'html'/'jsx' slides carry no file — the author posts JSON with a `code`
    // string, stored inline in the manifest (see addCodeSlide). Everything
    // else is the existing multipart file upload.
    const contentType = req.headers['content-type'] ?? ''
    if (contentType.startsWith('application/json')) {
      // Same reasoning as the multipart branch below: reject on the declared
      // Content-Length before buffering the body. addCodeSlide's byte check
      // remains a backstop for a missing/understated header.
      const declaredCodeLength = Number(req.headers['content-length'])
      if (
        Number.isFinite(declaredCodeLength) &&
        declaredCodeLength > MAX_CODE_BYTES
      ) {
        sendJson(res, 413, { error: 'code exceeds 200KB limit' })
        return
      }
      sendJson(res, 200, {
        slide: await addCodeSlide(parts[1], await readJson<AddCodeSlideInput>(req))
      })
      return
    }
    // Reject oversized uploads on the declared Content-Length before
    // request.formData() buffers the whole body into memory. The store-side
    // file.size check remains a backstop for a missing/understated header.
    const declaredLength = Number(req.headers['content-length'])
    if (Number.isFinite(declaredLength) && declaredLength > MAX_UPLOAD_BYTES) {
      sendJson(res, 413, { error: 'file exceeds 50MB limit' })
      return
    }
    const formData = await readFormData(req)
    const file = formData.get('file')
    if (!(file instanceof File)) {
      sendJson(res, 400, { error: 'file is required' })
      return
    }
    const title = formData.get('title')
    sendJson(res, 200, {
      slide: await addSlide(
        parts[1],
        file,
        typeof title === 'string' ? title : undefined
      )
    })
    return
  }

  if (
    parts[0] === 'slideshows' &&
    parts[2] === 'slides' &&
    parts.length === 4
  ) {
    if (!requireAdmin(req, res)) return
    if (reqMethod === 'PATCH') {
      sendJson(res, 200, {
        slide: await patchSlide(
          parts[1],
          parts[3],
          await readJson<PatchSlideInput>(req)
        )
      })
      return
    }
    if (reqMethod === 'DELETE') {
      await deleteSlide(parts[1], parts[3])
      sendJson(res, 200, { ok: true })
      return
    }
    sendJson(res, 405, { error: 'method not allowed' })
    return
  }

  sendJson(res, 404, { error: 'not found' })
}

export function handleAuthoringRequest(
  req: IncomingMessage,
  res: ServerResponse
): boolean {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (!url.pathname.startsWith(`${API_PREFIX}/`)) return false
  routeAuthoringRequest(req, res).catch((err: unknown) => {
    sendError(res, err)
  })
  return true
}
