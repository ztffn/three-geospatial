// installIdleCallbackShim.ts — Installs a MessageChannel-backed replacement for
// window.requestIdleCallback that MUST run before any atmosphere code imports.
// packages/atmosphere/src/helpers/requestIdleCallback captures
// window.requestIdleCallback into a module-level const at first evaluation, and
// under the twin's heavy WebGPU render loop Chrome starves the native idle
// callback — stalling the LUT precompute ("Precomputing atmosphere" hangs).
// This shim wins that capture (see main.tsx, which imports it first) and drains
// the LUT's timesliced steps back-to-back instead of one-per-render-frame.

if (typeof window !== 'undefined' && typeof MessageChannel !== 'undefined') {
  const channel = new MessageChannel()
  const queue = new Map<number, IdleRequestCallback>()
  let nextId = 1

  // Assigning onmessage implicitly starts the port. Each message drains exactly
  // one queued callback (the LUT loop schedules its next step from inside the
  // current one, so only one is ever pending at a time).
  channel.port1.onmessage = (event: MessageEvent<number>): void => {
    const callback = queue.get(event.data)
    if (callback == null) return
    queue.delete(event.data)
    // The atmosphere timeSlice loop ignores the deadline; report a non-expiring
    // budget so any other caller still drains its work.
    callback({ didTimeout: false, timeRemaining: () => 16 })
  }

  window.requestIdleCallback = ((callback: IdleRequestCallback): number => {
    const id = nextId++
    queue.set(id, callback)
    // postMessage queues a macrotask that runs ahead of timers and is not
    // subject to the setTimeout(0) >=4 ms clamp, so steps drain promptly even
    // while the render loop is busy.
    channel.port2.postMessage(id)
    return id
  }) as typeof window.requestIdleCallback

  window.cancelIdleCallback = ((id: number): void => {
    queue.delete(id)
  }) as typeof window.cancelIdleCallback
}
