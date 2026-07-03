# Modal Slideshow And Authoring Storage Plan

## Objective

Add scenario-scoped modal slideshow functionality to the Humatopia World Twin
without further coupling the 3D runtime, viewer chrome, and admin tooling.

This feature is intentionally the first small slice of a future authoring
dashboard. The immediate user-facing need is simple:

- Each scenario can expose zero or more slideshows.
- A slideshow can contain images and MP4 videos.
- Viewer controls are previous, next, close, and deck selection.
- Video playback stops when changing slide, closing the modal, or leaving the
  scenario.
- A hidden admin affordance can create, remove, rename, enable/disable, and
  reorder slideshows and slides.

The longer-term constraint matters: the code should move us toward a
data-driven site/scenario authoring model, not deeper into bespoke `main.tsx`
state and one-off UI flags.

## Relevant Context

Current twin surfaces:

- `examples/ocean-globe-waterpro-demo/main.tsx`
  Owns active scenario/viewpoint state, camera commands, runtime toggles, and
  passes UI state into `DigitalTwinUI`.
- `examples/ocean-globe-waterpro-demo/ui/scenarios.ts`
  Static scenario/viewpoint catalogue with per-scenario settings ids.
- `examples/ocean-globe-waterpro-demo/ui/DigitalTwinUI.tsx`
  Presentational overlay with scenario panel and existing setting toggles.
- `examples/ocean-globe-waterpro-demo/server/index.ts`
  Production Node server for static SPA plus same-origin API/proxy routes.
- `examples/ocean-globe-waterpro-demo/vite.config.ts`
  Dev-server middleware mirror for production API/proxy routes.

Related longer-term plan:

- `plans/2026-06-23-gravis-earthworks-site-scenario-authoring-plan.md`
  Defines a future `SiteDefinition` direction with scenarios, layers,
  annotations, tours, authoring modes, and JSON-first authoring.

Reusable pattern from Humatopia frontend:

- `/Users/steffen/Projects/huma/humatopia-frontend/src/lib/storage.ts`
  Server-only object storage abstraction with local filesystem fallback and
  S3/SOS-compatible backend.
- `/Users/steffen/Projects/huma/humatopia-frontend/src/server/slide-images.ts`
  Media upload/retrieve helper backed by that storage layer.

Use the storage pattern, not the whole frontend stack. Do not port TanStack
server routes, Drizzle sessions, or ZITADEL auth into this Vite/Node twin for
the first pass.

## Product Decisions

### Multiple Decks Per Scenario

Each scenario can have multiple slideshow decks. A single boolean setting is
too limiting and creates the wrong mental model. The viewer should choose a
specific deck, for example "Overview", "Installation Steps", or "Evidence".

The static `Scenario` catalogue may optionally declare which scenarios should
show the deck launcher, but the canonical deck/slides data should live in the
authoring manifest:

```ts
interface Scenario {
  id: string
  label: string
  slideshowIds?: string[]
}
```

Do not embed uploaded slide lists directly in `SCENARIOS`.

### Authoring Boundary

Create an `authoring` module in the twin example:

```text
examples/ocean-globe-waterpro-demo/authoring/
  types.ts
  storage.ts
  slideshowStore.ts
  api.ts
```

Responsibilities:

- Define manifest, slideshow, slide, and media types.
- Read/write JSON authoring data.
- Store/retrieve uploaded media objects.
- Validate MIME types, object keys, and reorder payloads.
- Provide handlers reusable from both production server and Vite dev middleware.

React components should call API routes and consume typed data. The 3D scene
should receive only clean runtime state such as active scenario id and active
slideshow id.

### Viewer/Admin Split

Viewer-facing UI and admin-facing UI are separate:

```text
viewer UI:
  SlideshowDeckLauncher
  SlideshowModal

admin UI:
  AuthoringPanel
  SlideshowAdmin
  MediaUploader
```

Shared types are fine. Shared component state is not.

The modal is runtime-facing and should stay simple. The admin panel edits the
authoring manifest and media store.

### Storage

Use a small local storage abstraction from the start, modelled after Huma's
`lib/storage.ts`:

- `putObject`
- `getObject`
- `deleteObject`
- `listObjects`
- `putJson`
- `getJson`

Initial backend:

- local filesystem rooted at `TWIN_STORAGE_ROOT`
- default root for dev: `examples/ocean-globe-waterpro-demo/.local/authoring`
- production Docker volume can mount `/data`

S3/SOS backend can be implemented in the same abstraction either in V1 if
configuration is already available, or as a direct follow-up. The API and UI
must not assume local files.

Logical stores:

```text
twin-authoring
twin-media
```

Suggested keys:

```text
twin-authoring/manifest.json
twin-media/slideshows/<deckId>/<mediaId>.<ext>
```

### Auth

Do not implement full ZITADEL in this slice.

Use a narrow admin guard:

```text
TWIN_ADMIN_TOKEN=...
Authorization: Bearer <token>
```

Keep the guard function shaped so it can later accept a Caddy/ZITADEL
`forward_auth` header:

```text
X-Huma-User-Sub
```

Runtime read routes remain public. Mutation routes require admin auth.

## Data Model

Canonical authoring manifest:

```ts
export interface SiteContentManifest {
  version: 1
  updatedAt: string
  slideshows: SlideshowDeck[]
}

export interface SlideshowDeck {
  id: string
  scenarioId: string
  label: string
  enabled: boolean
  order: number
  slides: SlideshowSlide[]
  createdAt: string
  updatedAt: string
}

export interface SlideshowSlide {
  id: string
  type: 'image' | 'video'
  objectKey: string
  mimeType: string
  title?: string
  order: number
  createdAt: string
}
```

Runtime shape returned to the client:

```ts
export interface RuntimeSlideshowDeck {
  id: string
  scenarioId: string
  label: string
  order: number
  slides: RuntimeSlideshowSlide[]
}

export interface RuntimeSlideshowSlide {
  id: string
  type: 'image' | 'video'
  src: string
  title?: string
  order: number
}
```

The server maps `objectKey` to stable media URLs. The client never constructs
storage paths directly.

## API Shape

Public read routes:

```text
GET /api/authoring/manifest
GET /api/authoring/scenarios/:scenarioId/slideshows
GET /api/authoring/media/:key
```

Admin mutation routes:

```text
POST   /api/authoring/slideshows
PATCH  /api/authoring/slideshows/:deckId
DELETE /api/authoring/slideshows/:deckId

POST   /api/authoring/slideshows/:deckId/slides
PATCH  /api/authoring/slideshows/:deckId/slides/:slideId
DELETE /api/authoring/slideshows/:deckId/slides/:slideId

PATCH  /api/authoring/scenarios/:scenarioId/slideshow-order
PATCH  /api/authoring/slideshows/:deckId/slide-order
```

Upload route:

```text
POST /api/authoring/slideshows/:deckId/slides
```

Accepts `multipart/form-data` with `file` and optional `title`.

Allowed types:

- `image/jpeg`
- `image/png`
- `image/webp`
- `image/gif`
- `image/avif`
- `video/mp4`

Start with a conservative upload cap:

- images/videos: 50 MB

This can be split later if MP4 assets need a larger cap.

## UI Behavior

### Deck Launcher

For the active scenario, show enabled decks in the scenario panel below
viewpoints and existing settings.

Behavior:

- If no decks exist, show nothing for normal viewers.
- If admin mode is active, show an empty-state affordance to create the first
  deck.
- Clicking a deck opens the modal with that deck selected.
- Opening a second deck closes/replaces the first.

### Modal

The modal displays one slide at a time:

- image slides render with `object-fit: contain`
- video slides render as `<video controls playsInline>`
- previous/next buttons wrap within the deck
- escape closes
- left/right arrow keys navigate
- close button closes and clears active deck

Video lifecycle:

- On slide change, pause the old video and reset `currentTime` to `0`.
- On modal close, pause/reset the active video.
- On scenario change, close modal and pause/reset active video.
- On deck change, pause/reset before mounting the new slide.

### Admin Panel

Hidden admin affordance:

- initially use a small icon-only button in the scenario panel or modal
- require entering/supplying the admin token before mutations
- do not show admin controls to normal viewers

V1 admin functions:

- create deck for active scenario
- rename deck
- enable/disable deck
- reorder decks with up/down buttons
- delete deck
- upload slide
- edit slide title
- reorder slides with up/down buttons
- delete slide

Do not build drag/drop reorder in V1. Up/down controls are predictable and
lower risk.

## Runtime State Boundaries

`main.tsx` should own only minimal runtime state:

```ts
const [activeSlideshowId, setActiveSlideshowId] = useState<string | null>(null)
const [slideshowOpen, setSlideshowOpen] = useState(false)
```

When selecting a new scenario:

```ts
setSlideshowOpen(false)
setActiveSlideshowId(null)
```

The slideshow components should handle video cleanup internally, with the
scenario change closing the modal as the parent-level guarantee.

Avoid adding upload/reorder/storage logic to `main.tsx`.

## Implementation Phases

### Phase 1: Authoring Types And Storage

- Add `authoring/types.ts`.
- Add local-first `authoring/storage.ts`.
- Add `authoring/slideshowStore.ts`.
- Implement manifest defaults and schema normalization.
- Add unit tests for ordering, default manifest creation, and key validation.

Acceptance:

- Empty storage returns a valid manifest.
- Creating, updating, reordering, and deleting decks is deterministic.
- Slide reorder produces dense `order` values.

### Phase 2: Server API

- Add shared route handlers in `authoring/api.ts`.
- Mount handlers in production `server/index.ts`.
- Mount the same handlers in Vite dev middleware.
- Add admin token guard for mutation routes.
- Add media streaming route with correct content type and cache headers.

Acceptance:

- Dev and production server expose the same API behavior.
- Public reads work without admin token.
- Mutations fail without admin token when `TWIN_ADMIN_TOKEN` is set.
- Upload rejects unsupported file types.

### Phase 3: Viewer UI

- Add `useScenarioSlideshows`.
- Add `SlideshowDeckLauncher`.
- Add `SlideshowModal`.
- Wire launcher into `DigitalTwinUI` without moving scenario selection logic.
- Wire minimal slideshow state in `main.tsx`.
- Close slideshow on scenario switch.

Acceptance:

- Scenario with decks shows deck launcher.
- Clicking a deck opens modal.
- Prev/next works for images and videos.
- Video stops on slide change, close, and scenario change.

### Phase 4: Hidden Admin UI

- Add `AuthoringPanel` or `SlideshowAdmin`.
- Add token prompt/local session storage for admin token.
- Add create/rename/delete/reorder deck flows.
- Add upload/delete/reorder/edit-title slide flows.
- Refresh manifest after successful mutations.

Acceptance:

- Admin can manage multiple decks per scenario.
- Admin can manage slide order and media.
- Normal viewer path is unaffected when admin is closed.

### Phase 5: Deployment Hardening

- Add `TWIN_STORAGE_ROOT` and `TWIN_ADMIN_TOKEN` env documentation.
- Update Docker/compose to mount persistent storage if deploying admin.
- Optionally add SOS env support if object storage is ready.
- Add a small backup/export path for the manifest.

Acceptance:

- Uploads survive container restart/recreate when a volume is mounted.
- Missing admin token cannot accidentally expose mutation routes in production.

## Verification Plan

Automated:

- Vitest tests for authoring store ordering and manifest normalization.
- Unit tests for content-type/extension validation.
- Component-level test for video cleanup if practical.

Manual:

- Start `pnpm run dev:globe-waterpro`.
- Create two decks for one scenario.
- Upload one image and one MP4.
- Reorder decks.
- Reorder slides.
- Open deck, navigate image -> video -> image.
- Confirm video pauses/resets when leaving the video slide.
- Switch scenario while video is playing.
- Confirm modal closes and audio/video stops.
- Restart dev server and confirm manifest/media persist.

## Explicit Non-Goals For V1

- Full ZITADEL login inside the twin.
- Database-backed authoring.
- Drag/drop reorder.
- Browser video transcoding.
- General tour authoring.
- Annotation editing.
- 3D layer/model placement.
- Splat work.
- A separate full dashboard route unless needed to keep the modal/admin UI clean.

## Future Direction

This feature should become one content type inside a broader authoring system:

```ts
interface SiteScenario {
  id: string
  label: string
  slideshowIds?: string[]
  tourIds?: string[]
  annotationIds?: string[]
  layerOverrides?: Record<string, { visible?: boolean; opacity?: number }>
}
```

The eventual authoring dashboard can then manage:

- slideshows
- tours
- annotations
- media library
- layer visibility
- camera viewpoints
- scenario metadata

The main architectural rule remains: authoring edits content data; viewer and
3D runtime consume content data. They should not become one tangled component.
