// Standalone deployment entry for the Globe WaterPro Ocean story.
// Mounts the storybook story's Content component inside a fullscreen
// react-three-fiber Canvas backed by WebGPURenderer — no Storybook chrome,
// no 85vw side panel. Holds a loading splash over the canvas until the
// atmosphere LUT compute and ocean chunk-builder pool both report ready;
// no fixed timer, no hope-based reveal. Also renders the digital-twin DOM
// overlay siblings: the top-left Huma brand mark (BrandMark, ported from the
// humatopia-frontend sidebar), the live MET conditions HUD + forecast scrubber
// (DigitalTwinUI, fed by the active scene location), and a collapsed Leva debug
// panel.

// requestIdleCallback shim — set BEFORE any package import.
// packages/atmosphere/src/webgpu/AtmosphereLUTNode.ts's `timeSlice` helper
// drives its multi-stage WebGPU compute (transmittance, scattering, multiple
// scattering 2..4) via `requestIdleCallback`. In a production-bundled build
// the WebGPU render loop is consistently >50 ms (rAF violations of 100-300
// ms), so Chrome never grants idle time and the LUT pipeline stalls
// indefinitely. Replacing the global with a setTimeout shim forces each
// stage to schedule on the next macrotask regardless of main-thread
// busyness. The atmosphere helper picks up window.requestIdleCallback at
// first call, so this must run before any atmosphere code loads.
if (typeof window !== 'undefined') {
  const force = function (cb: IdleRequestCallback): number {
    return setTimeout(
      () =>
        cb({
          didTimeout: false,
          timeRemaining: () => 16
        }),
      0
    ) as unknown as number
  }
  window.requestIdleCallback = force as typeof window.requestIdleCallback
  window.cancelIdleCallback = ((id: number) =>
    clearTimeout(id)) as typeof window.cancelIdleCallback
}

import { Canvas } from '@react-three/fiber'
import { Leva } from 'leva'
import { useCallback, useEffect, useRef, useState, type FC } from 'react'
import { createRoot } from 'react-dom/client'
import { NoToneMapping, SRGBColorSpace } from 'three'
import { WebGPURenderer, type Renderer } from 'three/webgpu'

import { DigitalTwinUI } from './ui/DigitalTwinUI'

import {
  AtmosphereLight,
  AtmosphereLightNode
} from '@takram/three-atmosphere/webgpu'

import {
  Content,
  type ContentReadinessRefs
} from '../../storybook-webgpu/src/ocean/GlobeWaterproOcean-Story'

const rootElement = document.getElementById('root')
const unsupportedElement = document.getElementById('unsupported')

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

// Two-phase readiness orchestration:
//
//   Phase 'atmosphere': Ocean is NOT mounted. The atmosphere LUT compute
//     pipeline runs without GPU contention from ocean chunk-builder workers
//     or the IFFT wave simulation. We poll lutNode.currentVersion +
//     lutNode.updating to detect completion.
//
//   Phase 'ocean': LUTs are done. Mount the ocean. Poll the OceanChunkManager
//     until the worker pool has actually delivered chunks (chunks_ dict has
//     entries AND builder.Busy === false). The atmosphere keeps rendering
//     against its stable LUTs while the ocean spins up.
//
//   Phase 'ready': both reported done. Splash fades.
//
// Two stalled-state safety nets, each scoped to its own phase, so a stuck
// atmosphere can't disguise itself as a stuck ocean (and vice versa).
type Phase = 'atmosphere' | 'ocean' | 'ready'

// Stability debounce: require the readiness condition to hold for this many
// consecutive frames before reporting. Then wait one additional rAF tick so
// the first render-after-ready completes (gives WebGPU shader/material
// compilation a frame to finish — chunks have geometry once Busy=false but
// the pipeline compiles on first draw). 5 frames at 60 Hz is ~83 ms.
const STABLE_FRAMES = 5

const ReadinessProbe: FC<{
  refs: ContentReadinessRefs | null
  phase: Phase
  onAtmosphereReady: (elapsedMs: number) => void
  onOceanReady: (elapsedMs: number) => void
}> = ({ refs, phase, onAtmosphereReady, onOceanReady }) => {
  const reportedAtmRef = useRef(false)
  const reportedOceanRef = useRef(false)
  useEffect(() => {
    if (refs == null) return
    let cancelled = false
    let stableFrames = 0
    const phaseStart = performance.now()
    const fire = (cb: (ms: number) => void): void => {
      // One extra rAF after the stability window so the first render-after-
      // ready has completed (shader/material compile during first draw).
      requestAnimationFrame(() => {
        if (cancelled) return
        cb(performance.now() - phaseStart)
      })
    }
    const tick = (): void => {
      if (cancelled) return
      if (phase === 'atmosphere' && !reportedAtmRef.current) {
        const lut = (refs.atmosphereContext as any)?.lutNode
        const atmosphereReady =
          lut != null && lut.currentVersion != null && lut.updating === false
        stableFrames = atmosphereReady ? stableFrames + 1 : 0
        if (stableFrames >= STABLE_FRAMES) {
          reportedAtmRef.current = true
          fire(onAtmosphereReady)
          return
        }
      } else if (phase === 'ocean' && !reportedOceanRef.current) {
        const mgr = refs.getOceanManager()
        const chunkCount =
          mgr?.chunks_ != null ? Object.keys(mgr.chunks_).length : 0
        const oceanReady =
          mgr != null &&
          mgr.builder_ != null &&
          mgr.builder_.Busy === false &&
          chunkCount > 0
        stableFrames = oceanReady ? stableFrames + 1 : 0
        if (stableFrames >= STABLE_FRAMES) {
          reportedOceanRef.current = true
          fire(onOceanReady)
          return
        }
      } else {
        return
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    return () => {
      cancelled = true
    }
  }, [refs, phase, onAtmosphereReady, onOceanReady])
  return null
}

const App: FC = () => {
  const [refs, setRefs] = useState<ContentReadinessRefs | null>(null)
  const [phase, setPhase] = useState<Phase>('atmosphere')
  // Active scene location, surfaced from Content's leva 'Location' control so
  // the conditions HUD fetches MET data for the point currently in view.
  // Defaults to Karmøy (the offshore-wind site) until Content reports.
  const [location, setLocation] = useState({
    longitude: 5.206866,
    latitude: 59.427348,
    name: 'Karmøy'
  })

  const handleReadinessRefs = useCallback(
    (r: ContentReadinessRefs) => setRefs(r),
    []
  )

  const handleLocationChange = useCallback(
    (longitude: number, latitude: number, name: string) =>
      setLocation({ longitude, latitude, name }),
    []
  )

  const handleAtmosphereReady = useCallback((elapsedMs: number) => {
    // eslint-disable-next-line no-console
    console.log(`[ready] atmosphere LUTs computed in ${elapsedMs.toFixed(0)}ms`)
    setPhase('ocean')
  }, [])

  const handleOceanReady = useCallback((elapsedMs: number) => {
    // eslint-disable-next-line no-console
    console.log(`[ready] ocean chunks built in ${elapsedMs.toFixed(0)}ms`)
    setPhase('ready')
  }, [])

  return (
    <>
      <Canvas
        camera={{ fov: 45, near: 1, far: 1e8 }}
        style={{ position: 'fixed', inset: 0, background: '#101820' }}
        gl={async props => {
          const renderer = new WebGPURenderer({
            ...(props as any),
            antialias: true,
            logarithmicDepthBuffer: true
          })
          await renderer.init()
          renderer.highPrecision = true
          renderer.outputColorSpace = SRGBColorSpace
          renderer.toneMapping = NoToneMapping
          renderer.library.addLight(AtmosphereLightNode, AtmosphereLight)
          return renderer as unknown as Renderer
        }}
      >
        <Content
          onReadinessRefs={handleReadinessRefs}
          disableOcean={phase === 'atmosphere'}
          onLocationChange={handleLocationChange}
        />
        <ReadinessProbe
          refs={refs}
          phase={phase}
          onAtmosphereReady={handleAtmosphereReady}
          onOceanReady={handleOceanReady}
        />
      </Canvas>
      <BrandMark />
      <DigitalTwinUI
        latitude={location.latitude}
        longitude={location.longitude}
        locationName={location.name}
      />
      {/* Debug controls: kept, but collapsed by default and out of the way
          (top-right; the conditions HUD stacks below it). */}
      <Leva collapsed />
      <Splash visible={phase !== 'ready'} />
    </>
  )
}

// Top-left Huma brand mark — a faithful port of the humatopia-frontend sidebar
// menu button (logo box + HumaDisplay "humatopia" wordmark). Plain DOM sibling
// of the canvas; Tailwind/shadcn classes there are reproduced here as inline
// styles since this demo has no Tailwind. Wordmark uses the dark-theme
// --sidebar-foreground (warm near-white) so it reads on the dark globe scene.
// Sits below the Splash (z 5 < 10) so it reveals with the scene, not the cover.
const BrandMark: FC = () => (
  <div style={{ position: 'fixed', top: 8, left: 8, zIndex: 5 }}>
    <a
      href="/"
      className="huma-brand"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.5rem', // gap-2
        height: '3rem', // h-12
        padding: '0.5rem', // p-2
        borderRadius: 0, // --radius: 0 (sharp corners)
        textAlign: 'left',
        textDecoration: 'none',
        outline: 'none',
        color: '#13294b',
        transition: 'background-color 150ms cubic-bezier(0.4, 0, 0.2, 1)'
      }}
    >
      <div
        style={{
          display: 'flex',
          aspectRatio: '1 / 1',
          width: '2rem', // size-8
          height: '2rem',
          alignItems: 'center',
          justifyContent: 'center'
        }}
      >
        <img
          src="/public/brand/huma-favicon.png"
          alt="Huma"
          style={{ width: '1.25rem', height: '1.25rem' }} // size-5
        />
      </div>
      <div style={{ display: 'grid', flex: 1, textAlign: 'left', lineHeight: 1.25 }}>
        <span
          style={{
            fontFamily: "'HumaDisplay', sans-serif",
            fontWeight: 300,
            textTransform: 'lowercase',
            fontSize: '1.3rem',
            letterSpacing: '0.01em'
          }}
        >
          Humatopia
        </span>
        <span
          style={{
            fontFamily:
              "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace",
            fontSize: '0.55rem',
            fontWeight: 500,
            letterSpacing: '0.18em',
            textTransform: 'uppercase'
          }}
        >
          Digital Twin World
        </span>
      </div>
    </a>
    <style>{`.huma-brand:hover { background-color: oklch(0.2686 0 0); }`}</style>
  </div>
)

// Minimal cover: full-bleed dark backdrop matching the canvas clear color, a
// small spinner, and a single line of status. Fades out (500 ms) once the
// loader reports ready. No spinning while ready — display:none after the
// fade so the spinner doesn't burn cycles in the background.
const Splash: FC<{ visible: boolean }> = ({ visible }) => {
  const [mounted, setMounted] = useState(true)
  useEffect(() => {
    if (visible) return
    const t = setTimeout(() => setMounted(false), 500)
    return () => clearTimeout(t)
  }, [visible])
  if (!mounted) return null
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: '#101820',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        opacity: visible ? 1 : 0,
        transition: 'opacity 500ms ease-out',
        pointerEvents: visible ? 'auto' : 'none',
        zIndex: 10
      }}
    >
      <div
        style={{
          width: 24,
          height: 24,
          borderRadius: '50%',
          border: '2px solid rgba(207, 216, 227, 0.2)',
          borderTopColor: 'rgba(207, 216, 227, 0.9)',
          animation: 'gwp-spin 0.9s linear infinite'
        }}
      />
      <style>{`@keyframes gwp-spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}

void detectWebGPU().then(available => {
  if (!available) {
    unsupportedElement?.classList.add('show')
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
  createRoot(rootElement).render(<App />)
})
