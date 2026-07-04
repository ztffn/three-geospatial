// Deployment entry for the Humatopia World Twin: WebGPU adapter probe, worker
// error surfacing, and the visitor/author mode split. `/` mounts the visitor
// TwinExperience directly; `/author` (and subpaths) lazy-loads the author shell
// so authoring code (session gate, CRUD panels) never ships in the visitor
// bundle. All scene/boot machinery lives in app/ (SceneHost, TwinExperience).

import { lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'

import { showUnsupported } from './app/SceneHost'
import { TwinExperience } from './app/TwinExperience'

// Author bundle boundary: everything under author/ is reached only through
// this dynamic import.
const AuthorApp = lazy(async () => await import('./author/AuthorApp'))

const rootElement = document.getElementById('root')
if (rootElement == null) {
  throw new Error('Root element not found')
}

async function detectWebGPU(): Promise<boolean> {
  if (typeof navigator === 'undefined' || navigator.gpu == null) return false
  try {
    return (await navigator.gpu.requestAdapter()) != null
  } catch {
    return false
  }
}

// Route-based mode switch. The SPA fallback (vite dev, sirv single:true in
// prod) serves index.html for /author, so no server routing is involved.
function isAuthorRoute(): boolean {
  const { pathname } = window.location
  return pathname === '/author' || pathname.startsWith('/author/')
}

void detectWebGPU().then(available => {
  if (!available) {
    showUnsupported()
    return
  }
  // Surface any worker-side throws routed back via the synthetic-message
  // path injected by ifftWorkerHardeningPlugin (see vite.config.ts).
  window.addEventListener('message', e => {
    if (e?.data?.__workerError) {
      // eslint-disable-next-line no-console
      console.error('[ocean-worker:error]', e.data)
    }
  })
  // No StrictMode — the chunk-rebuilder pool and atmosphere LUT pipeline
  // both hold mutable WebGPU state that doesn't survive the mount/unmount/
  // remount cycle StrictMode performs in development.
  createRoot(rootElement).render(
    isAuthorRoute() ? (
      <Suspense fallback={null}>
        <AuthorApp />
      </Suspense>
    ) : (
      <TwinExperience />
    )
  )
})
