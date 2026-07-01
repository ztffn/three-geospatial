import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  addSlide,
  AuthoringHttpError,
  createDeck,
  deleteDeck,
  deleteSlide,
  getMedia,
  getRuntimeManifest,
  getScenarioSlideshows,
  patchDeck,
  patchSlide,
  reorderScenarioDecks,
  reorderSlides
} from './slideshowStore'
import type {
  CreateDeckInput,
  OrderInput,
  PatchDeckInput,
  PatchSlideInput
} from './types'

const API_PREFIX = '/api/authoring'

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

function requireAdmin(req: IncomingMessage, res: ServerResponse): boolean {
  const token = process.env.TWIN_ADMIN_TOKEN?.trim()
  if (token == null || token.length === 0) {
    if (process.env.NODE_ENV === 'production') {
      sendJson(res, 503, { error: 'admin mutations are not configured' })
      return false
    }
    return true
  }

  const auth = req.headers.authorization ?? ''
  if (auth !== `Bearer ${token}`) {
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

function includeDisabled(url: URL): boolean {
  return url.searchParams.get('includeDisabled') === '1'
}

async function routeAuthoringRequest(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const parts = pathParts(url.pathname)
  const reqMethod = method(req)

  if (reqMethod === 'GET' && parts[0] === 'manifest' && parts.length === 1) {
    sendJson(res, 200, {
      slideshows: await getRuntimeManifest(includeDisabled(url))
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
      slideshows: await getScenarioSlideshows(parts[1], includeDisabled(url))
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
