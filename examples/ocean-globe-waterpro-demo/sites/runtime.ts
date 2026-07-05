// Adapts authored SiteDefinition scenarios into the runtime Scenario shape the
// twin's scenario panel and camera rig consume: each SiteViewpoint becomes an
// anchor-pinned viewpoint (lon/lat = site anchor, aimOffsetENU = targetENU),
// reproducing exactly how preset-anchored catalogue scenarios fly. Composes
// the full runtime catalogue: static scenarios (optionally EXTENDED with
// authored views when their preset anchor is the site anchor) + new authored
// scenarios. Owns the code-owned/authored id distinction and scenario slugs.

import { SCENARIOS, type Scenario, type Viewpoint } from '../ui/scenarios'
import { SITE_PRESETS } from './static-sites'
import type {
  ScenarioEnvironment,
  SiteDefinition,
  SiteScenario,
  SiteViewpoint
} from './types'

// The one owner of the code-owned/authored distinction: a scenario is
// code-owned iff its id is in the static catalogue. Consumed by the runtime
// merge below, the author sidebar (tags, editability) and the author
// mutators (id-collision avoidance) — never re-derive it.
export const STATIC_SCENARIO_IDS: ReadonlySet<string> = new Set(
  SCENARIOS.map(s => s.id)
)

export function isStaticScenarioId(id: string): boolean {
  return STATIC_SCENARIO_IDS.has(id)
}

function toRuntimeViewpoint(
  site: SiteDefinition,
  viewpoint: SiteViewpoint
): Viewpoint {
  return {
    id: viewpoint.id,
    label: viewpoint.label,
    // Anchor coordinates pin the location (and anything placed at it) across
    // this scenario's viewpoints; the camera-only ENU aim does the framing —
    // the same split the preset-anchored catalogue scenarios use. Deliberately
    // NO height: the scene defaults an unknown location to height 20 (sea
    // level), and flyTo.height also flips its exact-landing mode.
    longitude: site.anchor.longitude,
    latitude: site.anchor.latitude,
    aimOffsetENU: viewpoint.targetENU,
    distance: viewpoint.distance,
    headingDeg: viewpoint.headingDeg,
    pitchDeg: viewpoint.pitchDeg
  }
}

// Runtime scenarios for one authored site. Scenarios without viewpoints are
// skipped — the panel's scenario click flies to viewpoints[0], so an empty
// scenario is not presentable (it still shows in the author sidebar).
export function siteScenariosToRuntime(site: SiteDefinition): Scenario[] {
  return site.scenarios
    .filter(scenario => scenario.viewpoints.length > 0)
    .map(scenario => ({
      id: scenario.id,
      label: scenario.label,
      turbines: 0,
      environment: scenario.environment ?? undefined,
      enabled: scenario.enabled ?? true,
      viewpoints: orderedViewpoints(scenario).map(viewpoint =>
        toRuntimeViewpoint(site, viewpoint)
      )
    }))
}

// A static scenario can accept authored view EXTENSIONS from a site only when
// its preset anchor IS the site anchor — targetENU is stored relative to the
// site anchor, and extending a scenario anchored elsewhere would re-centre
// the world (ocean/terrain) to the wrong place when the view is selected.
// Matched by the SITE_PRESETS name pairing, not coordinate equality.
export function scenarioAcceptsSiteViews(
  scenario: Scenario,
  site: SiteDefinition
): boolean {
  return (
    scenario.preset != null &&
    (SITE_PRESETS[site.id]?.includes(scenario.preset) ?? false)
  )
}

// Authored views a site contributes to a static scenario: the same-id site
// scenario's viewpoints, minus any whose id the static scenario already has
// (the committed seed duplicates the static views as its declared shape —
// dedup keeps them from rendering twice).
export function siteViewExtensions(
  staticScenario: Scenario,
  site: SiteDefinition
): SiteViewpoint[] {
  if (!scenarioAcceptsSiteViews(staticScenario, site)) return []
  const own = new Set(staticScenario.viewpoints.map(v => v.id))
  return (
    site.scenarios
      .find(s => s.id === staticScenario.id)
      ?.viewpoints.filter(v => !own.has(v.id)) ?? []
  )
}

// Authored environment override for a static scenario, from its host site's
// same-id extension entry. `undefined` when no site has an opinion (the code
// default applies); `null` when the author explicitly cleared it back to
// that default; otherwise the override object.
function authoredEnvironment(
  staticScenario: Scenario,
  sites: SiteDefinition[]
): ScenarioEnvironment | null | undefined {
  for (const site of sites) {
    if (!scenarioAcceptsSiteViews(staticScenario, site)) continue
    const entry = site.scenarios.find(s => s.id === staticScenario.id)
    if (entry != null && 'environment' in entry) return entry.environment
  }
  return undefined
}

// Authored publish state for a static scenario, from the same extension
// entry. `undefined` when no site has an opinion (always live); a static
// scenario stays IN the composed catalogue regardless (an author must still
// be able to see and re-enable it) — the visitor-facing list is what
// actually filters on `enabled` (see TwinExperience.tsx).
function authoredEnabled(
  staticScenario: Scenario,
  sites: SiteDefinition[]
): boolean | undefined {
  for (const site of sites) {
    if (!scenarioAcceptsSiteViews(staticScenario, site)) continue
    const entry = site.scenarios.find(s => s.id === staticScenario.id)
    if (entry?.enabled != null) return entry.enabled
  }
  return undefined
}

// The full runtime catalogue: static scenarios (each extended with authored
// views where the anchor allows, and with its environment/publish overrides
// applied if a host site has one), then new authored scenarios. Static wins
// on id collision — authored data adds scenarios/views and can override
// environment/enabled, never replaces the richer code-owned definitions
// otherwise.
export function composeScenarioCatalogue(
  staticScenarios: Scenario[],
  sites: SiteDefinition[]
): Scenario[] {
  const staticIds = new Set(staticScenarios.map(s => s.id))
  const extended = staticScenarios.map(scenario => {
    const extras = sites.flatMap(site =>
      siteViewExtensions(scenario, site).map(viewpoint =>
        toRuntimeViewpoint(site, viewpoint)
      )
    )
    const envOverride = authoredEnvironment(scenario, sites)
    const enabledOverride = authoredEnabled(scenario, sites)
    if (
      extras.length === 0 &&
      envOverride === undefined &&
      enabledOverride === undefined
    ) {
      return scenario
    }
    return {
      ...scenario,
      ...(envOverride !== undefined
        ? { environment: envOverride ?? undefined }
        : null),
      ...(enabledOverride !== undefined ? { enabled: enabledOverride } : null),
      viewpoints: [...scenario.viewpoints, ...extras]
    }
  })
  return [
    ...extended,
    ...sites
      .flatMap(siteScenariosToRuntime)
      .filter(scenario => !staticIds.has(scenario.id))
  ]
}

// The default viewpoint leads (the panel treats viewpoints[0] as the landing).
function orderedViewpoints(scenario: SiteScenario): SiteViewpoint[] {
  const defaultId = scenario.defaultViewpointId
  if (defaultId == null) return scenario.viewpoints
  const index = scenario.viewpoints.findIndex(vp => vp.id === defaultId)
  if (index <= 0) return scenario.viewpoints
  const next = [...scenario.viewpoints]
  const [vp] = next.splice(index, 1)
  next.unshift(vp)
  return next
}

// URL/id-safe slug from an author-typed label, unique against taken ids
// ('My Site' → 'my-site', collision → 'my-site-2', …).
export function scenarioSlug(label: string, taken: Set<string>): string {
  const base =
    label
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'scenario'
  if (!taken.has(base)) return base
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`
    if (!taken.has(candidate)) return candidate
  }
}
