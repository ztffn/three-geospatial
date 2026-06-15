// Regenerates storybook-webgpu/assets/subsea-cables.json from TWO sources:
//  - POWER: OpenStreetMap submarine power cables via the Overpass API (ODbL —
//    attribution baked in, share-alike on the derived data), fetched as two
//    bbox tiles (North Sea/Norway + the Arctic/Svalbard north strip) so the
//    single polar query never times out, then deduped by way id.
//  - TELECOM: TeleGeography submarinecablemap.com cable-geo.json (CC BY-NC-SA —
//    non-commercial use, fine for a non-profit, attribution baked in). Kept per
//    LineString that lies entirely inside the far-north window so the merged
//    geometry has no transatlantic/transpolar tails shooting off the frame.
// Run: `node scripts/parse-subsea-cables.mjs`. Source ≠ runtime: the app loads
// the committed compact JSON; this only rebuilds it. Output is flat per cable:
// { c:'power'|'telecom', v?:volts, n?:name, p:[lon,lat,...] }.

import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// Power bbox tiles [south, west, north, east]: the original overview extent plus
// the Norwegian Arctic / Barents / Svalbard strip. Deduped by way id on overlap.
const POWER_TILES = [
  [51, -3, 62, 13],
  [62, -8, 82, 35]
]
// TeleGeography is global; keep only telecom segments wholly inside this window.
const TELECOM_BBOX = [50, -15, 82, 40] // south, west, north, east
// Douglas-Peucker tolerance (degrees). Sub-pixel at the overview altitude; drops
// most of the dense source vertices so the fat cable lines stay cheap.
const SIMPLIFY_EPS = 0.01
const POWER_ATTRIBUTION = '© OpenStreetMap contributors (ODbL)'
const TELECOM_ATTRIBUTION = '© TeleGeography, submarinecablemap.com (CC BY-NC-SA)'
const TELECOM_URL =
  'https://www.submarinecablemap.com/api/v3/cable/cable-geo.json'
// Full-planet Overpass mirrors only (regional instances such as osm.ch silently
// return zero for the North Sea). They throttle aggressively; try each in turn
// with a browser UA (some reject the default agent).
const OVERPASS_ENDPOINTS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
]
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36'

async function overpass(query) {
  let lastErr
  for (const url of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        body: new URLSearchParams({ data: query })
      })
      if (!res.ok) throw new Error(`${url} → ${res.status}`)
      const json = await res.json()
      // Overpass signals a server-side timeout/error as HTTP 200 with a `remark`
      // and empty elements — treat that as a failure, never a silent zero.
      if (json.remark != null) throw new Error(`${url} remark: ${json.remark}`)
      return json.elements.filter(e => e.type === 'way' && e.geometry)
    } catch (err) {
      lastErr = err
      // eslint-disable-next-line no-console
      console.warn(`[overpass] ${url} failed, trying next…`, err.message)
    }
  }
  throw lastErr ?? new Error('all Overpass endpoints failed')
}

const firstInt = s => {
  const n = Number.parseInt(String(s ?? '').split(';')[0], 10)
  return Number.isFinite(n) ? n : null
}

// Douglas-Peucker polyline simplification on [lon,lat] (planar — fine at this
// scale for an overview visual). eps in degrees.
const perpDist = (p, a, b) => {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  if (dx === 0 && dy === 0) return Math.hypot(p[0] - a[0], p[1] - a[1])
  const t = Math.max(
    0,
    Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy))
  )
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
}
const simplify = (pts, eps) => {
  if (pts.length < 3) return pts
  let dmax = 0
  let idx = 0
  const a = pts[0]
  const b = pts[pts.length - 1]
  for (let i = 1; i < pts.length - 1; i++) {
    const d = perpDist(pts[i], a, b)
    if (d > dmax) {
      dmax = d
      idx = i
    }
  }
  if (dmax <= eps) return [a, b]
  return [
    ...simplify(pts.slice(0, idx + 1), eps).slice(0, -1),
    ...simplify(pts.slice(idx), eps)
  ]
}

// [lon,lat,…] flat array, DP-simplified and rounded to 5dp (~1 m).
const flatten = pts => {
  const out = []
  for (const [lon, lat] of simplify(pts, SIMPLIFY_EPS)) {
    out.push(Math.round(lon * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5)
  }
  return out
}

// One compact output record: category + flattened polyline, optional name/volts.
const makeRecord = (category, pts, name, volts) => {
  const rec = { c: category, p: flatten(pts) }
  if (name != null) rec.n = name
  if (volts != null) rec.v = volts
  return rec
}

const powerRecord = way =>
  makeRecord(
    'power',
    way.geometry.map(g => [g.lon, g.lat]),
    way.tags?.name ?? null,
    firstInt(way.tags?.voltage)
  )

const inside = (line, [s, w, n, e]) =>
  line.every(([lon, lat]) => lon >= w && lon <= e && lat >= s && lat <= n)

async function fetchPower() {
  const byId = new Map()
  for (const tile of POWER_TILES) {
    const b = tile.join(',')
    const query =
      `[out:json][timeout:180];(` +
      `way["power"="cable"]["location"="underwater"](${b});` +
      `way["power"="cable"]["submarine"="yes"](${b});` +
      `);out tags geom;`
    for (const way of await overpass(query)) byId.set(way.id, way)
  }
  return [...byId.values()]
}

async function fetchTelecom() {
  const res = await fetch(TELECOM_URL, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`TeleGeography → ${res.status}`)
  const fc = await res.json()
  const records = []
  for (const feature of fc.features) {
    const geom = feature.geometry
    if (geom?.type !== 'MultiLineString') continue
    const name = feature.properties?.name ?? null
    for (const line of geom.coordinates) {
      if (line.length < 2 || !inside(line, TELECOM_BBOX)) continue
      records.push(makeRecord('telecom', line, name, null))
    }
  }
  return records
}

async function main() {
  const power = await fetchPower()
  const powerRecords = power.map(powerRecord)
  const telecomRecords = await fetchTelecom()
  const cables = [...powerRecords, ...telecomRecords]
  const out = {
    attribution: `power: ${POWER_ATTRIBUTION} · telecom: ${TELECOM_ATTRIBUTION}`,
    source:
      `power: OpenStreetMap via Overpass, tiles ${POWER_TILES.map(t => t.join(',')).join(' + ')}` +
      ` · telecom: TeleGeography cable-geo.json, bbox ${TELECOM_BBOX.join(',')}` +
      ` · Douglas-Peucker eps ${SIMPLIFY_EPS}°`,
    bbox: [51, -15, 82, 40],
    counts: { power: powerRecords.length, telecom: telecomRecords.length },
    cables
  }
  const dst = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../storybook-webgpu/assets/subsea-cables.json'
  )
  await writeFile(dst, JSON.stringify(out))
  const verts = cables.reduce((s, c) => s + c.p.length / 2, 0)
  // eslint-disable-next-line no-console
  console.log(
    `wrote ${dst}\n  power: ${powerRecords.length}  telecom: ${telecomRecords.length}  vertices: ${verts}`
  )
}

void main()
