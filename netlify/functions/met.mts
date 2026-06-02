// Netlify Function: same-origin MET Norway forecast proxy for the digital twin.
// Browsers can't set the MET-mandated User-Agent and would hit CORS/IP limits;
// this server-side function sets the UA, merges the two MET products via
// _met-core, and forwards upstream cache lifetime to the CDN. On upstream
// failure it returns 502 with the error — never fabricated data (no-mock rule).

import { fetchMergedForecast } from './_met-core'

export default async (req: Request): Promise<Response> => {
  const url = new URL(req.url)
  const lat = Number(url.searchParams.get('lat'))
  const lon = Number(url.searchParams.get('lon'))

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return new Response(
      JSON.stringify({ error: 'lat and lon query params are required numbers' }),
      { status: 400, headers: { 'content-type': 'application/json' } }
    )
  }

  try {
    const forecast = await fetchMergedForecast(lat, lon)
    const maxAge = Math.max(
      60,
      Math.round((Date.parse(forecast.expires) - Date.now()) / 1000)
    )
    return new Response(JSON.stringify(forecast), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        // Browser + CDN both cache until MET's data refreshes.
        'cache-control': `public, max-age=${maxAge}`,
        'netlify-cdn-cache-control': `public, max-age=${maxAge}`
      }
    })
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message ?? 'MET fetch failed' }),
      { status: 502, headers: { 'content-type': 'application/json' } }
    )
  }
}
