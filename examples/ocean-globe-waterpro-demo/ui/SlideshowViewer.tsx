// Visitor-facing slideshow UI: the per-scenario deck launcher (list of
// published decks in the scenario panel) and the fullscreen slide modal
// (image/video, prev/next/close, keyboard nav, video pause/reset lifecycle).
// Strictly read-only — deck/slide management lives in author/ behind the
// /author route. The Huma brand tokens are exported for author/theme.ts.

import { useEffect, useMemo, useRef, useState, type FC } from 'react'

import type { RuntimeSlideshowDeck } from '../authoring/types'
import { generateSrcdoc } from './microApp'

const PANEL_BG = 'rgba(10, 18, 30, 0.72)'
const MODAL_BG = 'rgba(3, 8, 14, 0.86)'
const MEDIA_BG = 'rgba(3, 8, 14, 0.58)'
const PANEL_BORDER = '1px solid rgba(255, 255, 255, 0.10)'
// Brand tokens shared with the author chrome (author/theme.ts imports these).
export const TEXT = '#e8eef5'
export const MUTED = 'rgba(232, 238, 245, 0.55)'
export const ACCENT = 'oklch(0.6671 0.2199 26.4681)'
export const SANS =
  "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
const MODAL_Z_INDEX = 2147483000

// Viewer state for the launcher + modal: the published decks of the active
// scenario and which deck (if any) is open. Owned by TwinExperience.
export interface SlideshowControlsState {
  decks: RuntimeSlideshowDeck[]
  activeDeckId: string | null
  open: boolean
  onOpenDeck: (deckId: string) => void
  onClose: () => void
}

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

export const SlideshowDeckLauncher: FC<{
  controls: SlideshowControlsState
}> = ({ controls }) => {
  // Published decks only. Visitors never receive drafts, but author mode
  // fetches them for the sidebar — the launcher is the visitor-facing
  // affordance and must preview exactly what visitors get. (The modal keeps
  // the full list so the author can Preview a draft.)
  const published = controls.decks.filter(deck => deck.enabled)
  if (published.length === 0) return null
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        width: '100%'
      }}
    >
      {published.map(deck => (
        <button
          key={deck.id}
          type='button'
          onClick={() => {
            controls.onOpenDeck(deck.id)
          }}
          style={{
            ...deckButtonStyle(
              controls.activeDeckId === deck.id && controls.open
            ),
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
    const navigate = (key: string): void => {
      if (key === 'Escape') controls.onClose()
      if (key === 'ArrowLeft') {
        setIndex(i => wrapped(i - 1, deck.slides.length))
      }
      if (key === 'ArrowRight') {
        setIndex(i => wrapped(i + 1, deck.slides.length))
      }
    }
    const handler = (event: KeyboardEvent): void => {
      navigate(event.key)
    }
    // 'html'/'jsx' slides render inside a sandboxed iframe, whose keydown
    // events never bubble to this window — the iframe's own script bridges
    // Escape/arrow keys out via postMessage instead (see ui/microApp.ts).
    const messageHandler = (event: MessageEvent): void => {
      if (event.data?.type === 'slide-nav-key') navigate(event.data.key)
    }
    window.addEventListener('keydown', handler)
    window.addEventListener('message', messageHandler)
    return () => {
      window.removeEventListener('keydown', handler)
      window.removeEventListener('message', messageHandler)
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
        ) : slide.type === 'html' || slide.type === 'jsx' ? (
          <iframe
            key={slide.id}
            title={slide.title ?? deck.label}
            srcDoc={generateSrcdoc(slide.code ?? '')}
            sandbox='allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox'
            style={{
              width: '100%',
              height: '100%',
              maxHeight: 'calc(100vh - 162px)',
              border: 'none',
              background: '#fff'
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

function wrapped(index: number, length: number): number {
  if (length <= 0) return 0
  return (index + length) % length
}
