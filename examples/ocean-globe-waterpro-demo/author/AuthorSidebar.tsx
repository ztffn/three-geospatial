// The author workspace sidebar, mirroring the product's model exactly: a flat
// list of scenarios (same entries and order as the visitor scenario panel),
// and the selected scenario's children — Views (with capture) and Slideshows.
// Click a row to select/fly, double-click to rename authored rows. Location
// is never asked for: a new scenario is a name until its first captured view
// pins it where you were looking (anchors/sites are internal bookkeeping the
// authoring hook owns). Annotations/tours later extend the selected scenario.

import {
  memo,
  useEffect,
  useState,
  type ChangeEvent,
  type FC,
  type ReactNode
} from 'react'

import type { RuntimeSlideshowDeck } from '../authoring/types'
import type { AuthorSlotContext } from '../app/TwinExperience'
import { isStaticScenarioId, siteViewExtensions } from '../sites/runtime'
import type { SiteDefinition } from '../sites/types'
import { Card, ChevronIcon as ToggleChevronIcon } from '../ui/DigitalTwinUI'
import { SCENARIOS } from '../ui/scenarios'
import {
  ACCENT,
  authorGlobalCss,
  BG,
  BORDER,
  BORDER_FAINT,
  buttonStyle,
  FAINT,
  fieldStyle,
  iconButtonStyle,
  labelStyle,
  MONO,
  MUTED,
  SANS,
  SECONDARY,
  TEXT
} from './theme'
import type { AuthorSessionState } from './useAuthorSession'
import { useSiteAuthoring, type SiteAuthoringState } from './useSiteAuthoring'
import { useSlideshowAdmin } from './useSlideshowAdmin'

function run(promise: Promise<void>): void {
  promise.catch(() => {})
}

// --- tiny inline icons (no icon dep in this demo) -----------------------------

const ChevronIcon: FC<{ dir: 'up' | 'down' }> = ({ dir }) => (
  <svg
    width='10'
    height='10'
    viewBox='0 0 12 12'
    fill='none'
    aria-hidden
    style={{ transform: dir === 'down' ? 'rotate(180deg)' : undefined }}
  >
    <path
      d='M2.5 7.5 6 4l3.5 3.5'
      stroke='currentColor'
      strokeWidth='1.4'
      strokeLinecap='square'
    />
  </svg>
)

const CrossIcon: FC = () => (
  <svg width='10' height='10' viewBox='0 0 12 12' fill='none' aria-hidden>
    <path
      d='M2.5 2.5 9.5 9.5M9.5 2.5 2.5 9.5'
      stroke='currentColor'
      strokeWidth='1.4'
      strokeLinecap='square'
    />
  </svg>
)

// --- building blocks ----------------------------------------------------------

const SubLabel: FC<{ children: ReactNode }> = ({ children }) => (
  <span style={{ ...labelStyle, fontSize: 9 }}>{children}</span>
)

// A lighter-weight collapsible than Card — no glass/blur chrome of its own,
// since it always nests inside one — for grouping a sub-section's content
// (Views, Slideshows, a single deck's slides) behind the same toggle chevron.
const CollapsibleGroup: FC<{
  title: string
  defaultOpen?: boolean
  children: ReactNode
}> = ({ title, defaultOpen = true, children }) => {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <button
        type='button'
        onClick={() => {
          setOpen(o => !o)
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: 0,
          background: 'transparent',
          border: 'none',
          color: MUTED,
          cursor: 'pointer'
        }}
      >
        <ToggleChevronIcon open={open} />
        <SubLabel>{title}</SubLabel>
      </button>
      {open && children}
    </div>
  )
}

const ErrorLine: FC<{ message: string | null }> = ({ message }) =>
  message == null ? null : (
    <p style={{ margin: 0, color: ACCENT, fontSize: 11, lineHeight: 1.4 }}>
      {message}
    </p>
  )

const smallButtonStyle = { ...buttonStyle, height: 24, fontSize: 10 }

// One row of the tree: click selects (and flies), double-click renames when
// editable, × deletes. The active row is highlighted; a mono tag on the right
// notes state where it matters.
const NavRow: FC<{
  label: string
  active: boolean
  tag?: string
  indent?: boolean
  onSelect: () => void
  onRename?: (label: string) => void
  onDelete?: () => void
  deleteTitle?: string
}> = ({ label, active, tag, indent, onSelect, onRename, onDelete, deleteTitle }) => {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(label)
  useEffect(() => {
    setDraft(label)
  }, [label])

  const commit = (): void => {
    setEditing(false)
    if (onRename != null && draft.trim() !== label) onRename(draft)
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        marginLeft: indent ? 12 : 0
      }}
    >
      {editing && onRename != null ? (
        <input
          className='au-input'
          value={draft}
          autoFocus
          onChange={event => {
            setDraft(event.currentTarget.value)
          }}
          onBlur={commit}
          onKeyDown={event => {
            if (event.key === 'Enter') commit()
            if (event.key === 'Escape') {
              setDraft(label)
              setEditing(false)
            }
          }}
          style={{ ...fieldStyle, flex: 1, height: 26, fontSize: 11 }}
        />
      ) : (
        <button
          type='button'
          className='au-btn'
          title={
            onRename != null
              ? 'Click to fly · double-click to rename'
              : 'Click to fly'
          }
          onClick={onSelect}
          onDoubleClick={
            onRename != null
              ? () => {
                  setEditing(true)
                }
              : undefined
          }
          style={{
            ...buttonStyle,
            flex: 1,
            height: 26,
            padding: '0 8px',
            justifyContent: 'space-between',
            border: active ? BORDER : BORDER_FAINT,
            background: active ? 'rgba(255,255,255,0.06)' : 'transparent',
            color: active ? TEXT : SECONDARY,
            fontSize: 11,
            fontWeight: active ? 600 : 400
          }}
        >
          <span
            style={{
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
          >
            {label}
          </span>
          {tag != null && (
            <span
              style={{
                flex: '0 0 auto',
                fontFamily: MONO,
                fontSize: 9,
                color: FAINT
              }}
            >
              {tag}
            </span>
          )}
        </button>
      )}
      {onDelete != null && (
        <button
          type='button'
          className='au-btn au-danger'
          title={deleteTitle ?? 'Delete'}
          onClick={onDelete}
          style={{ ...iconButtonStyle, height: 26 }}
        >
          <CrossIcon />
        </button>
      )}
    </div>
  )
}

// --- sidebar ------------------------------------------------------------------

// memo: TwinExperience re-renders every frame during camera motion (liveZoom)
// and passes a memoized ctx — memo keeps that churn out of the sidebar tree.
const AuthorSidebarImpl: FC<{
  ctx: AuthorSlotContext
  session: AuthorSessionState
}> = ({ ctx, session }) => {
  const authoring = useSiteAuthoring(ctx.sites)
  const [newScenarioLabel, setNewScenarioLabel] = useState('')

  const activeStatic =
    SCENARIOS.find(s => s.id === ctx.activeScenarioId) ?? null
  const activeAuthored = authoring.authoredScenario(ctx.activeScenarioId)
  const activePending = authoring.pending.find(
    p => p.id === ctx.activeScenarioId
  )
  const activeLabel =
    activeStatic?.label ?? activeAuthored?.scenario.label ?? activePending?.label

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: BG,
        borderRight: BORDER,
        color: TEXT,
        fontFamily: SANS
      }}
    >
      <style>{authorGlobalCss}</style>

      {/* One functional row: what this panel is + the session action. */}
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          padding: '12px 16px',
          borderBottom: BORDER
        }}
      >
        <span style={labelStyle}>Authoring</span>
        <button
          type='button'
          className='au-btn'
          title='End the authoring session'
          onClick={() => {
            run(session.logout())
          }}
          style={{ ...buttonStyle, height: 24, fontSize: 10 }}
        >
          Logout
        </button>
      </header>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {/* The same flat catalogue the visitor panel shows, same order. */}
        <Card title='Scenarios' interactive gap={6}>
          {ctx.scenarios.list.map(scenario => {
            const authored = !isStaticScenarioId(scenario.id)
            return (
              <NavRow
                key={scenario.id}
                label={scenario.label}
                active={scenario.id === ctx.activeScenarioId}
                tag={authored ? 'authored' : undefined}
                onSelect={() => {
                  ctx.scenarios.select(scenario.id)
                }}
                onRename={
                  authored
                    ? value => {
                        run(authoring.renameScenario(scenario.id, value))
                      }
                    : undefined
                }
                onDelete={
                  authored
                    ? () => {
                        run(
                          authoring.deleteScenario(scenario.id).then(() => {
                            ctx.scenarios.select(ctx.scenarios.list[0].id)
                          })
                        )
                      }
                    : undefined
                }
                deleteTitle='Delete scenario and its views'
              />
            )
          })}
          {/* Created but not yet captured: a name waiting for its first view
              (hidden from visitors until it has one). */}
          {authoring.pending.map(scenario => (
            <NavRow
              key={scenario.id}
              label={scenario.label}
              active={scenario.id === ctx.activeScenarioId}
              tag='no views'
              onSelect={() => {
                ctx.scenarios.select(scenario.id)
              }}
              onRename={value => {
                run(authoring.renameScenario(scenario.id, value))
              }}
              onDelete={() => {
                run(
                  authoring.deleteScenario(scenario.id).then(() => {
                    ctx.scenarios.select(ctx.scenarios.list[0].id)
                  })
                )
              }}
              deleteTitle='Delete scenario'
            />
          ))}
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              className='au-input'
              value={newScenarioLabel}
              onChange={event => {
                setNewScenarioLabel(event.currentTarget.value)
              }}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  authoring.addScenario(newScenarioLabel)
                  setNewScenarioLabel('')
                }
              }}
              placeholder='New scenario name'
              style={{ ...fieldStyle, flex: 1, height: 26, fontSize: 11 }}
            />
            <button
              type='button'
              className='au-btn'
              onClick={() => {
                authoring.addScenario(newScenarioLabel)
                setNewScenarioLabel('')
              }}
              style={{ ...smallButtonStyle, height: 26 }}
            >
              Add
            </button>
          </div>
          <ErrorLine message={authoring.error} />
        </Card>

        {ctx.activeScenarioId != null && activeLabel != null && (
          <SelectedScenarioSection
            ctx={ctx}
            authoring={authoring}
            scenarioId={ctx.activeScenarioId}
            label={activeLabel}
          />
        )}
      </div>

      <footer
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          padding: '12px 16px',
          borderTop: BORDER
        }}
      >
        <a className='au-link' href='/' style={{ fontSize: 11 }}>
          View as visitor →
        </a>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            minWidth: 0
          }}
        >
          {/* Save feedback: mutations persist immediately; this shows when. */}
          {ctx.sites.updatedAt != null && (
            <span
              title='All changes save to the server as you make them'
              style={{ fontFamily: MONO, fontSize: 10, color: FAINT }}
            >
              saved{' '}
              {new Date(ctx.sites.updatedAt).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit'
              })}
            </span>
          )}
          <button
            type='button'
            title='Download all authored data as JSON (developer escape hatch)'
            onClick={() => {
              exportSitesJson(authoring.effectiveSites)
            }}
            style={{
              padding: 0,
              border: 'none',
              background: 'none',
              cursor: 'pointer',
              fontFamily: SANS,
              fontSize: 11,
              color: MUTED
            }}
            className='au-link'
          >
            Export
          </button>
        </span>
      </footer>
    </div>
  )
}

export const AuthorSidebar = memo(AuthorSidebarImpl)

// --- selected scenario: views + slideshows -------------------------------------

const SelectedScenarioSection: FC<{
  ctx: AuthorSlotContext
  authoring: SiteAuthoringState
  scenarioId: string
  label: string
}> = ({ ctx, authoring, scenarioId, label }) => {
  const admin = useSlideshowAdmin(ctx.slideshows.refresh)
  const [newDeckLabel, setNewDeckLabel] = useState('')
  const [captureError, setCaptureError] = useState<string | null>(null)

  const staticScenario = SCENARIOS.find(s => s.id === scenarioId) ?? null
  const authored = authoring.authoredScenario(scenarioId)
  const isPending = authoring.pending.some(p => p.id === scenarioId)

  // A static scenario's authored views (extensions) live in its host site.
  const hostSite =
    staticScenario != null ? authoring.hostSiteOf(staticScenario) : undefined
  const extensions =
    staticScenario != null && hostSite != null
      ? siteViewExtensions(staticScenario, hostSite)
      : []
  const authoredViews = authored?.scenario.viewpoints ?? extensions
  const viewCount =
    (staticScenario?.viewpoints.length ?? 0) + authoredViews.length

  // Reset capture feedback when the scenario changes.
  useEffect(() => {
    setCaptureError(null)
  }, [scenarioId])

  // The effective environment override (static default + authored override
  // already merged — see composeScenarioCatalogue) — the same object
  // TwinExperience reads to drive the scene, so this reflects what's
  // actually live, not just what this scenario authored on its own.
  const environment =
    ctx.scenarios.list.find(s => s.id === scenarioId)?.environment ?? null
  const pinEnabled = environment?.timeOfDayHour != null
  const ignoreWeather = environment?.ignoreWeather ?? false
  const applyEnvironment = (
    next: Partial<{ timeOfDayHour: number | undefined; ignoreWeather: boolean }>
  ): void => {
    const merged = { ...environment, ...next }
    const cleared = merged.timeOfDayHour == null && !merged.ignoreWeather
    run(authoring.setEnvironment(scenarioId, cleared ? null : merged))
  }

  return (
    <Card title='Selected scenario' interactive gap={12}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 8
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600 }}>{label}</span>
        {staticScenario != null && (
          <span
            title='Defined in ui/scenarios.ts — its built-in views are code; captured views are yours'
            style={{ fontFamily: MONO, fontSize: 10, color: FAINT }}
          >
            built-in
          </span>
        )}
      </div>

      <CollapsibleGroup title='Environment' defaultOpen={false}>
        {isPending ? (
          <span style={{ fontSize: 10, color: MUTED, marginLeft: 12 }}>
            Fly somewhere and capture the first view before setting this.
          </span>
        ) : (
          <>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 11,
                color: TEXT,
                cursor: 'pointer'
              }}
            >
              <input
                type='checkbox'
                checked={ignoreWeather}
                onChange={event => {
                  applyEnvironment({ ignoreWeather: event.currentTarget.checked })
                }}
              />
              Ignore live weather
            </label>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 11,
                color: TEXT,
                cursor: 'pointer'
              }}
            >
              <input
                type='checkbox'
                checked={pinEnabled}
                onChange={event => {
                  applyEnvironment({
                    timeOfDayHour: event.currentTarget.checked ? 12 : undefined
                  })
                }}
              />
              Pin time of day
              {pinEnabled && (
                <input
                  type='number'
                  min={0}
                  max={24}
                  step={0.5}
                  value={environment?.timeOfDayHour ?? 12}
                  onClick={event => {
                    event.stopPropagation()
                  }}
                  onChange={event => {
                    const hour = event.currentTarget.valueAsNumber
                    if (Number.isFinite(hour)) applyEnvironment({ timeOfDayHour: hour })
                  }}
                  className='au-input'
                  style={{ ...fieldStyle, width: 56, height: 22, fontSize: 11 }}
                />
              )}
            </label>
            <ErrorLine message={authoring.error} />
          </>
        )}
      </CollapsibleGroup>

      <CollapsibleGroup title='Views'>
        {staticScenario?.viewpoints.map(viewpoint => (
          <NavRow
            key={viewpoint.id}
            indent
            label={viewpoint.label}
            active={viewpoint.id === ctx.activeViewpointId}
            onSelect={() => {
              ctx.scenarios.selectView(scenarioId, viewpoint.id)
            }}
          />
        ))}
        {authoredViews.map(viewpoint => (
          <NavRow
            key={viewpoint.id}
            indent
            label={viewpoint.label}
            tag={staticScenario != null ? 'authored' : undefined}
            active={viewpoint.id === ctx.activeViewpointId}
            onSelect={() => {
              ctx.scenarios.selectView(scenarioId, viewpoint.id)
            }}
            onRename={value => {
              run(authoring.renameViewpoint(scenarioId, viewpoint.id, value))
            }}
            onDelete={() => {
              run(authoring.deleteViewpoint(scenarioId, viewpoint.id))
            }}
            deleteTitle='Delete view'
          />
        ))}
        {viewCount === 0 && (
          <span style={{ fontSize: 10, color: MUTED, marginLeft: 12 }}>
            No views yet — hidden from visitors until it has one.
            {isPending && ' Fly somewhere and capture the first view.'}
          </span>
        )}

        <button
          type='button'
          className='au-btn'
          disabled={authoring.saving}
          title='Frame the shot in the scene (orbit mode), then click to save it as a view'
          onClick={() => {
            const pose = ctx.getCameraPose()
            if (pose == null) {
              setCaptureError(
                'Orbit camera required — switch out of first-person.'
              )
              return
            }
            setCaptureError(null)
            // captureViewpoint owns anchoring (nearest/minted for a first
            // capture) and the views-coherence guard; it throws the reason.
            authoring
              .captureViewpoint(scenarioId, pose, `View ${viewCount + 1}`)
              .catch((err: unknown) => {
                setCaptureError(
                  err instanceof Error ? err.message : 'capture failed'
                )
              })
          }}
          style={smallButtonStyle}
        >
          Capture current view
        </button>
        <ErrorLine message={captureError} />
      </CollapsibleGroup>

      <CollapsibleGroup title='Slideshows'>
        {ctx.slideshows.decks.length === 0 && (
          <span style={{ fontSize: 10, color: MUTED, marginLeft: 12 }}>
            No slideshows yet for this scenario.
          </span>
        )}
        {ctx.slideshows.decks.map(deck => (
          <DeckCard
            key={deck.id}
            deck={deck}
            scenarioId={scenarioId}
            decks={ctx.slideshows.decks}
            admin={admin}
            onPreview={() => {
              ctx.slideshows.openDeck(deck.id)
            }}
          />
        ))}
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            className='au-input'
            value={newDeckLabel}
            onChange={event => {
              setNewDeckLabel(event.currentTarget.value)
            }}
            placeholder='New slideshow name'
            style={{ ...fieldStyle, flex: 1, height: 26, fontSize: 11 }}
          />
          <button
            type='button'
            className='au-btn'
            onClick={() => {
              run(admin.createDeck(scenarioId, newDeckLabel))
              setNewDeckLabel('')
            }}
            style={{ ...smallButtonStyle, height: 26 }}
          >
            Add
          </button>
        </div>
        <ErrorLine message={admin.error} />
      </CollapsibleGroup>
    </Card>
  )
}

// --- deck card ----------------------------------------------------------------

const DeckCard: FC<{
  deck: RuntimeSlideshowDeck
  scenarioId: string
  decks: RuntimeSlideshowDeck[]
  admin: ReturnType<typeof useSlideshowAdmin>
  onPreview: () => void
}> = ({ deck, scenarioId, decks, admin, onPreview }) => {
  const [label, setLabel] = useState(deck.label)
  const [title, setTitle] = useState('')
  const [open, setOpen] = useState(false)

  useEffect(() => {
    setLabel(deck.label)
  }, [deck.label])

  // .html/.jsx/.tsx files carry no upload — their text content becomes the
  // slide's inline `code` (see addCodeSlide). Everything else is the
  // existing media upload.
  const handleUpload = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (file == null) return
    if (/\.(jsx|tsx|html?)$/i.test(file.name)) {
      const type = /\.(jsx|tsx)$/i.test(file.name) ? 'jsx' : 'html'
      file.text().then(code => {
        run(admin.addCodeSlide(deck.id, { type, code, title }))
      })
    } else {
      run(admin.uploadSlide(deck.id, file, title))
    }
    setTitle('')
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: 12,
        border: BORDER
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          type='button'
          className='au-btn'
          onClick={() => {
            setOpen(o => !o)
          }}
          title={open ? 'Collapse' : 'Expand'}
          style={iconButtonStyle}
        >
          <ToggleChevronIcon open={open} />
        </button>
        <input
          className='au-input'
          value={label}
          onChange={event => {
            setLabel(event.currentTarget.value)
          }}
          onBlur={() => {
            if (label !== deck.label) run(admin.patchDeck(deck.id, { label }))
          }}
          aria-label='Slideshow name'
          style={{ ...fieldStyle, flex: 1, fontWeight: 600 }}
        />
        <span
          style={{
            fontFamily: MONO,
            fontSize: 10,
            color: FAINT,
            flex: '0 0 auto'
          }}
        >
          {deck.slides.length}
        </span>
      </div>

      {open && deck.slides.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {deck.slides.map(slide => (
            <div
              key={slide.id}
              style={{ display: 'flex', alignItems: 'center', gap: 6 }}
            >
              <span
                style={{
                  fontFamily: MONO,
                  fontSize: 9,
                  color: FAINT,
                  width: 30,
                  flex: '0 0 auto',
                  textTransform: 'uppercase'
                }}
              >
                {slide.type === 'video'
                  ? 'vid'
                  : slide.type === 'image'
                    ? 'img'
                    : slide.type}
              </span>
              <input
                className='au-input'
                defaultValue={slide.title ?? ''}
                onBlur={event => {
                  run(
                    admin.patchSlide(deck.id, slide.id, {
                      title: event.currentTarget.value
                    })
                  )
                }}
                placeholder='Slide title'
                style={{ ...fieldStyle, flex: 1, height: 24, fontSize: 11 }}
              />
              <button
                type='button'
                className='au-btn'
                title='Move up'
                onClick={() => {
                  run(admin.moveSlide(deck, slide.id, -1))
                }}
                style={iconButtonStyle}
              >
                <ChevronIcon dir='up' />
              </button>
              <button
                type='button'
                className='au-btn'
                title='Move down'
                onClick={() => {
                  run(admin.moveSlide(deck, slide.id, 1))
                }}
                style={iconButtonStyle}
              >
                <ChevronIcon dir='down' />
              </button>
              <button
                type='button'
                className='au-btn au-danger'
                title='Delete slide'
                onClick={() => {
                  run(admin.deleteSlide(deck.id, slide.id))
                }}
                style={iconButtonStyle}
              >
                <CrossIcon />
              </button>
            </div>
          ))}
        </div>
      )}

      {open && (
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            className='au-input'
            value={title}
            onChange={event => {
              setTitle(event.currentTarget.value)
            }}
            placeholder='Next slide title (optional)'
            style={{ ...fieldStyle, flex: 1, height: 24, fontSize: 11 }}
          />
          <label className='au-btn' style={smallButtonStyle}>
            Upload
            <input
              type='file'
              accept='image/jpeg,image/png,image/webp,image/gif,image/avif,video/mp4,.html,.htm,.jsx,.tsx'
              onChange={handleUpload}
              style={{ display: 'none' }}
            />
          </label>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <button
          type='button'
          className='au-btn'
          onClick={onPreview}
          style={smallButtonStyle}
        >
          Preview
        </button>
        <button
          type='button'
          className='au-btn'
          title='Move deck up'
          onClick={() => {
            run(admin.moveDeck(scenarioId, decks, deck.id, -1))
          }}
          style={iconButtonStyle}
        >
          <ChevronIcon dir='up' />
        </button>
        <button
          type='button'
          className='au-btn'
          title='Move deck down'
          onClick={() => {
            run(admin.moveDeck(scenarioId, decks, deck.id, 1))
          }}
          style={iconButtonStyle}
        >
          <ChevronIcon dir='down' />
        </button>
        <span style={{ flex: 1 }} />
        <button
          type='button'
          className='au-btn au-danger'
          title='Delete deck and its media'
          onClick={() => {
            run(admin.deleteDeck(deck.id))
          }}
          style={{ ...smallButtonStyle, color: MUTED }}
        >
          Delete
        </button>
      </div>
    </div>
  )
}

// Download the effective (server-or-seed) SiteDefinitions as pretty JSON —
// the plan's export/import escape hatch alongside the server manifest.
function exportSitesJson(sites: readonly SiteDefinition[]): void {
  const blob = new Blob([JSON.stringify({ sites }, null, 2)], {
    type: 'application/json'
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = 'twin.sites.json'
  link.click()
  URL.revokeObjectURL(url)
}
