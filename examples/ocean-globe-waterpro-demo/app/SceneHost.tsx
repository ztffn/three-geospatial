// Mode-independent WebGPU scene host for the twin: fullscreen R3F Canvas with
// the memoized WebGPURenderer factory, the two-phase readiness orchestration
// (atmosphere LUTs → ocean chunks → reveal), the Firefox resize/rAF-stall
// workarounds, and the loading splash. Extracted verbatim from main.tsx so the
// visitor and author shells share one boot path; children get the scene props.

import { Canvas, useThree } from '@react-three/fiber'
import { useCallback, useEffect, useRef, useState, type FC, type ReactNode } from 'react'
import { NoToneMapping, SRGBColorSpace } from 'three'
import { WebGPURenderer, type Renderer } from 'three/webgpu'

import {
  AtmosphereLight,
  AtmosphereLightNode
} from '@takram/three-atmosphere/webgpu'

import type { ContentReadinessRefs } from '../../../storybook-webgpu/src/ocean/GlobeWaterproOcean-Story'

// Reveal the static "WebGPU unsupported" overlay from index.html. Idempotent —
// called both from the up-front adapter probe (no adapter at all) and from the
// runtime device-lost handler (adapter existed but the device died mid-run).
export function showUnsupported(): void {
  document.getElementById('unsupported')?.classList.add('show')
}

// WORKAROUND (Firefox): R3F creates the renderer only after react-use-measure
// reports a nonzero container size, and react-use-measure gets its sizes from
// a ResizeObserver. Firefox drops the spec-mandated initial notification when
// observation starts, and this page has no scroll/resize/layout activity to
// ever trigger a re-measure — the measured state sits at 0×0 forever and the
// app hangs on the splash with an empty console, even though
// getBoundingClientRect() reports the true size the whole time (verified via
// the boot-trace rect log; synthetic window-resize events did NOT rescue it).
// This wrapper re-delivers an initial notification on a rAF after every
// observe(); react-use-measure re-observes right after its mount effects, so
// the notification lands once its internal mounted flag accepts updates. Its
// callback ignores the entries and re-reads getBoundingClientRect, so empty
// entries are valid. Scoped to R3F's one measure hook via the Canvas
// `resize.polyfill` option — no global patching.
class MeasureResizeObserver {
  private readonly native: ResizeObserver
  private readonly callback: ResizeObserverCallback
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
    this.native = new ResizeObserver(callback)
  }

  observe(target: Element, options?: ResizeObserverOptions): void {
    this.native.observe(target, options)
    clearTimeout(this.timer)
    // setTimeout, NOT requestAnimationFrame: every mechanism that silently
    // failed to unstick Firefox here (the earlier resize-event pump, the first
    // polyfill draft) scheduled its work via rAF, while every observable
    // diagnostic ran off timers — suggesting FF does not service rAF on this
    // page before the render loop exists. Timers are unthrottled for a
    // visible foreground tab.
    this.timer = setTimeout(() => {
      this.callback([], this.native)
    }, 0)
  }

  unobserve(target: Element): void {
    this.native.unobserve(target)
  }

  disconnect(): void {
    clearTimeout(this.timer)
    this.native.disconnect()
  }
}

// Two-phase readiness orchestration:
//
//   Phase 'atmosphere': Ocean is NOT mounted. The baked atmosphere LUTs
//     download and upload, and the sky/post pipelines take their first compile,
//     without contention from ocean chunk-builder workers or the IFFT wave
//     simulation. We poll lutNode.currentVersion + lutNode.updating (fetch
//     completion on the baked node) to detect readiness.
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
// consecutive polls before reporting, then wait one more poll interval so the
// first render-after-ready completes (chunks have geometry once Busy=false
// but the pipeline compiles on first draw). The probe polls on a TIMER, not
// requestAnimationFrame: Firefox deprioritizes the refresh driver for this
// tab until first user interaction (observed rAF at 0–4.5 fps while timers
// run normally), and an rAF-scheduled probe then never advances the load.
// Timer cadence + real-state checks keeps the no-timer rule intact — timers
// schedule the POLLING, readiness is still actual subsystem state.
const PROBE_INTERVAL_MS = 100
const STABLE_POLLS = 5

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
    let stablePolls = 0
    const phaseStart = performance.now()
    const fire = (cb: (ms: number) => void): void => {
      // One extra interval after the stability window so the first render-
      // after-ready has completed (shader/material compile during first draw).
      setTimeout(() => {
        if (cancelled) return
        cb(performance.now() - phaseStart)
      }, PROBE_INTERVAL_MS)
    }
    const id = setInterval(() => {
      if (cancelled) return
      if (phase === 'atmosphere' && !reportedAtmRef.current) {
        const lut = (refs.atmosphereContext as any)?.lutNode
        const atmosphereReady =
          lut != null && lut.currentVersion != null && lut.updating === false
        stablePolls = atmosphereReady ? stablePolls + 1 : 0
        if (stablePolls >= STABLE_POLLS) {
          reportedAtmRef.current = true
          clearInterval(id)
          fire(onAtmosphereReady)
        }
      } else if (phase === 'ocean' && !reportedOceanRef.current) {
        const mgr = refs.getOceanManager()
        const chunkCount =
          mgr?.chunks_ != null ? Object.keys(mgr.chunks_).length : 0
        // Reveal waits on the load-time compileAsync prewarm in addition to the
        // chunk build, so the first visible frame is already pipeline-warm — no
        // ~2 s synchronous WGSL compile hitch at reveal. isPrewarmed is optional
        // for backward-compatibility with an un-updated Content.
        const oceanReady =
          mgr != null &&
          mgr.builder_ != null &&
          mgr.builder_.Busy === false &&
          chunkCount > 0 &&
          (refs.isPrewarmed?.() ?? true)
        stablePolls = oceanReady ? stablePolls + 1 : 0
        if (stablePolls >= STABLE_POLLS) {
          reportedOceanRef.current = true
          clearInterval(id)
          fire(onOceanReady)
        }
      } else {
        clearInterval(id)
      }
    }, PROBE_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [refs, phase, onAtmosphereReady, onOceanReady])
  return null
}

// Keeps the loading pipeline advancing when the browser withholds animation
// frames. Firefox deprioritizes a tab's refresh driver until first user
// interaction (observed: rAF at 0–4.5 fps in a visible, focused tab while
// timers/fetch/WebGPU run normally), and EVERYTHING in the load rides the
// frame loop — chunk-builder draining, the wave-sim warm-up, the prewarm's
// post render. This watchdog samples whether any real rAF fired in the last
// interval and, only when none did, drives one R3F frame manually via
// advance(). It does nothing wherever rAF is healthy (Chrome, FF after a
// click), and is mounted only while the splash is up — after reveal the app
// accepts the browser's own frame pacing.
const StalledFrameDriver: FC<{ active: boolean }> = ({ active }) => {
  const advance = useThree(state => state.advance)
  useEffect(() => {
    if (!active) return
    let rafSeen = false
    let raf = 0
    const bump = (): void => {
      rafSeen = true
      raf = requestAnimationFrame(bump)
    }
    raf = requestAnimationFrame(bump)
    const id = setInterval(() => {
      if (!rafSeen) {
        // Same unit R3F's own loop passes: the DOMHighResTimeStamp in ms.
        advance(performance.now())
      }
      rafSeen = false
    }, PROBE_INTERVAL_MS)
    return () => {
      clearInterval(id)
      cancelAnimationFrame(raf)
    }
  }, [active, advance])
  return null
}

// Forces the renderer to the true canvas-container size after first layout and
// on every resize / fullscreen transition. R3F's own ResizeObserver can latch
// a stale size when the canvas mounts small and the window goes fullscreen
// late (the Electron wrapper) — leaving the backbuffer + depth attachment at
// the 300x150 canvas default while the color attachment is retina-fullscreen,
// which trips the WebGPU "depthBuffer size does not match color attachment"
// validation and blacks out the scene. The trustworthy source is the container
// div's getBoundingClientRect (proven reliable on the pathological Firefox —
// see MeasureResizeObserver): in visitor mode the container fills #root =
// the viewport; in author mode it fills the scene pane beside the docked
// sidebar, so window.inner* would OVERSIZE the canvas there. Re-applying
// setSize/setDpr on the events that matter (rAF after mount, window 'resize'
// — Electron OS-fullscreen fires this, not document 'fullscreenchange' — and
// 'fullscreenchange' for the browser path) repairs the whole size pipeline:
// backbuffer (gl.setSize), the pass node (renderer.getSize), and size-keyed
// depth targets (useThree().size).
const ResizeSync: FC = () => {
  const setSize = useThree(state => state.setSize)
  const setDpr = useThree(state => state.setDpr)
  const gl = useThree(state => state.gl)
  useEffect(() => {
    const apply = (): void => {
      // Match R3F's own default clamp ([1, 2]) — never uncap DPR, or DPR-3
      // displays would render at 2.25x the pixels (perf regression).
      setDpr([1, 2])
      const container = gl.domElement.parentElement
      const rect = container?.getBoundingClientRect()
      // Zero-rect fallback (container not laid out yet): window dims, which
      // are exact in visitor mode and a one-frame overshoot in author mode.
      setSize(
        rect != null && rect.width > 0 ? rect.width : window.innerWidth,
        rect != null && rect.height > 0 ? rect.height : window.innerHeight
      )
    }
    const raf = requestAnimationFrame(apply)
    window.addEventListener('resize', apply)
    document.addEventListener('fullscreenchange', apply)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', apply)
      document.removeEventListener('fullscreenchange', apply)
    }
  }, [setSize, setDpr, gl])
  return null
}

// Minimal cover: full-bleed dark backdrop matching the canvas clear color, a
// small spinner, and one muted monospace status line that mirrors the console
// milestones (what the loader is doing this phase). Fades out (500 ms) once the
// loader reports ready. No spinning while ready — display:none after the fade
// so the spinner doesn't burn cycles in the background.
//
// Deliberately plain DOM + CSS. On the pathological stalled-refresh-driver
// Firefox (see StalledFrameDriver) NOTHING a page does reaches the screen —
// DOM paints, CSS transitions, WAAPI starts, and even 2D-canvas presentation
// were each tried and all ride the dead driver; only animations registered
// with the compositor at the initial paint keep running, which is exactly
// this CSS spinner. The load completes regardless (title flips to ✓) and the
// first tab switch/interaction repaints everything.
const PHASE_STATUS: Record<Phase, string> = {
  atmosphere: 'Loading atmosphere…',
  ocean: 'Building ocean…',
  ready: 'Ready'
}

const Splash: FC<{ visible: boolean; phase: Phase }> = ({ visible, phase }) => {
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
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 14,
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
      <div
        style={{
          fontFamily:
            "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace",
          fontSize: 11,
          letterSpacing: '0.08em',
          color: 'rgba(207, 216, 227, 0.55)'
        }}
      >
        {PHASE_STATUS[phase]}
      </div>
      <style>{`@keyframes gwp-spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}

// Scene-boot props threaded to the Content the shell mounts inside the Canvas.
export interface SceneBootProps {
  onReadinessRefs: (refs: ContentReadinessRefs) => void
  disableOcean: boolean
}

export const SceneHost: FC<{
  children: (boot: SceneBootProps) => ReactNode
  // Mirrors Content's readiness refs to the shell (e.g. for the author mode's
  // viewpoint capture via getCameraPose). SceneHost keeps its own copy for the
  // readiness probes either way.
  onReadinessRefs?: (refs: ContentReadinessRefs) => void
}> = ({ children, onReadinessRefs }) => {
  const [refs, setRefs] = useState<ContentReadinessRefs | null>(null)
  const [phase, setPhase] = useState<Phase>('atmosphere')

  const handleReadinessRefs = useCallback(
    (r: ContentReadinessRefs) => {
      setRefs(r)
      onReadinessRefs?.(r)
    },
    [onReadinessRefs]
  )

  // Mirror readiness into the tab title. Browser chrome repaints
  // independently of the tab's refresh driver, so on a Firefox whose driver
  // stalls (see StalledFrameDriver) the title flips to ✓ the moment the app
  // is actually ready even while the tab's own pixels are stale.
  useEffect(() => {
    if (phase === 'ready') {
      document.title = '✓ Humatopia World Twin'
    }
  }, [phase])

  // Single renderer for the app's lifetime. R3F re-runs its configure pass on
  // every measured-size change, and with an async gl FACTORY each re-run
  // constructs ANOTHER WebGPURenderer on the same canvas — observed in Chrome:
  // four constructions, one of which kept a 300×150 depth buffer and spammed
  // "attachment size" validation errors every frame until a real window
  // resize. Memoizing the construction promise makes every configure resolve
  // to the same instance.
  const rendererPromiseRef = useRef<Promise<Renderer> | null>(null)

  const handleAtmosphereReady = useCallback((elapsedMs: number) => {
    // eslint-disable-next-line no-console
    console.log(`[ready] atmosphere LUTs loaded in ${elapsedMs.toFixed(0)}ms`)
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
        camera={{ fov: 45, near: 0.1, far: 1e8 }}
        // No positioning override: R3F's container div defaults to
        // position:relative + 100%×100%, and #root is styled 100%×100% in
        // index.html, so the canvas is viewport-sized without it. The previous
        // `position:fixed; inset:0` style rode on R3F's size-measured div, and
        // Firefox never reported a nonzero size for it — R3F's internal gate
        // (containerRect > 0) then never invoked the gl factory, so the app
        // hung on the splash with an empty console. This default-styled div
        // is exactly the configuration the storybook WebGPUCanvas uses, which
        // measures fine in Firefox. (No `resize` override either: R3F's
        // default resize debounce is already 0 — the old prop only changed
        // scroll debounce, and ResizeSync below owns the fullscreen repair.)
        style={{ background: '#101820' }}
        // Firefox: guarantee the initial size notification R3F's renderer
        // creation gates on — see MeasureResizeObserver above.
        resize={{ polyfill: MeasureResizeObserver }}
        // NOT an async closure itself: R3F re-invokes this factory whenever a
        // measured-size change re-runs its configure pass — the memoized
        // promise below makes every invocation resolve to the ONE renderer
        // (see rendererPromiseRef). The construction body runs exactly once.
        gl={props => {
          rendererPromiseRef.current ??= (async () => {
            const renderer = new WebGPURenderer({
              ...(props as any),
              // No canvas MSAA. The final present is a fullscreen post-processing
              // quad (all scene passes are samples:0), so canvas multisampling
              // antialiases nothing — but it DOES allocate an MSAA colour buffer
              // that resolves into the canvas texture. During the mount→fullscreen
              // resize race those two can momentarily differ in size (e.g. a stale
              // 300×150 colour buffer resolving into a retina canvas), which is a
              // fatal WebGPU validation error ("Attachments have differing sizes")
              // that blacks the scene — hit reliably on Firefox's compat adapter.
              // Dropping the resolve target makes that mismatch structurally
              // impossible; worst case is a single wrong-size frame under the splash.
              antialias: false,
              logarithmicDepthBuffer: true
            })
            try {
              await renderer.init()
            } catch (error) {
              // Fatal and unambiguous, same class as device.lost below: surface
              // the static unsupported overlay instead of a silent forever-splash.
              console.error('[webgpu] renderer.init() failed:', error)
              showUnsupported()
              throw error
            }
            renderer.highPrecision = true
            renderer.outputColorSpace = SRGBColorSpace
            renderer.toneMapping = NoToneMapping
            renderer.library.addLight(AtmosphereLightNode, AtmosphereLight)
            // Graceful degradation: if the GPU device is lost (unsupported/broken
            // WebGPU on some browsers), reveal the static "unsupported" overlay
            // instead of hanging forever on a black splash. Device loss is the one
            // unambiguous fatal signal; transient validation errors are left to log.
            const device = (
              renderer as unknown as { backend?: { device?: GPUDevice } }
            ).backend?.device
            if (device != null) {
              void device.lost.then(info => {
                console.error(
                  '[webgpu] device lost:',
                  info.reason,
                  info.message
                )
                showUnsupported()
              })
            }
            return renderer as unknown as Renderer
          })()
          return rendererPromiseRef.current
        }}
      >
        {children({
          onReadinessRefs: handleReadinessRefs,
          disableOcean: phase === 'atmosphere'
        })}
        <ReadinessProbe
          refs={refs}
          phase={phase}
          onAtmosphereReady={handleAtmosphereReady}
          onOceanReady={handleOceanReady}
        />
        <StalledFrameDriver active={phase !== 'ready'} />
        <ResizeSync />
      </Canvas>
      <Splash visible={phase !== 'ready'} phase={phase} />
    </>
  )
}
