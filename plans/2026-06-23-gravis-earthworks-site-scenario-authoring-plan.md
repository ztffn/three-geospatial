# Gravis Earthworks Site/Scenario Authoring Plan

## Objective

Create a reusable site/scenario system for `three-geospatial` that can support Gravis-style construction twins: multiple 3D models, multiple Gaussian splats, geospatial context, world-space annotations, camera flybys, audio narrative, and nontechnical authoring.

The product direction we are leaning into is not "a splat viewer." It is an operational twin for intelligent heavy equipment: a way to present, inspect, and eventually operate around autonomous earthmoving sites. The target use case is construction context for autonomy, safety, and productivity:

- Show a worksite as a composed scene: terrain, design surfaces, machine models, survey captures, splats, and live/contextual data.
- Let a site owner, operator, OEM partner, or executive move between curated scenarios.
- Explain a workflow through authored flybys and callouts: cut/fill progress, exclusion zones, haul routes, machine context, risk points, and production checkpoints.
- Make site content repeatable: adding a new site or scenario should mean adding data and assets, not cloning bespoke UI and scene code.

This plan intentionally borrows the useful concepts from the Virtual Soil Viewer:

- Stable shareable scene URLs.
- World-space markers with labels.
- Camera fly-to positions.
- Field/site records that resolve to assets and metadata.
- Admin/editor scaffolding for markers.
- Fullscreen viewer chrome.

It does not lift the Soil app wholesale. `three-geospatial` already has stronger foundations: geospatial frames, WebGPU story infrastructure, contextual twin panels, existing scenario/viewpoint concepts, and an in-house splats package.

## Relevant Existing Code

Primary `three-geospatial` surfaces:

- `/Users/steffen/Projects/three-geospatial/packages/splats`
  Existing Gaussian splat package. Phase 1 WebGL standalone is implemented; WebGPU/geospatial path is in progress.
- `/Users/steffen/Projects/three-geospatial/storybook-webgpu/src/ocean/SplatLayer.tsx`
  Current procedural proof of a splat layer inside the twin scene.
- `/Users/steffen/Projects/three-geospatial/examples/ocean-globe-waterpro-demo/ui/scenarios.ts`
  Existing scenario/viewpoint catalogue.
- `/Users/steffen/Projects/three-geospatial/examples/ocean-globe-waterpro-demo/ui/DigitalTwinUI.tsx`
  Existing contextual UI panels, scenario picker, forecast scrubber, camera controls, and layer toggles.
- `/Users/steffen/Projects/three-geospatial/examples/ocean-globe-waterpro-demo/main.tsx`
  Deployed twin host, readiness flow, fullscreen resize handling, scenario state, and UI wiring.

Potentially reusable external/local prototype:

- `/Users/steffen/Projects/huma/3d/Path-Creator`
  TypeScript/R3F port inspired by Unity Path-Creator. It already provides Bezier path editing, vertex-path sampling, object/path following, `useDollyCamera`, and a minimal R3F editor using drei `PivotControls`. It should be treated as the path math/runtime foundation for flybys, not as the final nontechnical authoring product.

## Product Shape

The reusable system should be built around a site definition, not a viewer component.

```ts
SiteDefinition
  -> geospatial anchor / local ENU frame
  -> asset layers
  -> scenarios
  -> viewpoints
  -> annotations
  -> tours
  -> UI panels and controls
```

For a Gravis earthworks demo, a site might contain:

- One terrain/tiles layer.
- One design surface or grading plan.
- Several GLB machine models.
- Several Gaussian splat captures: current site, machine bay, workface, hazardous area, stockpile.
- Safety and production annotations.
- A guided executive flyby.
- Operator-oriented scenario controls.
- Context panels: progress, productivity, safety envelope, fleet status, autonomy mode, weather, and survey timestamp.

## Core Data Model

Add a site catalogue under a dedicated folder, for example:

```text
/Users/steffen/Projects/three-geospatial/examples/ocean-globe-waterpro-demo/sites/
  gravis-earthworks.site.ts
  karmoy.site.ts
  index.ts
```

Later, move stable pieces into a package if they are useful outside the example:

```text
/Users/steffen/Projects/three-geospatial/packages/twin-sites/
```

Initial contract:

```ts
export interface SiteDefinition {
  id: string
  label: string
  description?: string
  anchor: SiteAnchor
  layers: SiteLayer[]
  scenarios: SiteScenario[]
  annotations: SiteAnnotation[]
  tours?: SiteTour[]
  panels?: SitePanelDefinition[]
}

export interface SiteAnchor {
  longitude: number
  latitude: number
  height?: number
  frame: 'wgs84-enu'
}
```

Layer contract:

```ts
export type SiteLayer =
  | SiteModelLayer
  | SiteSplatLayer
  | SiteTilesetLayer
  | SiteTelemetryLayer
  | SiteDesignSurfaceLayer

export interface SiteModelLayer {
  type: 'model'
  id: string
  label: string
  url: string
  transform: SiteTransform
  visibleByDefault?: boolean
  scenarioIds?: string[]
}

export interface SiteSplatLayer {
  type: 'splat'
  id: string
  label: string
  url: string
  format: 'ply' | 'spz' | 'sog' | 'ksplat' | '3dtiles'
  transform: SiteTransform
  capture?: {
    capturedAt?: string
    source?: 'drone' | 'phone' | 'lidar' | 'synthetic' | 'unknown'
    accuracyNote?: string
  }
  visibleByDefault?: boolean
  scenarioIds?: string[]
}

export interface SiteTransform {
  positionENU: [number, number, number]
  rotationEulerDeg?: [number, number, number]
  quaternion?: [number, number, number, number]
  scale?: number | [number, number, number]
}
```

Scenario contract:

```ts
export interface SiteScenario {
  id: string
  label: string
  summary?: string
  defaultViewpointId?: string
  layerOverrides?: Record<string, { visible?: boolean; opacity?: number }>
  settings?: SiteSettingDefinition[]
  viewpoints: SiteViewpoint[]
  panelIds?: string[]
  annotationIds?: string[]
  tourIds?: string[]
}
```

Viewpoint contract:

```ts
export interface SiteViewpoint {
  id: string
  label: string
  targetENU: [number, number, number]
  distance?: number
  headingDeg?: number
  pitchDeg?: number
  cameraENU?: [number, number, number]
  fovDeg?: number
}
```

Annotation contract:

```ts
export interface SiteAnnotation {
  id: string
  label: string
  body?: string
  layerId?: string
  scenarioIds?: string[]
  positionENU: [number, number, number]
  icon?: string
  severity?: 'info' | 'warning' | 'critical' | 'success'
  tags?: string[]
  view?: {
    targetENU: [number, number, number]
    cameraENU?: [number, number, number]
    distance?: number
    headingDeg?: number
    pitchDeg?: number
  }
}
```

Tour contract:

```ts
export interface SiteTour {
  id: string
  label: string
  description?: string
  durationSec?: number
  path: SerializedBezierPath
  stops: TourStop[]
  audio?: TourAudioTrack
}

export interface TourStop {
  id: string
  timeSec: number
  title: string
  body?: string
  annotationId?: string
  layerOverrides?: Record<string, { visible?: boolean; opacity?: number }>
  pause?: boolean
}

export interface TourAudioTrack {
  url: string
  transcript?: Array<{
    startSec: number
    endSec: number
    text: string
  }>
}
```

## Runtime Architecture

Create a `SiteRuntime` that consumes a `SiteDefinition` and active scenario state.

```tsx
<SiteRuntime
  site={activeSite}
  scenarioId={activeScenarioId}
  selectedAnnotationId={selectedAnnotationId}
  editMode={editMode}
/>
```

Responsibilities:

- Convert `positionENU` transforms into world/ECEF transforms using the site's anchor.
- Mount GLB models, splat layers, tilesets, design surfaces, and telemetry overlays.
- Apply scenario-specific layer visibility and opacity.
- Expose a registry of selectable layers/objects/annotations.
- Provide camera commands: fly to viewpoint, fly to annotation, play/pause tour.
- Provide editor commands: add annotation, move annotation, capture viewpoint, update transform, export JSON.

The first implementation can stay in the example app. Once the interface stabilizes, extract reusable pieces into a package.

## Multi-Splat And Multi-Model Strategy

The system must allow a site to use multiple models and multiple splats. It must also allow multiple splats to be visible at once.

Short-term:

- Treat each splat capture as a separate `SiteSplatLayer`.
- Place it in the site ENU frame with an explicit transform.
- Allow scenario visibility toggles.
- Support opacity toggles only if the renderer path supports it cleanly.
- Warn in docs that overlapping transparent splat layers may composite incorrectly if rendered independently.

Medium-term:

- For non-overlapping or spatially separated splats, keep independent layers.
- For overlapping captures, introduce a `SplatGroupLayer` that can aggregate splat data and sort globally.
- For geospatial tiled splats, align with the existing `packages/splats` design: SPZ inside glTF `KHR_gaussian_splatting_compression_spz_2` for streamed 3D Tiles.
- Treat `download-splat` as the acquisition step only. Export captures to PLY today, then run a second conversion step to SPZ for archive-ready assets. Use `spz-js` or the upstream Niantic SPZ encoder once the engine path is ready.
- Note: the current SuperSplat scene URL for `d4ae1c10` resolves to a SOG v2 asset tree, so the converter may need a compatibility fix or a raw asset download path before the PLY -> SPZ step is reliable.

Long-term:

- Support a tiled splat layer that behaves like a proper geospatial layer, not a decorative object.
- Avoid double-geometry: if a region is represented by splats, do not also load an identical mesh layer in the same space unless the user deliberately wants comparison mode.
- Add compare modes: design vs actual, date A vs date B, mesh vs splat, scan vs telemetry.

## World-Space Marker Overlay

Recreate the Soil marker idea as an `AnnotationLayer`.

Features:

- World-space icon anchored to ENU position.
- Optional label always visible or visible on hover/select.
- Click marker to select.
- Selection opens a contextual panel.
- Selection can fly the camera to a stored view.
- Annotation can be scoped to a site, scenario, layer, model, splat, machine, or telemetry object.

Implementation recommendation:

- First pass: use `@react-three/drei` `Html` or billboarding sprites for low marker counts.
- For high marker counts: migrate icons to instanced sprites and reserve DOM labels for selected/hovered items.
- Store annotation positions in site-local ENU, not raw world/ECEF, so authored data remains portable and human-readable.

Editor MVP:

- Toggle edit mode.
- Add marker at clicked point.
- Drag marker with drei `PivotControls` or `TransformControls`.
- Edit title/body/severity/tags in a DOM panel.
- Capture current camera as marker fly-to view.
- Export updated site JSON.

Do not start with database persistence. JSON export/import is enough until the schema stabilizes.

## Viewer Chrome And Fullscreen

Build reusable viewer chrome rather than scattering controls across each demo.

```tsx
<TwinViewerChrome
  fullscreen
  sites
  scenarios
  layerControls
  annotationPanel
  tourControls
  contextualPanels
/>
```

Initial controls:

- Fullscreen button.
- Site/scenario picker.
- Viewpoint picker.
- Layer toggles.
- Marker list.
- Tour play/pause/scrub.
- Edit mode toggle behind a clear dev/admin affordance.

The fullscreen button from the Soil viewer is useful, but `three-geospatial` already has resize/fullscreen concerns in:

```text
/Users/steffen/Projects/three-geospatial/examples/ocean-globe-waterpro-demo/main.tsx
```

Standardize that logic into a reusable `useFullscreenCanvasResize` or `FullscreenButton` helper so the WebGPU canvas does not end up with stale dimensions after fullscreen transitions.

## Automated Flybys And Narrative Authoring

This should be treated as a first-class product feature. For Gravis-style executive demos, a nontechnical person should be able to create a guided story:

- Choose a site.
- Pick a scenario.
- Add camera path points.
- Add stops.
- Attach callouts.
- Record or upload audio.
- Preview the flyby.
- Export/publish the tour.

The authoring model should be closer to "Keynote for a 3D site" than a developer debug panel.

### Recommendation

Use `/Users/steffen/Projects/huma/3d/Path-Creator` as the runtime/path foundation, and build a Twin-specific tour authoring layer on top.

Use Theatre.js selectively, if at all, for advanced timeline sequencing. Do not make Theatre.js the canonical data model for site tours.

Reasoning:

- `Path-Creator` already solves the hard reusable math: Bezier paths, sampled vertex paths, closest-point queries, endpoint behavior, R3F path following, and dolly camera helpers.
- `Path-Creator` can serialize paths as data, which fits site definitions and version control.
- Theatre.js is strong for cinematic timelines, property animation, and keyframed sequences, but it can become a separate project format that is harder to merge with geospatial site definitions.
- Nontechnical authors need a domain UI: "Add stop", "Look at marker", "Narration starts here", "Show safety zone", "Fade in design surface." They do not need raw animation curves as the primary interface.

### Proposed Tour Stack

Layer 1: Canonical tour data

- Stored in `SiteTour`.
- Versionable JSON/TypeScript.
- References site layers, annotations, viewpoints, and audio.
- Does not depend on Theatre.js.

Layer 2: Path runtime

- Reuse/adapt `@huma/path-creator`.
- `BezierPath` stores camera rail.
- `VertexPath` samples position/direction by distance/time.
- `useDollyCamera` or an adapted helper drives camera motion.
- Add geospatial ENU helpers so paths are authored in site-local coordinates and converted to world transforms.

Layer 3: Tour player

```tsx
<TourPlayer
  site={site}
  tour={tour}
  playing={playing}
  timeSec={timeSec}
  onTimeChange={setTimeSec}
/>
```

Responsibilities:

- Drive camera along the path.
- Aim camera via look-ahead, explicit look target, or annotation target.
- Trigger stops/callouts.
- Apply layer visibility/opacity changes.
- Sync audio playback.
- Show transcript/captions.
- Support pause-at-stop and continue.

Layer 4: Tour authoring UI

```tsx
<TourEditor
  site={site}
  tour={draftTour}
  onChange={setDraftTour}
/>
```

Authoring features:

- Add path point at current camera.
- Add stop at current time.
- Attach selected annotation to stop.
- Capture current view as look target.
- Upload/record audio.
- Enter transcript text.
- Preview from selected stop.
- Export JSON.

Layer 5: Optional Theatre.js bridge

Only after the canonical tour model works:

- Export a `SiteTour` to a Theatre.js project for advanced cinematic editing.
- Or import a Theatre.js camera track into `SiteTour`.
- Keep Theatre-specific state as an optional extension, not the source of truth.

```ts
interface SiteTour {
  theatreProjectUrl?: string
  theatreSheetName?: string
  // canonical path/stops still exist
}
```

### Audio Narrative

Initial implementation should support uploaded audio files, not generated audio.

Tour audio requirements:

- Audio file URL in `TourAudioTrack`.
- Play/pause tied to tour time.
- Scrubbing keeps audio and camera in sync.
- Transcript entries render captions.
- Stops can pause both camera and audio.
- Audio ducking or mute can be added later.

Future authoring features:

- Browser recording through `MediaRecorder`.
- Transcript import from `.srt`/`.vtt`.
- Text-to-speech generation as a separate tool, not required by the runtime.
- Per-stop audio clips for simpler nontechnical editing.

For nontechnical authors, per-stop clips may be easier than one long audio track:

```ts
interface TourStop {
  audioUrl?: string
  autoAdvanceAfterAudio?: boolean
}
```

The first version can support both:

- One continuous track for polished demos.
- Optional stop-level clips for simple authoring.

## Admin/Editor Scaffolding

Avoid building a full admin backend first. Start with an in-app authoring mode and JSON export.

Editor modes:

1. Inspect mode
   - Navigate, select annotations, play tours.

2. Marker edit mode
   - Add/move/delete annotations.
   - Edit label/body/severity.
   - Capture fly-to view.

3. Layer placement mode
   - Move/rotate/scale GLB and splat layers.
   - Numeric transform panel.
   - Toggle local/world/site ENU gizmo.

4. Tour edit mode
   - Create camera path.
   - Add stops.
   - Attach annotations/audio/layer changes.
   - Preview.

Use drei for authoring handles:

- `PivotControls` for object/layer/marker transforms.
- `TransformControls` if it fits better for standard translate/rotate/scale gizmos.
- `Html` for labels and editable affordances.

Use Leva only for developer/debug controls. It is not the product editor for nontechnical users.

## Gravis Earthworks Demo Site

Create a first concrete site definition:

```text
/Users/steffen/Projects/three-geospatial/examples/ocean-globe-waterpro-demo/sites/gravis-earthworks.site.ts
```

Initial scenarios:

1. `earthworks-overview`
   - Establish the jobsite.
   - Show terrain/design/splat layers.
   - Mark work boundary, haul route, and active machine zone.

2. `autonomy-context`
   - Focus on machine operating envelope.
   - Show no-go zones, machine planned path, and current task area.
   - Use annotations for perception context, site constraints, and safety envelope.

3. `progress-review`
   - Show before/after or design-vs-actual layer controls.
   - Use callouts for cut/fill checkpoint, stockpile, and QA review area.

4. `executive-flyby`
   - A guided tour with audio narrative.
   - 60-90 seconds.
   - Starts with overview, flies to machine context, then safety/productivity callouts, then closes on the reusable platform message.

Initial layers can be placeholders until real Gravis assets exist:

- Existing GLB machinery or construction proxy.
- Existing procedural or demo splat layer.
- Optional local splat capture once available.
- Simple design surface mesh/plane.
- Safety zone polygons.
- Path lines for haul/autonomy routes.

## Implementation Phases

### Phase 1: Site Schema And Static Runtime

- [ ] Add `sites/` folder to the deployed twin example.
- [ ] Define `SiteDefinition`, `SiteLayer`, `SiteScenario`, `SiteAnnotation`, and `SiteTour` types.
- [ ] Convert at least one existing scenario into a site-shaped object without changing behavior.
- [ ] Add `gravis-earthworks.site.ts` with placeholder assets and annotations.
- [ ] Implement helper functions for ENU-to-world transforms.
- [ ] Add basic site/scenario selection in the existing UI.

Verification:

- Existing Karmøy demo still works.
- Gravis site can be selected.
- Site scenarios can toggle layer visibility.
- Types make it hard to add a layer without a transform and id.

### Phase 2: Data-Driven Layer Runtime

- [ ] Implement `SiteRuntime`.
- [ ] Render model layers from site definitions.
- [ ] Render splat layers from site definitions, replacing the procedural-only `SplatLayer` path.
- [ ] Render simple design/safety geometry layers.
- [ ] Add layer toggles to `DigitalTwinUI` or a new `TwinViewerChrome`.
- [ ] Add URL state for `site`, `scenario`, and `viewpoint`.

Verification:

- A site can show multiple models and multiple splats.
- Switching scenarios changes visible layers.
- Shareable URLs restore site/scenario/viewpoint state.

### Phase 3: Annotation Layer And Marker Editing

- [ ] Implement `AnnotationLayer`.
- [ ] Render marker icons/labels in world space.
- [ ] Select marker and open an annotation panel.
- [ ] Fly camera to marker view.
- [ ] Add marker edit mode with place/move/delete.
- [ ] Add "capture current camera as marker view."
- [ ] Add JSON export of updated annotations.

Verification:

- Markers stay anchored correctly while orbiting and in FPS mode.
- Marker fly-to is stable and repeatable.
- Exported annotation JSON can be pasted back into the site file and works.

### Phase 4: Fullscreen And Reusable Viewer Chrome

- [ ] Extract fullscreen button and resize sync into reusable helper/component.
- [ ] Create `TwinViewerChrome` wrapper for site/scenario/layer/annotation/tour controls.
- [ ] Migrate existing camera/scenario controls incrementally rather than rewriting all panels at once.
- [ ] Keep contextual cards modular: conditions, telemetry, AIS, progress, safety, etc.

Verification:

- Browser fullscreen and OS fullscreen preserve canvas resolution.
- Controls do not block pointer interaction except where intended.
- Existing contextual panels still work.

### Phase 5: Tour Runtime

- [ ] Add `@huma/path-creator` as a workspace dependency or vendor the required package after reviewing compatibility.
- [ ] Add geospatial adapters: `SiteTour.path` ENU coordinates -> `VertexPath` -> world camera transform.
- [ ] Implement `TourPlayer`.
- [ ] Support play/pause/scrub.
- [ ] Drive camera along path.
- [ ] Trigger stops/callouts/layer overrides.
- [ ] Sync continuous audio track and transcript.
- [ ] Add per-stop audio clip support if needed.

Verification:

- Executive flyby plays deterministically.
- Scrubbing updates camera, callouts, layers, and audio.
- Tour can pause at stops and resume.
- Tour works in fullscreen.

### Phase 6: Tour Authoring For Nontechnical Users

- [ ] Implement `TourEditor` mode.
- [ ] Add path point at current camera.
- [ ] Move path points with `PivotControls`.
- [ ] Add/edit stops on a timeline.
- [ ] Attach annotations to stops.
- [ ] Upload or record audio.
- [ ] Add transcript/captions.
- [ ] Preview from current time or stop.
- [ ] Export tour JSON.

Verification:

- A nondeveloper can create a basic 60-second flyby without editing code.
- Exported tour JSON can be committed or later persisted.
- Editing does not require Leva or devtools.

### Phase 7: Optional Theatre.js Bridge

- [ ] Evaluate Theatre.js after the canonical `SiteTour` model works.
- [ ] Prototype import/export between `SiteTour` and Theatre camera tracks.
- [ ] Decide whether Theatre adds enough value for cinematic polish.
- [ ] Keep Theatre state optional and never required for normal site playback.

Verification:

- Site tours still play without Theatre.js.
- Theatre-enhanced tours degrade to canonical path/stops or clearly require the advanced editor.

## Technical Risks

1. Independent splat layers may composite incorrectly when captures overlap.
   Mitigation: accept for non-overlapping MVP; design `SplatGroupLayer` and global sorting for overlapping captures.

2. Site-local authoring may drift from geospatial truth.
   Mitigation: all editable positions live in ENU under a WGS84 anchor; provide numeric panels and export exact values.

3. Nontechnical authoring could become too much like developer tooling.
   Mitigation: Leva remains debug-only; product editor uses domain language: marker, stop, narration, layer, flyby.

4. Theatre.js could hijack the data model.
   Mitigation: canonical `SiteTour` remains the source of truth. Theatre.js is an optional bridge.

5. Path-Creator package may not be production-ready enough.
   Mitigation: reuse its core/runtime first, not the whole demo UX. Stabilize only the APIs needed for tours.

6. Fullscreen/WebGPU resize issues can recur.
   Mitigation: extract and test the existing resize sync logic before adding more fullscreen entry points.

## Open Questions

- Where should authored site JSON live long-term: committed TypeScript, JSON files, CMS, S3, database, or project workspace?
- Do nontechnical authors need browser-based publishing, or is JSON export enough for the next demo cycle?
- Should tours be continuous audio-first narratives, stop-based clips, or both?
- What real Gravis assets can we use: machine GLBs, site scans, design surfaces, telemetry samples, or anonymized demo data?
- Should `gravis-earthworks` live in the ocean-globe demo initially, or should it become a separate example app once the schema is proven?

## Recommended Next Step

Start with Phase 1 and Phase 2 together in a narrow vertical slice:

1. Add `gravis-earthworks.site.ts`.
2. Implement `SiteRuntime` enough to render model layers, the existing procedural/demo splat layer, simple geometry overlays, and annotations.
3. Add URL state: `?site=gravis-earthworks&scenario=earthworks-overview`.
4. Add three markers and two viewpoints.
5. Add a basic fullscreen button through reusable chrome.

Do not start with Theatre.js. Do not start with a database. Do not start by porting the entire Path-Creator editor. Get the data model and runtime composition working first; then add marker editing; then add tour playback; then add nontechnical tour authoring.
