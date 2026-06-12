#!/usr/bin/env node
// Converts a "Dump view" camera dump (position/target ECEF JSON, pasted on
// stdin) into ready-to-paste scenarios.ts lines: an absolute FPS `spawn`, an
// anchor-relative `spawn` (with --preset/--anchor), and an orbit viewpoint
// (aim + distance + heading/pitch). Workflow: frame the shot in the running
// scene, click leva "Dump view", pipe the clipboard through this script.
//
// Usage:
//   pbpaste | node examples/ocean-globe-waterpro-demo/scripts/dump-to-spawn.mjs --preset Karmøy
//   node .../dump-to-spawn.mjs --anchor 5.206866,59.427348,20 < dump.json
//   node .../dump-to-spawn.mjs < dump.json            (absolute output only)
//
// The parser is lenient: a truncated paste works as long as the "position"
// and "target" arrays survive.

import { readFileSync } from 'node:fs'

// --- WGS84 ----------------------------------------------------------------
const A = 6378137
const F = 1 / 298.257223563
const E2 = F * (2 - F)
const deg = r => (r * 180) / Math.PI
const rad = d => (d * Math.PI) / 180

function geodeticToEcef(lonDeg, latDeg, h) {
  const lon = rad(lonDeg)
  const lat = rad(latDeg)
  const n = A / Math.sqrt(1 - E2 * Math.sin(lat) ** 2)
  return [
    (n + h) * Math.cos(lat) * Math.cos(lon),
    (n + h) * Math.cos(lat) * Math.sin(lon),
    (n * (1 - E2) + h) * Math.sin(lat)
  ]
}

function ecefToGeodetic([x, y, z]) {
  const lon = Math.atan2(y, x)
  const p = Math.hypot(x, y)
  let lat = Math.atan2(z, p * (1 - E2))
  let n = A
  let h = 0
  for (let i = 0; i < 10; i++) {
    n = A / Math.sqrt(1 - E2 * Math.sin(lat) ** 2)
    h = p / Math.cos(lat) - n
    lat = Math.atan2(z, p * (1 - (E2 * n) / (n + h)))
  }
  return { longitude: deg(lon), latitude: deg(lat), height: h }
}

// Local ENU basis at a geodetic point.
function enuBasis(lonDeg, latDeg) {
  const lon = rad(lonDeg)
  const lat = rad(latDeg)
  return {
    east: [-Math.sin(lon), Math.cos(lon), 0],
    north: [
      -Math.sin(lat) * Math.cos(lon),
      -Math.sin(lat) * Math.sin(lon),
      Math.cos(lat)
    ],
    up: [
      Math.cos(lat) * Math.cos(lon),
      Math.cos(lat) * Math.sin(lon),
      Math.sin(lat)
    ]
  }
}

const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2]
const sub = (u, v) => [u[0] - v[0], u[1] - v[1], u[2] - v[2]]
const len = u => Math.hypot(u[0], u[1], u[2])

// View direction → compass heading (0 = N, 90 = E) + elevation pitch
// (positive = looking up). Matches the FpsRig and viewpoint conventions.
function headingPitch(from, to, basis) {
  const v = sub(to, from)
  const l = len(v)
  const e = dot(v, basis.east) / l
  const n = dot(v, basis.north) / l
  const u = dot(v, basis.up) / l
  return {
    headingDeg: (deg(Math.atan2(e, n)) + 360) % 360,
    pitchDeg: deg(Math.asin(Math.max(-1, Math.min(1, u))))
  }
}

// --- presets (keep in sync with locationPresets in GlobeWaterproOcean-Story)
const PRESETS = {
  Tokyo: { longitude: 139.7671, latitude: 35.6812, height: 20 },
  Oslo: { longitude: 10.7522, latitude: 59.9139, height: 20 },
  Bergen: { longitude: 5.3221, latitude: 60.3913, height: 20 },
  'New York': { longitude: -74.006, latitude: 40.7128, height: 20 },
  'Cape Town': { longitude: 18.4241, latitude: -33.9249, height: 20 },
  Sydney: { longitude: 151.2093, latitude: -33.8688, height: 20 },
  Reykjavik: { longitude: -21.9426, latitude: 64.1466, height: 20 },
  Karmøy: { longitude: 5.206866, latitude: 59.427348, height: 20 },
  'Hywind Tampen': { longitude: 2.7, latitude: 61.329972, height: 20 },
  Zefyros: { longitude: 5.04, latitude: 59.16, height: 20 },
  'Bodø': { longitude: 14.25, latitude: 67.3, height: 20 },
  'Norwegian Sea': { longitude: 13.2, latitude: 67.5, height: 20 }
}

// --- args -------------------------------------------------------------------
let anchor = null
let anchorLabel = null
const args = process.argv.slice(2)
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--preset') {
    const name = args[++i]
    if (PRESETS[name] == null) {
      console.error(
        `Unknown preset '${name}'. Known: ${Object.keys(PRESETS).join(', ')}`
      )
      process.exit(1)
    }
    anchor = PRESETS[name]
    anchorLabel = name
  } else if (args[i] === '--anchor') {
    const [lon, lat, h = 20] = args[++i].split(',').map(Number)
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      console.error('--anchor expects lon,lat[,height]')
      process.exit(1)
    }
    anchor = { longitude: lon, latitude: lat, height: h }
    anchorLabel = `${lon},${lat},${h}`
  } else {
    console.error(`Unknown argument '${args[i]}' (use --preset or --anchor)`)
    process.exit(1)
  }
}

// --- lenient dump parse -------------------------------------------------------
const input = readFileSync(0, 'utf8')
function extractVec(name) {
  const m = input.match(
    new RegExp(`"${name}"\\s*:\\s*\\[([^\\]]+)\\]`)
  )
  if (m == null) return null
  const v = m[1].split(',').map(s => Number(s.trim()))
  return v.length === 3 && v.every(Number.isFinite) ? v : null
}
const position = extractVec('position')
const target = extractVec('target')
if (position == null) {
  console.error('No "position" array found in the dump.')
  process.exit(1)
}

const fmt = (v, digits = 1) => Number(v.toFixed(digits))
const posGeo = ecefToGeodetic(position)
const basisAtPos = enuBasis(posGeo.longitude, posGeo.latitude)
const view =
  target != null
    ? headingPitch(position, target, basisAtPos)
    : { headingDeg: 0, pitchDeg: 0 }
const hp = `headingDeg: ${fmt(view.headingDeg)}, pitchDeg: ${fmt(view.pitchDeg)}`

console.log('— FPS spawn (absolute) —')
console.log(
  `spawn: { longitude: ${fmt(posGeo.longitude, 6)}, latitude: ${fmt(posGeo.latitude, 6)}, height: ${fmt(posGeo.height)}, ${hp} }`
)

if (anchor != null) {
  const anchorEcef = geodeticToEcef(
    anchor.longitude,
    anchor.latitude,
    anchor.height
  )
  const basis = enuBasis(anchor.longitude, anchor.latitude)
  const toEnu = p => {
    const d = sub(p, anchorEcef)
    return [dot(d, basis.east), dot(d, basis.north), dot(d, basis.up)]
  }
  const off = toEnu(position)
  console.log(`\n— FPS spawn (offsetENU from '${anchorLabel}' anchor) —`)
  console.log(
    `spawn: { offsetENU: [${off.map(v => fmt(v)).join(', ')}], ${hp} }`
  )
  if (target != null) {
    const aim = toEnu(target)
    const distance = len(sub(position, target))
    console.log('\n— Orbit viewpoint (camera-only aim, same-site) —')
    console.log(
      `aimOffsetENU: [${aim.map(v => fmt(v)).join(', ')}], distance: ${fmt(distance)}, ${hp}`
    )
  }
}

if (target != null) {
  const aimGeo = ecefToGeodetic(target)
  const distance = len(sub(position, target))
  console.log('\n— Orbit viewpoint (absolute aim) —')
  console.log(
    `longitude: ${fmt(aimGeo.longitude, 6)}, latitude: ${fmt(aimGeo.latitude, 6)}, height: ${fmt(aimGeo.height)}, distance: ${fmt(distance)}, ${hp}`
  )
}
