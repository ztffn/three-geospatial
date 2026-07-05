// Design tokens + shared control styles for the author workspace (sidebar,
// gate). Deliberately distinct from the visitor's translucent glass HUD: the
// authoring chrome is OPAQUE, borders-only, sharp-cornered, dense — a workshop
// next to the showroom. One accent (Huma red) reserved for errors/destructive;
// a single desaturated green marks the Live publish state. 4px spacing grid.

import type { CSSProperties } from 'react'

// Brand tokens (text colors, accent, font stack) are shared with the visitor
// UI — one source, no drift.
import { ACCENT, MUTED, SANS, TEXT } from '../ui/SlideshowViewer'

export { ACCENT, MUTED, SANS, TEXT }

export const BG = '#101820' // matches the scene clear color, fully opaque
export const BG_RAISED = '#151f29' // inputs / interactive surfaces
export const BORDER = '1px solid rgba(255, 255, 255, 0.08)'
export const BORDER_FAINT = '1px solid rgba(255, 255, 255, 0.05)'

// Remaining levels of the four-step contrast hierarchy (TEXT/MUTED above).
export const SECONDARY = 'rgba(232, 238, 245, 0.78)'
export const FAINT = 'rgba(232, 238, 245, 0.34)'

export const LIVE = '#86c7a1' // published state only

export const MONO =
  "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace"

// Section label: 10px, 500, uppercase, wide tracking, muted.
export const labelStyle: CSSProperties = {
  fontFamily: SANS,
  fontSize: 10,
  fontWeight: 500,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  color: MUTED
}

// Ghost button (borders-only depth). Pair with className='au-btn' for the
// hover/active states defined in authorGlobalCss.
export const buttonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  height: 28,
  padding: '0 10px',
  whiteSpace: 'nowrap',
  fontFamily: SANS,
  fontSize: 11,
  fontWeight: 500,
  color: TEXT,
  background: 'transparent',
  border: BORDER,
  borderRadius: 0,
  cursor: 'pointer'
}

// Square icon button, same chrome as buttonStyle.
export const iconButtonStyle: CSSProperties = {
  ...buttonStyle,
  width: 24,
  height: 24,
  padding: 0,
  color: MUTED
}

// Text input. Pair with className='au-input' for the focus ring.
export const fieldStyle: CSSProperties = {
  minWidth: 0,
  height: 28,
  padding: '0 8px',
  fontFamily: SANS,
  fontSize: 12,
  color: TEXT,
  background: BG_RAISED,
  border: BORDER,
  borderRadius: 0,
  outline: 'none'
}

// Hover/focus states for the ghost controls — inline styles can't express
// them; mount once per author surface.
export const authorGlobalCss = `
.au-btn:hover { background: rgba(255, 255, 255, 0.06); }
.au-btn:active { background: rgba(255, 255, 255, 0.10); }
.au-btn:disabled { opacity: 0.45; cursor: default; }
.au-btn:disabled:hover { background: transparent; }
.au-danger:hover { color: ${ACCENT}; border-color: ${ACCENT}; background: transparent; }
.au-input:focus { border-color: rgba(255, 255, 255, 0.28); }
.au-input::placeholder { color: ${FAINT}; }
.au-link { color: ${MUTED}; text-decoration: none; }
.au-link:hover { color: ${TEXT}; }
`
