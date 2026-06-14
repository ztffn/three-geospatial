// Shared BarentsWatch AIS fetch for the digital-twin globe overview. Exchanges
// OAuth2 client-credentials for a token (cached until expiry), then serves two
// reads: latest vessel positions (split into the EU-sanctioned shadow fleet,
// matched by IMO, and Norwegian Coast Guard / Navy "patrol" vessels, matched by
// KV name prefix or military/law-enforcement ship type) and a single vessel's
// 24-hour historic track. Used by the Vite dev mirror and the self-hosted prod
// server so the browser hits one same-origin endpoint and the secret never
// reaches the bundle.

// Credentials are read from UNPREFIXED env vars (so Vite cannot inline them into
// the client build): BARENTSWATCH_CLIENT_ID / BARENTSWATCH_CLIENT_SECRET.
// Register a client at https://developer.barentswatch.no to obtain them.
const TOKEN_URL = 'https://id.barentswatch.no/connect/token'
const LATEST_URL =
  'https://live.ais.barentswatch.no/v1/latest/combined?modelType=Full&modelFormat=Json'
const TRACK_URL = (mmsi: number): string =>
  `https://historic.ais.barentswatch.no/v1/historic/trackslast24hours/${mmsi}`
const SCOPE = 'ais'

// One vessel's live position + kinematics, normalised from the BarentsWatch
// "Full" combined model. Nulls where AIS didn't supply the field — never faked.
export interface VesselPosition {
  // Stable key for React lists + selection: the IMO when broadcast, else
  // `mmsi:<n>`. Coast Guard vessels sometimes omit IMO, so it can't be the key.
  id: string
  imo: string | null
  mmsi: number | null
  name: string | null
  callSign: string | null
  latitude: number
  longitude: number
  speedOverGround: number | null // knots
  courseOverGround: number | null // deg
  trueHeading: number | null // deg
  rateOfTurn: number | null // deg/min (AIS ROT)
  navigationalStatus: number | null // AIS status code 0..15
  shipType: number | null // AIS ship-type code
  destination: string | null
  eta: string | null // AIS ETA (raw)
  draught: number | null // m
  shipLength: number | null // m
  shipWidth: number | null // m
  msgtime: string | null // ISO of the AIS fix
}

export interface AisPositions {
  updatedAt: string
  // Requested IMO set currently broadcasting in Norwegian waters. Empty array is
  // a valid answer (most shadow-fleet ships are dark or outside coverage).
  shadowFleet: VesselPosition[]
  // Norwegian Coast Guard / Navy vessels currently broadcasting. Identified from
  // the same payload by KV name prefix or military/law-enforcement ship type;
  // real warships often run AIS-dark, so this skews to Coast Guard.
  patrol: VesselPosition[]
}

// One point of a vessel's historic track. Static fields (name, IMO) are not
// included by the historic endpoint — only position + kinematics per fix.
export interface TrackPoint {
  latitude: number
  longitude: number
  msgtime: string | null
  courseOverGround: number | null
  speedOverGround: number | null
}

export interface VesselTrack {
  mmsi: number
  points: TrackPoint[] // chronological (oldest first)
}

let cachedToken: { value: string; expiresAt: number } | null = null

async function getToken(): Promise<string> {
  const clientId = process.env.BARENTSWATCH_CLIENT_ID
  const clientSecret = process.env.BARENTSWATCH_CLIENT_SECRET
  if (clientId == null || clientSecret == null) {
    throw new Error(
      'BarentsWatch credentials missing: set BARENTSWATCH_CLIENT_ID and BARENTSWATCH_CLIENT_SECRET'
    )
  }
  const now = Date.now()
  if (cachedToken != null && cachedToken.expiresAt > now + 30_000) {
    return cachedToken.value
  }
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: SCOPE
  })
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  })
  if (!res.ok) {
    throw new Error(`BarentsWatch token endpoint returned ${res.status}`)
  }
  const json = (await res.json()) as {
    access_token?: string
    expires_in?: number
  }
  if (json.access_token == null) {
    throw new Error('BarentsWatch token response had no access_token')
  }
  cachedToken = {
    value: json.access_token,
    expiresAt: now + (json.expires_in ?? 3600) * 1000
  }
  return cachedToken.value
}

const numOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

const strOrNull = (x: unknown): string | null =>
  typeof x === 'string' && x.trim() !== '' ? x.trim() : null

// Norwegian Coast Guard ("Kystvakt") vessels reliably broadcast a "KV " name
// prefix; AIS ship type 35 (military) / 55 (law enforcement) confirm but are
// frequently suppressed, so the name is the primary signal. MMSI ranges cover
// every Norwegian vessel and are too broad to classify on.
const isCoastGuard = (name: string | null, shipType: number | null): boolean =>
  (name != null && /^KV[\s-]/i.test(name)) || shipType === 35 || shipType === 55

// Normalise one raw BarentsWatch record to a VesselPosition, or null if it lacks
// a usable position or identity (can't be placed or selected).
function toVesselPosition(v: Record<string, unknown>): VesselPosition | null {
  const latitude = numOrNull(v.latitude)
  const longitude = numOrNull(v.longitude)
  if (latitude == null || longitude == null) return null
  const imoRaw = v.imoNumber ?? v.imo
  const imo =
    imoRaw != null && String(imoRaw) !== '0' ? String(imoRaw) : null
  const mmsi = numOrNull(v.mmsi)
  const id = imo ?? (mmsi != null ? `mmsi:${mmsi}` : null)
  if (id == null) return null
  // AIS transmits draught in decimetres (0..255 → 0..25.5 m). Normalise to m.
  const draughtRaw = numOrNull(v.draught)
  return {
    id,
    imo,
    mmsi,
    name: strOrNull(v.name),
    callSign: strOrNull(v.callSign),
    latitude,
    longitude,
    speedOverGround: numOrNull(v.speedOverGround),
    courseOverGround: numOrNull(v.courseOverGround),
    trueHeading: numOrNull(v.trueHeading),
    rateOfTurn: numOrNull(v.rateOfTurn),
    navigationalStatus: numOrNull(v.navigationalStatus),
    shipType: numOrNull(v.shipType),
    destination: strOrNull(v.destination),
    eta: strOrNull(v.eta),
    draught: draughtRaw != null ? draughtRaw / 10 : null,
    shipLength: numOrNull(v.shipLength),
    shipWidth: numOrNull(v.shipWidth),
    msgtime: strOrNull(v.msgtime)
  }
}

let loggedKeysOnce = false

export async function fetchAisPositions(imos: string[]): Promise<AisPositions> {
  const token = await getToken()
  const res = await fetch(LATEST_URL, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
  })
  if (!res.ok) {
    throw new Error(`BarentsWatch latest/combined returned ${res.status}`)
  }
  const raw = (await res.json()) as Array<Record<string, unknown>>
  // First successful payload: log the field names once so the normalisation
  // above can be verified against the live schema (not silently mis-mapped).
  if (!loggedKeysOnce && raw.length > 0) {
    loggedKeysOnce = true
    // eslint-disable-next-line no-console
    console.log('[ais] sample record keys:', Object.keys(raw[0]).join(', '))
  }
  // One pass over the whole payload (already downloaded): shadow fleet by IMO
  // membership, then Coast Guard / Navy by name/type. No extra API cost.
  const wanted = new Set(imos)
  const shadowFleet: VesselPosition[] = []
  const patrol: VesselPosition[] = []
  for (const v of raw) {
    const pos = toVesselPosition(v)
    if (pos == null) continue
    if (pos.imo != null && wanted.has(pos.imo)) shadowFleet.push(pos)
    else if (isCoastGuard(pos.name, pos.shipType)) patrol.push(pos)
  }
  return { updatedAt: new Date().toISOString(), shadowFleet, patrol }
}

// One vessel's last-24h track, keyed by MMSI (the historic endpoint's key).
// Same OAuth token + `ais` scope as the live feed. 14-day retention upstream;
// Norwegian EEZ + Svalbard coverage, excluding small fishing/leisure craft.
export async function fetchVesselTrack(mmsi: number): Promise<VesselTrack> {
  const token = await getToken()
  const res = await fetch(TRACK_URL(mmsi), {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
  })
  if (!res.ok) {
    throw new Error(`BarentsWatch historic track returned ${res.status}`)
  }
  const raw = (await res.json()) as Array<Record<string, unknown>>
  const points: TrackPoint[] = []
  for (const p of raw) {
    const latitude = numOrNull(p.latitude)
    const longitude = numOrNull(p.longitude)
    if (latitude == null || longitude == null) continue
    points.push({
      latitude,
      longitude,
      msgtime: strOrNull(p.msgtime),
      courseOverGround: numOrNull(p.courseOverGround),
      speedOverGround: numOrNull(p.speedOverGround)
    })
  }
  // Endpoint ordering isn't guaranteed; sort chronologically for a clean trail.
  points.sort((a, b) => (a.msgtime ?? '').localeCompare(b.msgtime ?? ''))
  return { mmsi, points }
}
