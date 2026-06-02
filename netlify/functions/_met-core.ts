// Shared MET Norway forecast fetch + merge logic for the digital-twin HUD.
// Fetches Locationforecast 2.0 (wind/air) and Oceanforecast 2.0 (wave/sea) for
// one point, merges their hourly time-series into a single sample array, and
// reports the soonest upstream `expires` for cache control. Used by both the
// Netlify function (production) and the Vite dev-server mirror (local) so the
// browser always hits one same-origin endpoint with no User-Agent/CORS issues.

// MET mandates a unique identifying User-Agent (403 without one) and bans
// generic agents (okhttp/Java/etc). This identifies the project + a contact.
const USER_AGENT =
  'humatopia-digital-twin/0.1 github.com/ZTIF (steffeno@gmail.com)'

const LOCATIONFORECAST =
  'https://api.met.no/weatherapi/locationforecast/2.0/complete'
const OCEANFORECAST = 'https://api.met.no/weatherapi/oceanforecast/2.0/complete'

// One merged sample at a single ISO hour. Fields are null when the relevant
// product has no value at that step (oceanforecast is sparser than location-
// forecast and only covers NW Europe). Never synthesised.
export interface MetSample {
  time: string // ISO8601, e.g. 2026-06-02T07:00:00Z
  windSpeed: number | null // m/s at 10 m
  windFromDirection: number | null // deg, meteorological (FROM)
  windGust: number | null // m/s
  airTemperature: number | null // °C
  airPressure: number | null // hPa
  cloudFraction: number | null // %
  relativeHumidity: number | null // %
  waveHeight: number | null // m, significant
  waveFromDirection: number | null // deg (FROM)
  seaTemperature: number | null // °C
  currentSpeed: number | null // m/s
  currentToDirection: number | null // deg (TO)
}

export interface MetForecast {
  latitude: number
  longitude: number
  updatedAt: string // ISO of when we fetched
  expires: string // ISO; soonest upstream expiry — clients refetch after this
  attribution: string
  series: MetSample[]
}

interface MetTimeStep {
  time: string
  data?: { instant?: { details?: Record<string, number> } }
}

async function fetchProduct(
  url: string,
  lat: number,
  lon: number
): Promise<{ steps: MetTimeStep[]; expires: string | null }> {
  const res = await fetch(`${url}?lat=${lat}&lon=${lon}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }
  })
  if (!res.ok) {
    throw new Error(`MET ${url} returned ${res.status}`)
  }
  const expires = res.headers.get('expires')
  const json = (await res.json()) as {
    properties?: { timeseries?: MetTimeStep[] }
  }
  return { steps: json.properties?.timeseries ?? [], expires }
}

const num = (
  details: Record<string, number> | undefined,
  key: string
): number | null => {
  const v = details?.[key]
  return typeof v === 'number' ? v : null
}

// Round lat/lon to 4 decimals (~11 m) — MET's TOS asks clients not to request
// excessive precision (it fragments their cache). 4 dp is plenty for a point.
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4

export async function fetchMergedForecast(
  latInput: number,
  lonInput: number
): Promise<MetForecast> {
  const lat = round4(latInput)
  const lon = round4(lonInput)

  const [weather, ocean] = await Promise.all([
    fetchProduct(LOCATIONFORECAST, lat, lon),
    // Oceanforecast only covers NW Europe; outside it MET 422s. Treat a failure
    // as "no wave data" rather than failing the whole request.
    fetchProduct(OCEANFORECAST, lat, lon).catch(() => ({
      steps: [] as MetTimeStep[],
      expires: null
    }))
  ])

  // Index ocean steps by ISO hour so we can join them onto the weather steps.
  const oceanByTime = new Map<string, Record<string, number> | undefined>()
  for (const step of ocean.steps) {
    oceanByTime.set(step.time, step.data?.instant?.details)
  }

  const series: MetSample[] = weather.steps.map(step => {
    const w = step.data?.instant?.details
    const o = oceanByTime.get(step.time)
    return {
      time: step.time,
      windSpeed: num(w, 'wind_speed'),
      windFromDirection: num(w, 'wind_from_direction'),
      windGust: num(w, 'wind_speed_of_gust'),
      airTemperature: num(w, 'air_temperature'),
      airPressure: num(w, 'air_pressure_at_sea_level'),
      cloudFraction: num(w, 'cloud_area_fraction'),
      relativeHumidity: num(w, 'relative_humidity'),
      waveHeight: num(o, 'sea_surface_wave_height'),
      waveFromDirection: num(o, 'sea_surface_wave_from_direction'),
      seaTemperature: num(o, 'sea_water_temperature'),
      currentSpeed: num(o, 'sea_water_speed'),
      currentToDirection: num(o, 'sea_water_to_direction')
    }
  })

  // Soonest upstream expiry drives client refetch. Fall back to +30 min from
  // now (MET's typical cadence) if neither product sent an Expires header.
  const now = Date.now()
  const expiryCandidates = [weather.expires, ocean.expires]
    .map(e => (e != null ? Date.parse(e) : NaN))
    .filter(t => Number.isFinite(t)) as number[]
  const expiresMs =
    expiryCandidates.length > 0
      ? Math.min(...expiryCandidates)
      : now + 30 * 60 * 1000

  return {
    latitude: lat,
    longitude: lon,
    updatedAt: new Date(now).toISOString(),
    expires: new Date(expiresMs).toISOString(),
    attribution: 'Weather & ocean data: MET Norway (CC BY 4.0)',
    series
  }
}
