// Georeferenced Gaussian-splat capture layer for the Globe WaterPro twin. Fetches an
// SPZ capture (spz-js → GaussianSplatData), places it at the scenario target via the
// local ENU frame (ShipModel-style fine-tune knobs), and renders it through the splats
// package's <GaussianSplatsGPU> (GPU sort + octree-LOD budget) — the twin does NOT
// re-implement a viewer, it configures the shared component. Portalled into a dedicated
// `splatScene` the twin composites AFTER the atmosphere pass (approach A: over the lit
// sky, depth-masked). Renders nothing unless an `spzUrl` is given (the Realtime site).

import { createPortal } from '@react-three/fiber'
import { useControls } from 'leva'
import { useEffect, useMemo, useState, type FC } from 'react'
import { MathUtils, Quaternion, Vector3, type Scene } from 'three'

import { Ellipsoid } from '@takram/three-geospatial'
import {
  GaussianSplatsGPU,
  loadSpzSplatData,
  type GaussianSplatData
} from '@takram/three-geospatial-splats/webgpu'

export const SplatLayer: FC<{
  target: Vector3
  splatScene: Scene
  /** SPZ capture URL. When omitted the layer renders nothing (off-site). */
  spzUrl?: string
}> = ({ target, splatScene, spzUrl }) => {
  const {
    enabled,
    scale,
    eastOffset,
    northOffset,
    heightOffset,
    yawDeg,
    intensity,
    budget,
    maxSplats,
    debug
  } = useControls(
    'Assets.Splats',
    {
      enabled: true,
      // Capture is ~8 units across; scale converts to metres (50 ≈ a ~400 m scene).
      scale: { value: 50, min: 1, max: 2000, step: 1 },
      // ENU placement from the sea-level scenario anchor — same knobs the site 3D
      // models use (the 'Waste site' leva folder). Defaults are the in-scene tuned
      // placement of the capture on its land patch (the anchor itself is at sea).
      eastOffset: { value: 315, min: -2000, max: 2000, step: 1 },
      northOffset: { value: 163, min: -2000, max: 2000, step: 1 },
      // Lifts the cloud CENTER along ECEF up from the sea-level anchor.
      heightOffset: { value: 84.4, min: -500, max: 4000, step: 1 },
      // Rotation about the local up axis (capture heading alignment).
      yawDeg: { value: -120, min: -180, max: 180, step: 1 },
      // Radiance scale into the AgX HDR range. The twin tonemaps at AgX exposure
      // 10, so raw 0..1 capture colours (intensity 1) clip to white — ~0.1 lands
      // them in range. Tune to taste.
      intensity: { value: 0.1, min: 0, max: 4, step: 0.01 },
      // Octree-LOD render budget: max splats DRAWN per frame (GPU sort + budget +
      // frustum cull, from the splats package). Live. `maxSplats` caps what's LOADED.
      budget: {
        value: 1_000_000,
        options: {
          '4M': 4_000_000,
          '2M': 2_000_000,
          '1M': 1_000_000,
          '500k': 500_000,
          '250k': 250_000
        }
      },
      // Decimation cap on LOAD (decode + octree-build cost scale with count). 0 =
      // full. Reloads on change. (spz-js can't partial-decode, so the full decode
      // still runs; this caps what's kept.) The LOD budget bounds what's DRAWN.
      maxSplats: {
        value: 500_000,
        options: {
          Full: 0,
          '4M': 4_000_000,
          '2M': 2_000_000,
          '1M': 1_000_000,
          '500k': 500_000
        }
      },
      // Coordinate/debug. 'flipYZ' = RDF→RUB conversion spz-js omits (default fix
      // for PLY-derived SPZ); 'raw' = no conversion; 'isotropic' = round blobs
      // (diagnostic). Reloads on change.
      debug: { value: 'flipYZ', options: ['flipYZ', 'raw', 'isotropic'] }
    },
    { collapsed: true }
  )

  // SPZ capture data, loaded async. `null` until a load resolves (or off-site).
  const [data, setData] = useState<GaussianSplatData | null>(null)

  useEffect(() => {
    if (spzUrl == null) {
      setData(null)
      return
    }
    let cancelled = false
    setData(null)
    const started = performance.now()
    void fetch(spzUrl)
      .then(async response => {
        if (!response.ok) {
          throw new Error(`SPZ fetch ${response.status} for ${spzUrl}`)
        }
        return await response.arrayBuffer()
      })
      .then(
        async buffer =>
          await loadSpzSplatData(buffer, {
            ...(maxSplats > 0 ? { maxSplats } : {}),
            debug: debug as 'flipYZ' | 'raw' | 'isotropic'
          })
      )
      .then(loaded => {
        if (cancelled) {
          return
        }
        console.log(
          `[SplatLayer] SPZ loaded: ${loaded.count.toLocaleString()} splats in ${Math.round(performance.now() - started)} ms`
        )
        setData(loaded)
      })
      .catch((error: unknown) => {
        console.error('[SplatLayer] SPZ load failed:', error)
      })
    return () => {
      cancelled = true
    }
  }, [spzUrl, maxSplats, debug])

  // Place + orient the cloud at the target via the local ENU frame: offset by
  // east/north/up metres, align local +Y to up, then yaw about up. Mirrors the
  // ShipModel placement so the capture tunes like the other site 3D models.
  const { position, quaternion } = useMemo(() => {
    const east = new Vector3()
    const north = new Vector3()
    const up = new Vector3()
    Ellipsoid.WGS84.getEastNorthUpVectors(target, east, north, up)
    const qUp = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), up)
    const qYaw = new Quaternion().setFromAxisAngle(
      up,
      MathUtils.degToRad(yawDeg)
    )
    const q = qYaw.multiply(qUp)
    const pos = target
      .clone()
      .addScaledVector(east, eastOffset)
      .addScaledVector(north, northOffset)
      .addScaledVector(up, heightOffset)
    return {
      position: pos.toArray() as [number, number, number],
      quaternion: q.toArray() as [number, number, number, number]
    }
  }, [target, eastOffset, northOffset, heightOffset, yawDeg])

  if (!enabled || data == null) {
    return null
  }
  // Portal the shared component into the dedicated splat scene so it renders in its
  // own pass and the twin composites it after the atmosphere. logarithmicDepthBuffer
  // + depthWrite match the twin renderer and feed approach-A's occlusion mask.
  return createPortal(
    <GaussianSplatsGPU
      data={data}
      position={position}
      quaternion={quaternion}
      scale={scale}
      intensity={intensity}
      lod={{ budget }}
      logarithmicDepthBuffer
      depthWrite
    />,
    splatScene
  )
}
