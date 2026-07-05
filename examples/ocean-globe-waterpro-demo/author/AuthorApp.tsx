// Author-mode shell, lazy-loaded behind the /author route: gates on the
// authoring admin session (token prompt against /api/authoring/admin/session)
// and, once open, mounts TwinExperience as a split workspace — the opaque
// AuthorSidebar docked left, the live twin (scene + visitor HUD) in the pane
// beside it. Default export so main.tsx can React.lazy this whole bundle.

import { useState, type FC, type FormEvent } from 'react'

import { TwinExperience } from '../app/TwinExperience'
import { AuthorSidebar } from './AuthorSidebar'
import {
  ACCENT,
  authorGlobalCss,
  BG,
  BORDER,
  buttonStyle,
  fieldStyle,
  labelStyle,
  MUTED,
  SANS,
  SECONDARY,
  TEXT
} from './theme'
import { useAuthorSession, type AuthorSessionState } from './useAuthorSession'

const AuthorGate: FC<{ session: AuthorSessionState }> = ({ session }) => {
  const [token, setToken] = useState('')

  const handleSubmit = (event: FormEvent): void => {
    event.preventDefault()
    // Only clear the field on success — a failed attempt (e.g. a mistyped
    // token) should stay editable so the operator can fix it in place.
    session.login(token).then(
      () => {
        setToken('')
      },
      () => {}
    )
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: BG,
        color: TEXT,
        fontFamily: SANS
      }}
    >
      <style>{authorGlobalCss}</style>
      <form
        onSubmit={handleSubmit}
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          width: 320,
          padding: 24,
          border: BORDER
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={labelStyle}>Author mode</span>
          <span style={{ fontSize: 12, color: SECONDARY }}>
            Humatopia World Twin
          </span>
        </div>
        {session.checking ? (
          <span style={{ color: MUTED, fontSize: 12 }}>Checking session…</span>
        ) : (
          <>
            <input
              className='au-input'
              type='password'
              value={token}
              onChange={event => {
                setToken(event.currentTarget.value)
              }}
              placeholder='Admin token'
              autoFocus
              style={{ ...fieldStyle, height: 32 }}
            />
            <button
              type='submit'
              className='au-btn'
              style={{ ...buttonStyle, height: 32, justifyContent: 'center' }}
            >
              Log in
            </button>
            {session.error != null && (
              <span style={{ color: ACCENT, fontSize: 11 }}>
                {session.error}
              </span>
            )}
            <a className='au-link' href='/' style={{ fontSize: 11 }}>
              ← back to the twin
            </a>
          </>
        )}
      </form>
    </div>
  )
}

const AuthorApp: FC = () => {
  const session = useAuthorSession()
  if (!session.authenticated) {
    return <AuthorGate session={session} />
  }
  return (
    <TwinExperience
      isAuthorMode
      authorSlot={ctx => <AuthorSidebar ctx={ctx} session={session} />}
    />
  )
}

export default AuthorApp
