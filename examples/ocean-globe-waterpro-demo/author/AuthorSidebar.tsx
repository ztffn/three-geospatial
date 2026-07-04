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
  LIVE,
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

const Section: FC<{
  title: string
  children: ReactNode
}> = ({ title, children }) => (
  <section
    style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
      padding: 16,
      borderBottom: BORDER_FAINT
    }}
  >
    <h2 style={{ ...labelStyle, margin: 0 }}>{title}</h2>
    {children}
  </section>
)

const SubLabel: FC<{ children: ReactNode }> = ({ children }) => (
  <span style={{ ...labelStyle, fontSize: 9 }}>{children}</span>
)

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
        <Section title='Scenarios'>
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
        </Section>

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

  return (
    <Section title='Selected scenario'>
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

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <SubLabel>Views</SubLabel>
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
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <SubLabel>Slideshows</SubLabel>
        {ctx.slideshows.decks.length === 0 && (
          <span style={{ fontSize: 10, color: MUTED, marginLeft: 12 }}>
            No decks yet for this scenario.
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
            placeholder='New deck name'
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
      </div>
    </Section>
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

  useEffect(() => {
    setLabel(deck.label)
  }, [deck.label])

  const handleUpload = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (file == null) return
    run(admin.uploadSlide(deck.id, file, title))
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
        <input
          className='au-input'
          value={label}
          onChange={event => {
            setLabel(event.currentTarget.value)
          }}
          onBlur={() => {
            if (label !== deck.label) run(admin.patchDeck(deck.id, { label }))
          }}
          aria-label='Deck name'
          style={{ ...fieldStyle, flex: 1, fontWeight: 600 }}
        />
        <button
          type='button'
          className='au-btn'
          title={
            deck.enabled
              ? 'Live for visitors — click to unpublish'
              : 'Draft — click to publish'
          }
          onClick={() => {
            run(admin.patchDeck(deck.id, { enabled: !deck.enabled }))
          }}
          style={{
            ...buttonStyle,
            height: 20,
            padding: '0 6px',
            fontSize: 9,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: deck.enabled ? LIVE : MUTED,
            borderColor: deck.enabled ? 'rgba(134, 199, 161, 0.35)' : undefined
          }}
        >
          {deck.enabled ? 'Live' : 'Draft'}
        </button>
      </div>

      {deck.slides.length > 0 && (
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
                  width: 26,
                  flex: '0 0 auto',
                  textTransform: 'uppercase'
                }}
              >
                {slide.type === 'video' ? 'vid' : 'img'}
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
            accept='image/jpeg,image/png,image/webp,image/gif,image/avif,video/mp4'
            onChange={handleUpload}
            style={{ display: 'none' }}
          />
        </label>
      </div>

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
