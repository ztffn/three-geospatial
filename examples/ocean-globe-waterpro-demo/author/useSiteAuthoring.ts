// Scenario/viewpoint authoring, in the product's terms: a flat world of
// scenarios, each a name plus captured views. Sites/anchors are internal
// bookkeeping this hook fully owns — a new scenario is a client-side pending
// name until its first capture, which pins it to the nearest existing anchor
// or mints a new one at the captured spot. All mutations rebuild the owning
// SiteDefinition and PUT it whole, consuming the ONE fetched manifest copy
// from ctx.sites and refreshing it once per save.

import { useCallback, useMemo, useState } from 'react'

import type { PutSiteResponse } from '../authoring/types'
import type { AuthorSlotContext } from '../app/TwinExperience'
import { SITE_SEEDS } from '../sites'
import {
  capturePoseAnchorError,
  MAX_CAPTURE_ANCHOR_DISTANCE,
  poseAnchorDistance,
  poseTargetToAnchor,
  poseToViewpointFields,
  type CameraPose
} from '../sites/enu'
import {
  isStaticScenarioId,
  scenarioAcceptsSiteViews,
  scenarioSlug,
  STATIC_SCENARIO_IDS
} from '../sites/runtime'
import type { SiteDefinition, SiteScenario, SiteViewpoint } from '../sites/types'
import { SCENARIOS, type Scenario } from '../ui/scenarios'
import { jsonOrThrow } from '../ui/useScenarioSlideshows'

// A created-but-never-captured scenario: just a name. It gets a home (an
// anchor) from its first captured view; until then nothing is persisted.
export interface PendingScenario {
  id: string
  label: string
}

export interface SiteAuthoringState {
  saving: boolean
  error: string | null
  // Every effective SiteDefinition: seeds (server copy wins per id) plus any
  // server-only sites minted by captures.
  effectiveSites: SiteDefinition[]
  pending: PendingScenario[]
  // The owning site + entry for an authored scenario id (null for static ids
  // and pending scenarios).
  authoredScenario: (
    scenarioId: string | null
  ) => { site: SiteDefinition; scenario: SiteScenario } | null
  // The site hosting a static scenario's authored view extensions.
  hostSiteOf: (scenario: Scenario) => SiteDefinition | undefined
  addScenario: (label: string) => void
  renameScenario: (scenarioId: string, label: string) => Promise<void>
  deleteScenario: (scenarioId: string) => Promise<void>
  // Captures the pose as a view of the scenario. For a pending scenario this
  // also assigns its anchor (nearest existing one, or minted at the aim
  // point). Throws a user-facing message when the pose is too far from an
  // already-anchored scenario's views.
  captureViewpoint: (
    scenarioId: string,
    pose: CameraPose,
    label: string
  ) => Promise<void>
  renameViewpoint: (
    scenarioId: string,
    viewpointId: string,
    label: string
  ) => Promise<void>
  deleteViewpoint: (scenarioId: string, viewpointId: string) => Promise<void>
}

export function useSiteAuthoring(
  sites: AuthorSlotContext['sites']
): SiteAuthoringState {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingScenario[]>([])
  const { authored, refresh } = sites

  const effectiveSites = useMemo(() => {
    const seedIds = new Set(SITE_SEEDS.map(s => s.id))
    return [
      ...SITE_SEEDS.map(
        seed => authored.find(site => site.id === seed.id) ?? seed
      ),
      ...authored.filter(site => !seedIds.has(site.id))
    ]
  }, [authored])

  // The site entry holding this scenario id, INCLUDING extension entries for
  // static scenarios — the write path for all view edits.
  const owningEntry = useCallback(
    (scenarioId: string) => {
      for (const site of effectiveSites) {
        const scenario = site.scenarios.find(s => s.id === scenarioId)
        if (scenario != null) return { site, scenario }
      }
      return null
    },
    [effectiveSites]
  )

  const authoredScenario = useCallback(
    (scenarioId: string | null) => {
      if (scenarioId == null || isStaticScenarioId(scenarioId)) return null
      return owningEntry(scenarioId)
    },
    [owningEntry]
  )

  const hostSiteOf = useCallback(
    (scenario: Scenario) =>
      effectiveSites.find(site => scenarioAcceptsSiteViews(scenario, site)),
    [effectiveSites]
  )

  // Rethrows on failure — callers (patchScenario, captureViewpoint) must not
  // treat a failed save as a success (e.g. navigating away as if a delete
  // went through when the PUT actually failed).
  const putSite = useCallback(
    async (site: SiteDefinition) => {
      setSaving(true)
      setError(null)
      try {
        await jsonOrThrow<PutSiteResponse>(
          await fetch(`/api/authoring/sites/${encodeURIComponent(site.id)}`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(site)
          })
        )
        await refresh()
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'failed to save')
        throw err
      } finally {
        setSaving(false)
      }
    },
    [refresh]
  )

  const patchScenario = useCallback(
    async (
      scenarioId: string,
      patch: (scenario: SiteScenario) => SiteScenario | null
    ) => {
      const owner = owningEntry(scenarioId)
      if (owner == null) return
      await putSite({
        ...owner.site,
        scenarios: owner.site.scenarios
          .map(scenario =>
            scenario.id === scenarioId ? patch(scenario) : scenario
          )
          .filter((scenario): scenario is SiteScenario => scenario != null)
      })
    },
    [owningEntry, putSite]
  )

  const addScenario = useCallback(
    (label: string) => {
      const cleaned = label.trim().slice(0, 80)
      if (cleaned.length === 0) return
      // Unique across everything that can render: the static catalogue, all
      // persisted authored scenarios, and other pending names.
      const taken = new Set([
        ...STATIC_SCENARIO_IDS,
        ...effectiveSites.flatMap(site => site.scenarios.map(s => s.id)),
        ...pending.map(p => p.id)
      ])
      setPending(current => [
        ...current,
        { id: scenarioSlug(cleaned, taken), label: cleaned }
      ])
    },
    [effectiveSites, pending]
  )

  const renameScenario = useCallback(
    async (scenarioId: string, label: string) => {
      const cleaned = label.trim().slice(0, 80)
      if (cleaned.length === 0) return
      if (pending.some(p => p.id === scenarioId)) {
        setPending(current =>
          current.map(p => (p.id === scenarioId ? { ...p, label: cleaned } : p))
        )
        return
      }
      await patchScenario(scenarioId, scenario => ({
        ...scenario,
        label: cleaned
      }))
    },
    [pending, patchScenario]
  )

  const deleteScenario = useCallback(
    async (scenarioId: string) => {
      if (pending.some(p => p.id === scenarioId)) {
        setPending(current => current.filter(p => p.id !== scenarioId))
        return
      }
      await patchScenario(scenarioId, () => null)
    },
    [pending, patchScenario]
  )

  // The site a first capture pins a scenario to: the nearest anchor when one
  // is in range, else a fresh site minted at the aim point. Sites are
  // bookkeeping — the author only ever chose where to look.
  const siteForFirstCapture = useCallback(
    (pose: CameraPose, scenario: PendingScenario): SiteDefinition => {
      let nearest: SiteDefinition | undefined
      let nearestDistance = Infinity
      for (const site of effectiveSites) {
        const distance = poseAnchorDistance(site.anchor, pose)
        if (distance < nearestDistance) {
          nearest = site
          nearestDistance = distance
        }
      }
      if (nearest != null && nearestDistance <= MAX_CAPTURE_ANCHOR_DISTANCE) {
        return nearest
      }
      const taken = new Set(effectiveSites.map(site => site.id))
      return {
        id: scenarioSlug(`site ${scenario.id}`, taken),
        label: scenario.label,
        anchor: poseTargetToAnchor(pose),
        layers: [],
        scenarios: [],
        annotations: []
      }
    },
    [effectiveSites]
  )

  const captureViewpoint = useCallback(
    async (scenarioId: string, pose: CameraPose, label: string) => {
      const cleaned = label.trim().slice(0, 80) || 'View'
      const appendView = (
        site: SiteDefinition,
        scenario: SiteScenario
      ): SiteScenario => {
        const viewpoint: SiteViewpoint = {
          id: scenarioSlug(
            cleaned,
            new Set(scenario.viewpoints.map(vp => vp.id))
          ),
          label: cleaned,
          ...poseToViewpointFields(site.anchor, pose)
        }
        return { ...scenario, viewpoints: [...scenario.viewpoints, viewpoint] }
      }

      // Static scenario: the capture extends it inside its host site.
      const staticScenario = SCENARIOS.find(s => s.id === scenarioId)
      if (staticScenario != null) {
        const host = hostSiteOf(staticScenario)
        if (host == null) {
          throw new Error(
            `'${staticScenario.label}' has no anchor pairing — add it to SITE_PRESETS.`
          )
        }
        const anchorError = capturePoseAnchorError(
          host.anchor,
          pose,
          staticScenario.label
        )
        if (anchorError != null) throw new Error(anchorError)
        const existing = host.scenarios.find(s => s.id === scenarioId)
        const entry = appendView(
          host,
          existing ?? {
            id: scenarioId,
            label: staticScenario.label,
            viewpoints: []
          }
        )
        await putSite({
          ...host,
          scenarios:
            existing != null
              ? host.scenarios.map(s => (s.id === scenarioId ? entry : s))
              : [...host.scenarios, entry]
        })
        return
      }

      // Already-anchored authored scenario: views must stay near its anchor.
      const owner = authoredScenario(scenarioId)
      if (owner != null) {
        const anchorError = capturePoseAnchorError(
          owner.site.anchor,
          pose,
          owner.scenario.label
        )
        if (anchorError != null) throw new Error(anchorError)
        await patchScenario(scenarioId, scenario =>
          appendView(owner.site, scenario)
        )
        return
      }

      // Pending scenario: this first capture gives it a home.
      const pendingEntry = pending.find(p => p.id === scenarioId)
      if (pendingEntry == null) throw new Error('scenario not found')
      const site = siteForFirstCapture(pose, pendingEntry)
      const entry = appendView(site, {
        id: pendingEntry.id,
        label: pendingEntry.label,
        viewpoints: []
      })
      await putSite({ ...site, scenarios: [...site.scenarios, entry] })
      setPending(current => current.filter(p => p.id !== scenarioId))
    },
    [
      hostSiteOf,
      authoredScenario,
      pending,
      siteForFirstCapture,
      patchScenario,
      putSite
    ]
  )

  const renameViewpoint = useCallback(
    async (scenarioId: string, viewpointId: string, label: string) => {
      const cleaned = label.trim().slice(0, 80)
      if (cleaned.length === 0) return
      await patchScenario(scenarioId, scenario => ({
        ...scenario,
        viewpoints: scenario.viewpoints.map(vp =>
          vp.id === viewpointId ? { ...vp, label: cleaned } : vp
        )
      }))
    },
    [patchScenario]
  )

  const deleteViewpoint = useCallback(
    async (scenarioId: string, viewpointId: string) => {
      await patchScenario(scenarioId, scenario => ({
        ...scenario,
        viewpoints: scenario.viewpoints.filter(vp => vp.id !== viewpointId)
      }))
    },
    [patchScenario]
  )

  return {
    saving,
    error,
    effectiveSites,
    pending,
    authoredScenario,
    hostSiteOf,
    addScenario,
    renameScenario,
    deleteScenario,
    captureViewpoint,
    renameViewpoint,
    deleteViewpoint
  }
}
