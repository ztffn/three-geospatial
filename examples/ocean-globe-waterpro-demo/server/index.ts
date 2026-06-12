// Production HTTP server for the self-hosted "Humatopia World Twin" deploy
// (twin.humatopia.ai). Serves the built Vite SPA (dist/) with SPA fallback and
// answers the same same-origin MET proxy path the client uses in dev/Netlify
// (/.netlify/functions/met) by reusing fetchMergedForecast — no secret needed,
// only MET's mandated User-Agent. Replaces the Netlify Function on mediaserver.

import { createServer } from 'node:http'
import path from 'node:path'

import sirv from 'sirv'

import { fetchMergedForecast } from '../../../netlify/functions/_met-core'

const PORT = Number(process.env.PORT ?? 3000)
const HOST = process.env.HOST ?? '0.0.0.0'
const STATIC_DIR = process.env.STATIC_DIR ?? path.resolve(process.cwd(), 'dist')

// sirv serves the built assets; single:true falls unmatched routes back to
// index.html (SPA). The API routes below run first, so they are never reached
// by the fallback.
//
// Cache policy: hashed /assets/* are immutable (1y); everything else —
// crucially index.html and the SPA fallback — must revalidate on every load.
// Without no-cache on index.html, browsers heuristically cache it, and after
// a deploy returning visitors request the OLD hashed bundle → 404 → black
// screen until their cache expires.
const serveStatic = sirv(STATIC_DIR, {
  single: true,
  gzip: true,
  brotli: true,
  setHeaders: (res, pathname) => {
    if (pathname.startsWith('/assets/')) {
      res.setHeader('cache-control', 'public, max-age=31536000, immutable')
    } else {
      res.setHeader('cache-control', 'no-cache')
    }
  },
})

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')

  // Liveness probe — used by the compose healthcheck and the deploy script.
  if (url.pathname === '/health') {
    res.statusCode = 200
    res.setHeader('content-type', 'text/plain')
    res.end('ok')
    return
  }

  // Same-origin MET proxy. Identical contract to netlify/functions/met.mts so
  // the client (useMetForecast) hits one unchanged URL across dev/Netlify/self-
  // hosted. On upstream failure: 502 with the error — never fabricated data.
  if (url.pathname === '/.netlify/functions/met') {
    const lat = Number(url.searchParams.get('lat'))
    const lon = Number(url.searchParams.get('lon'))
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      res.statusCode = 400
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({ error: 'lat and lon query params are required numbers' })
      )
      return
    }
    fetchMergedForecast(lat, lon)
      .then(forecast => {
        const maxAge = Math.max(
          60,
          Math.round((Date.parse(forecast.expires) - Date.now()) / 1000)
        )
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.setHeader('cache-control', `public, max-age=${maxAge}`)
        res.end(JSON.stringify(forecast))
      })
      .catch((err: Error) => {
        res.statusCode = 502
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ error: err.message ?? 'MET fetch failed' }))
      })
    return
  }

  serveStatic(req, res, () => {
    res.statusCode = 404
    res.end('not found')
  })
})

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`[twin] serving ${STATIC_DIR} on http://${HOST}:${PORT}`)
})
