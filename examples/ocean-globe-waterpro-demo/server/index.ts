// Production HTTP server for the self-hosted "Humatopia World Twin" deploy
// (twin.humatopia.ai). Serves the built Vite SPA (dist/) with SPA fallback and
// answers the same same-origin MET proxy path the client uses in dev/Netlify
// (/.netlify/functions/met) by reusing fetchMergedForecast — no secret needed,
// only MET's mandated User-Agent. Replaces the Netlify Function on mediaserver.

import { createServer, type ServerResponse } from 'node:http'
import path from 'node:path'

import sirv from 'sirv'

import { fetchMergedForecast } from '../../../netlify/functions/_met-core'
import {
  fetchAisPositions,
  fetchVesselTrack
} from '../../../netlify/functions/_ais-core'
import { SHADOW_FLEET } from '../ui/shadowFleet'

const SHADOW_FLEET_IMOS = SHADOW_FLEET.map(v => v.imo)

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

// Write a JSON response with an optional cache-control header.
function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  cacheControl?: string
): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  if (cacheControl != null) res.setHeader('cache-control', cacheControl)
  res.end(JSON.stringify(body))
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')

  // Liveness probe — used by the compose healthcheck and the deploy script.
  if (url.pathname === '/health') {
    res.statusCode = 200
    res.setHeader('content-type', 'text/plain')
    res.end('ok')
    return
  }

  // Same-origin MET proxy. One unchanged URL across dev + self-hosted. On
  // upstream failure: 502 with the error — never fabricated data.
  if (url.pathname === '/.netlify/functions/met') {
    const lat = Number(url.searchParams.get('lat'))
    const lon = Number(url.searchParams.get('lon'))
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      sendJson(res, 400, {
        error: 'lat and lon query params are required numbers'
      })
      return
    }
    fetchMergedForecast(lat, lon)
      .then(forecast => {
        const maxAge = Math.max(
          60,
          Math.round((Date.parse(forecast.expires) - Date.now()) / 1000)
        )
        sendJson(res, 200, forecast, `public, max-age=${maxAge}`)
      })
      .catch((err: Error) =>
        sendJson(res, 502, { error: err.message ?? 'MET fetch failed' })
      )
    return
  }

  // Same-origin BarentsWatch AIS proxy: live positions split into the sanctioned
  // shadow fleet (by IMO) and Coast Guard / Navy patrol vessels (by name/type),
  // all currently in Norwegian waters. Secret stays server-side. 503 (not
  // fabricated data) when credentials are unset.
  if (url.pathname === '/.netlify/functions/ais-shadow-fleet') {
    fetchAisPositions(SHADOW_FLEET_IMOS)
      .then(data => sendJson(res, 200, data, 'public, max-age=30'))
      .catch((err: Error) =>
        sendJson(res, 503, { error: err.message ?? 'AIS fetch failed' })
      )
    return
  }

  // One vessel's last-24h historic track, keyed by MMSI (?mmsi=). Fetched on
  // demand when a vessel is selected. 400 on a missing/invalid MMSI.
  if (url.pathname === '/.netlify/functions/ais-track') {
    const mmsi = Number(url.searchParams.get('mmsi'))
    if (!Number.isFinite(mmsi) || mmsi <= 0) {
      sendJson(res, 400, { error: 'missing or invalid mmsi' })
      return
    }
    fetchVesselTrack(mmsi)
      .then(data => sendJson(res, 200, data, 'public, max-age=60'))
      .catch((err: Error) =>
        sendJson(res, 503, { error: err.message ?? 'track fetch failed' })
      )
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
