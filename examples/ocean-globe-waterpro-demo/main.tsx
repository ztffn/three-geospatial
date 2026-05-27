// Standalone deployment entry for the Globe WaterPro Ocean story.
// Mounts the storybook story's Content component inside a fullscreen
// react-three-fiber Canvas backed by WebGPURenderer — no Storybook chrome,
// no 85vw side panel. Holds a loading splash over the canvas until the
// atmosphere LUT compute and ocean chunk-builder pool both report ready;
// no fixed timer, no hope-based reveal.

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
import { useCallback, useEffect, useRef, useState, type FC } from 'react'
import { createRoot } from 'react-dom/client'
import { NoToneMapping, SRGBColorSpace } from 'three'
import { WebGPURenderer, type Renderer } from 'three/webgpu'

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
    const phaseStart = performance.now()
    const tick = (): void => {
      if (cancelled) return
      if (phase === 'atmosphere' && !reportedAtmRef.current) {
        const lut = (refs.atmosphereContext as any)?.lutNode
        const atmosphereReady =
          lut != null && lut.currentVersion != null && lut.updating === false
        if (atmosphereReady) {
          reportedAtmRef.current = true
          onAtmosphereReady(performance.now() - phaseStart)
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
        if (oceanReady) {
          reportedOceanRef.current = true
          onOceanReady(performance.now() - phaseStart)
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

  const handleReadinessRefs = useCallback(
    (r: ContentReadinessRefs) => setRefs(r),
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
      />
      <ReadinessProbe
        refs={refs}
        phase={phase}
        onAtmosphereReady={handleAtmosphereReady}
        onOceanReady={handleOceanReady}
      />
    </Canvas>
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
