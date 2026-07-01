import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FC
} from 'react'

import type { RuntimeSlideshowDeck } from '../authoring/types'
import type { ScenarioSlideshowsState } from './useScenarioSlideshows'

const PANEL_BG = 'rgba(10, 18, 30, 0.72)'
const MODAL_BG = 'rgba(3, 8, 14, 0.86)'
const MEDIA_BG = 'rgba(3, 8, 14, 0.58)'
const PANEL_BORDER = '1px solid rgba(255, 255, 255, 0.10)'
const TEXT = '#e8eef5'
const MUTED = 'rgba(232, 238, 245, 0.55)'
const ACCENT = 'oklch(0.6671 0.2199 26.4681)'
const SANS =
  "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
const MODAL_Z_INDEX = 2147483000

export interface SlideshowRuntimeState {
  activeDeckId: string | null
  open: boolean
  onOpenDeck: (deckId: string) => void
  onClose: () => void
}

export interface SlideshowControlsState
  extends SlideshowRuntimeState, ScenarioSlideshowsState {}

const buttonStyle = (active = false): React.CSSProperties => ({
  fontFamily: SANS,
  color: active ? ACCENT : TEXT,
  background: active ? 'rgba(255,255,255,0.08)' : 'transparent',
  border: PANEL_BORDER,
  borderRadius: 0,
  cursor: 'pointer'
})

const iconButtonStyle: React.CSSProperties = {
  ...buttonStyle(),
  width: 26,
  height: 24,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
  fontSize: 12
}

const deckButtonStyle = (active = false): React.CSSProperties => ({
  ...buttonStyle(active),
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  width: '100%',
  minWidth: 0,
  gap: 10,
  padding: '6px 8px',
  fontSize: 11,
  letterSpacing: '0.04em'
})

const SlideshowIcon: FC = () => (
  <svg width='12' height='12' viewBox='0 0 24 24' fill='none' aria-hidden>
    <rect
      x='4'
      y='5'
      width='16'
      height='12'
      stroke='currentColor'
      strokeWidth='1.8'
    />
    <path
      d='M8 20h8M12 17v3'
      stroke='currentColor'
      strokeWidth='1.8'
      strokeLinecap='square'
    />
  </svg>
)

function run(promise: Promise<void>): void {
  promise.catch(() => {})
}

const ManageSlidesButton: FC<{
  active: boolean
  onClick: () => void
}> = ({ active, onClick }) => (
  <button
    type='button'
    aria-label='Manage slides'
    title='Manage slides'
    onClick={onClick}
    style={{
      ...deckButtonStyle(false),
      background: 'transparent',
      opacity: active ? 1 : 0.82,
      color: active ? ACCENT : TEXT
    }}
  >
    <span aria-hidden />
    <span
      style={{
        flex: '0 0 auto',
        color: active ? ACCENT : MUTED,
        fontSize: 10,
        letterSpacing: 0
      }}
    >
      Admin
    </span>
  </button>
)

export const SlideshowDeckLauncher: FC<{
  controls: SlideshowControlsState
}> = ({ controls }) => {
  const [newDeckLabel, setNewDeckLabel] = useState('')
  const visible = controls.decks.length > 0 || controls.adminOpen
  if (!visible) {
    return (
      <ManageSlidesButton
        active={controls.adminOpen}
        onClick={() => {
          controls.setAdminOpen(true)
        }}
      />
    )
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        width: '100%'
      }}
    >
      {controls.decks.map(deck => (
        <div key={deck.id} style={{ display: 'flex', gap: 6, width: '100%' }}>
          <button
            type='button'
            onClick={() => {
              controls.onOpenDeck(deck.id)
            }}
            style={{
              ...deckButtonStyle(
                controls.activeDeckId === deck.id && controls.open
              ),
              flex: 1,
              overflow: 'hidden'
            }}
          >
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
                minWidth: 0,
                overflow: 'hidden'
              }}
            >
              <SlideshowIcon />
              <span
                style={{
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }}
              >
                {deck.label}
              </span>
            </span>
            <span
              style={{
                flex: '0 0 auto',
                color: MUTED,
                fontSize: 10,
                letterSpacing: 0
              }}
            >
              {deck.slides.length}
            </span>
          </button>
          {controls.adminOpen && (
            <>
              <button
                type='button'
                title='Move up'
                onClick={() => {
                  run(controls.moveDeck(deck.id, -1))
                }}
                style={iconButtonStyle}
              >
                ^
              </button>
              <button
                type='button'
                title='Move down'
                onClick={() => {
                  run(controls.moveDeck(deck.id, 1))
                }}
                style={iconButtonStyle}
              >
                v
              </button>
            </>
          )}
        </div>
      ))}
      <ManageSlidesButton
        active={controls.adminOpen}
        onClick={() => {
          controls.setAdminOpen(!controls.adminOpen)
        }}
      />
      {controls.adminOpen && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            padding: 8,
            background: 'rgba(255,255,255,0.035)',
            border: PANEL_BORDER
          }}
        >
          <input
            type='password'
            value={controls.adminToken}
            onChange={event => {
              controls.setAdminToken(event.currentTarget.value)
            }}
            placeholder='Admin token'
            style={inputStyle}
          />
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              value={newDeckLabel}
              onChange={event => {
                setNewDeckLabel(event.currentTarget.value)
              }}
              placeholder='Slideshow name'
              style={{ ...inputStyle, flex: 1 }}
            />
            <button
              type='button'
              onClick={() => {
                void controls.createDeck(newDeckLabel)
                setNewDeckLabel('')
              }}
              style={{ ...buttonStyle(), padding: '4px 8px', fontSize: 10 }}
            >
              Add
            </button>
          </div>
          {controls.decks.map(deck => (
            <DeckAdminRow
              key={`admin-${deck.id}`}
              deck={deck}
              controls={controls}
            />
          ))}
          {controls.error != null && (
            <div style={{ color: ACCENT, fontFamily: SANS, fontSize: 10 }}>
              {controls.error}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const DeckAdminRow: FC<{
  deck: RuntimeSlideshowDeck
  controls: SlideshowControlsState
}> = ({ deck, controls }) => {
  const [label, setLabel] = useState(deck.label)
  const [title, setTitle] = useState('')

  useEffect(() => {
    setLabel(deck.label)
  }, [deck.label])

  const handleUpload = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (file == null) return
    void controls.uploadSlide(deck.id, file, title)
    setTitle('')
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
        padding: '6px 0',
        borderTop: PANEL_BORDER
      }}
    >
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          value={label}
          onChange={event => {
            setLabel(event.currentTarget.value)
          }}
          onBlur={() => {
            run(controls.patchDeck(deck.id, { label }))
          }}
          style={{ ...inputStyle, flex: 1 }}
        />
        <button
          type='button'
          title='Disable'
          onClick={() => {
            run(controls.patchDeck(deck.id, { enabled: false }))
          }}
          style={iconButtonStyle}
        >
          ○
        </button>
        <button
          type='button'
          title='Delete'
          onClick={() => {
            run(controls.deleteDeck(deck.id))
          }}
          style={iconButtonStyle}
        >
          ×
        </button>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          value={title}
          onChange={event => {
            setTitle(event.currentTarget.value)
          }}
          placeholder='Slide title'
          style={{ ...inputStyle, flex: 1 }}
        />
        <label style={{ ...buttonStyle(), padding: '4px 8px', fontSize: 10 }}>
          Upload
          <input
            type='file'
            accept='image/jpeg,image/png,image/webp,image/gif,image/avif,video/mp4'
            onChange={handleUpload}
            style={{ display: 'none' }}
          />
        </label>
      </div>
      {deck.slides.map(slide => (
        <div key={slide.id} style={{ display: 'flex', gap: 5 }}>
          <input
            defaultValue={slide.title ?? ''}
            onBlur={event => {
              run(
                controls.patchSlide(deck.id, slide.id, {
                  title: event.currentTarget.value
                })
              )
            }}
            placeholder={slide.type}
            style={{ ...inputStyle, flex: 1 }}
          />
          <button
            type='button'
            title='Move up'
            onClick={() => {
              run(controls.moveSlide(deck.id, slide.id, -1))
            }}
            style={iconButtonStyle}
          >
            ^
          </button>
          <button
            type='button'
            title='Move down'
            onClick={() => {
              run(controls.moveSlide(deck.id, slide.id, 1))
            }}
            style={iconButtonStyle}
          >
            v
          </button>
          <button
            type='button'
            title='Delete'
            onClick={() => {
              run(controls.deleteSlide(deck.id, slide.id))
            }}
            style={iconButtonStyle}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}

export const SlideshowModal: FC<{
  controls: SlideshowControlsState
}> = ({ controls }) => {
  const deck = useMemo(
    () =>
      controls.decks.find(candidate => candidate.id === controls.activeDeckId),
    [controls.activeDeckId, controls.decks]
  )
  const [index, setIndex] = useState(0)
  const videoRef = useRef<HTMLVideoElement | null>(null)

  const resetVideo = (): void => {
    const video = videoRef.current
    if (video == null) return
    video.pause()
    video.currentTime = 0
  }

  useEffect(() => {
    setIndex(0)
    resetVideo()
  }, [deck?.id])

  useEffect(() => {
    resetVideo()
  }, [index, controls.open])

  useEffect(() => {
    if (!controls.open || deck == null) return
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') controls.onClose()
      if (event.key === 'ArrowLeft') {
        setIndex(i => wrapped(i - 1, deck.slides.length))
      }
      if (event.key === 'ArrowRight') {
        setIndex(i => wrapped(i + 1, deck.slides.length))
      }
    }
    window.addEventListener('keydown', handler)
    return () => {
      window.removeEventListener('keydown', handler)
    }
  }, [controls, deck])

  useEffect(
    () => () => {
      resetVideo()
    },
    []
  )

  if (!controls.open || deck == null) return null

  const slide = deck.slides[index]

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: MODAL_Z_INDEX,
        display: 'grid',
        gridTemplateRows: 'auto minmax(0, 1fr) auto',
        gap: 12,
        padding: 16,
        background: MODAL_BG,
        backdropFilter: 'blur(14px)',
        WebkitBackdropFilter: 'blur(14px)',
        color: TEXT,
        fontFamily: SANS,
        pointerEvents: 'auto'
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          minHeight: 48,
          gap: 16,
          padding: '0 14px 0 16px',
          background: PANEL_BG,
          border: PANEL_BORDER,
          boxShadow: '0 18px 45px rgba(0, 0, 0, 0.30)'
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            minWidth: 0,
            overflow: 'hidden'
          }}
        >
          <span
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontSize: 13,
              fontWeight: 600
            }}
          >
            {deck.label}
          </span>
          <span style={{ color: MUTED, fontSize: 10 }}>
            {deck.slides.length === 0
              ? 'No slides'
              : `${index + 1} / ${deck.slides.length}`}
          </span>
        </div>
        <button
          type='button'
          aria-label='Close'
          onClick={controls.onClose}
          style={{
            ...iconButtonStyle,
            width: 34,
            height: 30,
            flex: '0 0 auto',
            color: TEXT,
            background: 'rgba(255,255,255,0.07)',
            fontSize: 18,
            lineHeight: 1
          }}
        >
          ×
        </button>
      </div>
      <div
        style={{
          display: 'grid',
          placeItems: 'center',
          minHeight: 0,
          overflow: 'hidden',
          padding: 12,
          background: MEDIA_BG,
          border: PANEL_BORDER,
          boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.03)'
        }}
      >
        {slide == null ? (
          <div
            style={{
              color: MUTED,
              fontSize: 13,
              padding: 18,
              background: PANEL_BG,
              border: PANEL_BORDER
            }}
          >
            No slides in this deck
          </div>
        ) : slide.type === 'video' ? (
          <video
            key={slide.id}
            ref={videoRef}
            src={slide.src}
            controls
            playsInline
            style={{
              width: '100%',
              height: '100%',
              maxHeight: 'calc(100vh - 162px)',
              objectFit: 'contain'
            }}
          />
        ) : (
          <img
            key={slide.id}
            src={slide.src}
            alt={slide.title ?? deck.label}
            style={{
              width: '100%',
              height: '100%',
              maxHeight: 'calc(100vh - 162px)',
              objectFit: 'contain'
            }}
          />
        )}
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '92px minmax(0, 1fr) 92px',
          alignItems: 'center',
          gap: 12,
          minHeight: 52,
          padding: '0 14px',
          background: PANEL_BG,
          border: PANEL_BORDER,
          boxShadow: '0 -18px 45px rgba(0, 0, 0, 0.22)'
        }}
      >
        <button
          type='button'
          onClick={() => {
            setIndex(i => wrapped(i - 1, deck.slides.length))
          }}
          style={{ ...buttonStyle(), height: 32, fontSize: 11 }}
        >
          Prev
        </button>
        <div
          style={{
            minWidth: 0,
            textAlign: 'center',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: slide?.title != null ? TEXT : MUTED,
            fontSize: 12,
            lineHeight: 1.25
          }}
        >
          {slide?.title ?? `${index + 1} / ${Math.max(1, deck.slides.length)}`}
        </div>
        <button
          type='button'
          onClick={() => {
            setIndex(i => wrapped(i + 1, deck.slides.length))
          }}
          style={{ ...buttonStyle(), height: 32, fontSize: 11 }}
        >
          Next
        </button>
      </div>
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  minWidth: 0,
  height: 24,
  padding: '0 7px',
  color: TEXT,
  background: 'rgba(255,255,255,0.06)',
  border: PANEL_BORDER,
  borderRadius: 0,
  fontFamily: SANS,
  fontSize: 10,
  outline: 'none'
}

function wrapped(index: number, length: number): number {
  if (length <= 0) return 0
  return (index + length) % length
}
