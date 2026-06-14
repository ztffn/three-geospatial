#!/usr/bin/env node
// Regenerates ui/shadowFleet.ts from an EU Official Journal vessel-listing
// source — the sanctioned "shadow fleet" tankers in Annex XLII of Reg (EU)
// 833/2014. Accepts the EUR-Lex HTML (any amendment) or the pipe-table .md
// export, on stdin or as a path arg. Extracts every row carrying a 7-digit
// IMO: current + former name, Article 3s(2) ground letter, listing date.
//
// Usage:
//   curl -sL --compressed -A "Mozilla/5.0" \
//     "https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=OJ:L_202501494" \
//     | node examples/ocean-globe-waterpro-demo/scripts/parse-shadow-fleet.mjs
//   node .../parse-shadow-fleet.mjs path/to/source.html > /tmp/preview   (dry run)
//
// Writes ui/shadowFleet.ts unless --stdout is passed (then prints to stdout).

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// Labels for the grounds under Article 3s(2) that actually appear in the
// consolidated Annex XLII register (points a, b, c, d, f, g; e/h unused).
const GROUND_LABEL = {
  a: 'Transports defence/security goods to or from Russia (Art. 3s(2)(a))',
  b: 'Irregular & high-risk Russian oil transport (Art. 3s(2)(b))',
  c: 'Supports Russian energy-sector expansion (Art. 3s(2)(c))',
  d: 'Undermines Ukrainian economy/heritage, e.g. stolen grain (Art. 3s(2)(d))',
  f: 'Facilitates circumvention of EU/Russia sanctions (Art. 3s(2)(f))',
  g: 'Linked to a sanctioned person/entity (Art. 3s(2)(g))'
}

const args = process.argv.slice(2)
const toStdout = args.includes('--stdout')
const pathArg = args.find(a => !a.startsWith('--'))
const raw = readFileSync(pathArg != null ? pathArg : 0, 'utf8')

const decode = s =>
  s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))

// Split the source into "cells" rows, handling both HTML <tr>/<td> tables and
// markdown pipe rows. Each row → array of cell strings.
function rowsFromHtml(text) {
  const rows = []
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi
  const tdRe = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi
  let tr
  while ((tr = trRe.exec(text)) != null) {
    const cells = []
    let td
    while ((td = tdRe.exec(tr[1])) != null) {
      const txt = decode(
        td[1].replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')
      )
      cells.push(txt.replace(/\s+/g, ' ').trim())
    }
    if (cells.length > 0) rows.push(cells)
  }
  return rows
}

function rowsFromMarkdown(text) {
  return text
    .split('\n')
    .filter(l => l.trim().startsWith('|'))
    .map(l =>
      l
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map(c => decode(c.replace(/<br\s*\/?>/gi, ' ')).replace(/\s+/g, ' ').trim())
    )
}

const rows = /<tr\b/i.test(raw) ? rowsFromHtml(raw) : rowsFromMarkdown(raw)

const imoRe = /^\d{7}$/
const seen = new Map()
for (const cells of rows) {
  const imoIdx = cells.findIndex(c => imoRe.test(c))
  if (imoIdx <= 0) continue // need a name cell before the IMO
  const imo = cells[imoIdx]
  const nameRaw = cells[imoIdx - 1]
  const rest = cells.slice(imoIdx + 1).join(' ')
  const groundM = rest.match(/point \(([a-z])\)/)
  const dateM = rest.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/)
  const formerlyM = nameRaw.match(/\(formerly\s+([^)]+)\)/i)
  const name = nameRaw
    .replace(/\s*\(formerly[^)]+\)/i, '')
    .replace(/[‘'’]/g, '')
    .trim()
  if (name === '') continue
  const listed =
    dateM != null
      ? `${dateM[3]}-${dateM[2].padStart(2, '0')}-${dateM[1].padStart(2, '0')}`
      : null
  seen.set(imo, {
    imo,
    name,
    formerly: formerlyM != null ? formerlyM[1].trim() : null,
    ground: groundM != null ? groundM[1] : null,
    listed
  })
}

const vessels = [...seen.values()].sort((a, b) =>
  a.name.toLowerCase().localeCompare(b.name.toLowerCase())
)
if (vessels.length === 0) {
  console.error('No vessel rows found (expected rows with a 7-digit IMO).')
  process.exit(1)
}

const header = `// Sanctioned "shadow fleet" vessels — EU Regulation (EU) No 833/2014, Annex
// XLII (consolidated text 02014R0833-20260424), parsed from the EUR-Lex HTML
// source. Static reference data: IMO, current + former name, legal ground,
// listing date. Positions are NOT here (the sanctioned tankers are frequently
// AIS-dark by design) — resolve live via AIS by IMO/MMSI when a feed is wired.

export interface ShadowFleetVessel {
  imo: string
  name: string
  formerly: string | null
  /** Point letter of EU Regulation 833/2014 Article 3s(2). */
  ground: 'a' | 'b' | 'c' | 'd' | 'f' | 'g' | null
  /** Listing date (ISO 8601). */
  listed: string | null
}

export const SHADOW_FLEET_GROUND_LABEL: Record<string, string> = {
${Object.entries(GROUND_LABEL)
  .map(([k, v]) => `  ${k}: ${JSON.stringify(v)},`)
  .join('\n')}
}

// ${vessels.length} vessels (EU Reg 833/2014, Annex XLII, consolidated 2026-04-24).
export const SHADOW_FLEET: ShadowFleetVessel[] = [
${vessels
  .map(
    v =>
      `  { imo: ${JSON.stringify(v.imo)}, name: ${JSON.stringify(v.name)}, formerly: ${JSON.stringify(v.formerly)}, ground: ${JSON.stringify(v.ground)}, listed: ${JSON.stringify(v.listed)} },`
  )
  .join('\n')}
]
`

if (toStdout) {
  process.stdout.write(header)
} else {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const out = path.resolve(here, '../ui/shadowFleet.ts')
  writeFileSync(out, header)
  console.error(`wrote ${out} (${vessels.length} vessels)`)
}
