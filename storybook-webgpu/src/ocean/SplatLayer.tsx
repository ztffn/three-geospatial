// Georeferenced Gaussian-splat capture layer for the Globe WaterPro twin. Loads
// an SPZ capture (spz-js → GaussianSplatData) and renders it premultiplied via
// GaussianSplatNodeMaterial into a dedicated `splatScene`, which the twin
// composites AFTER the atmosphere pass (approach A: over the lit sky → no black
// halo, depth-masked so terrain/models occlude it). Placed at the scenario
// target with ShipModel-style fine-tune controls (east/north/height/scale/yaw).
// Renders nothing unless an `spzUrl` is given (i.e. the Realtime Geospatial site).

import { createPortal, useFrame, useThree } from '@react-three/fiber'
import { useControls } from 'leva'
import { useEffect, useMemo, useState, type FC } from 'react'
import { MathUtils, Quaternion, Vector3, type Scene } from 'three'
import type { Renderer } from 'three/webgpu'

import { Ellipsoid } from '@takram/three-geospatial'
import {
  GaussianSplatMesh,
  GaussianSplatNodeMaterial,
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
    maxSplats,
    debug
  } = useControls('Splats', {
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
    // Decimation hedge for the single-mesh path (CPU sort + data-texture cost
    // scale with count). 0 = full. Reloads on change. (The full decode still runs
    // regardless; spz-js can't partial-decode the compressed stream.)
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
  })

  const renderer = useThree<Renderer>(({ gl }) => gl as unknown as Renderer)
  const camera = useThree(({ camera }) => camera)

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
      .then(response => {
        if (!response.ok) {
          throw new Error(`SPZ fetch ${response.status} for ${spzUrl}`)
        }
        return response.arrayBuffer()
      })
      .then(buffer =>
        loadSpzSplatData(buffer, {
          ...(maxSplats > 0 ? { maxSplats } : {}),
          debug: debug as 'flipYZ' | 'raw' | 'isotropic'
        })
      )
      .then(loaded => {
        if (cancelled) {
          return
        }
        // eslint-disable-next-line no-console
        console.log(
          `[SplatLayer] SPZ loaded: ${loaded.count.toLocaleString()} splats in ${Math.round(performance.now() - started)} ms`
        )
        setData(loaded)
      })
      .catch((error: unknown) => {
        // eslint-disable-next-line no-console
        console.error('[SplatLayer] SPZ load failed:', error)
      })
    return () => {
      cancelled = true
    }
  }, [spzUrl, maxSplats, debug])

  const meshState = useMemo(() => {
    if (data == null) {
      return null
    }
    let nodeMaterial!: GaussianSplatNodeMaterial
    const splatMesh = new GaussianSplatMesh(data, {
      createMaterial: geometry => {
        // Twin renderer uses logarithmicDepthBuffer; match it so the splat pass
        // writes log-depth comparable to the main scene depth. depthWrite so the
        // splat pass produces a depth buffer for approach A's occlusion mask.
        nodeMaterial = new GaussianSplatNodeMaterial(geometry, {
          logarithmicDepthBuffer: true,
          depthWrite: true
        })
        return nodeMaterial
      }
    })
    return { mesh: splatMesh, material: nodeMaterial }
  }, [data])

  useEffect(() => {
    const mesh = meshState?.mesh
    return () => {
      mesh?.dispose()
    }
  }, [meshState])

  useEffect(() => {
    if (meshState != null) {
      meshState.material.intensity.value = intensity
    }
  }, [meshState, intensity])

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

  useFrame(() => {
    if (enabled && meshState != null) {
      meshState.mesh.update(renderer, camera)
    }
  })

  if (!enabled || meshState == null) {
    return null
  }
  // Portal into the dedicated splat scene so it renders in its own pass and the
  // twin composites it after the atmosphere (see GlobeWaterproOcean-Story).
  return createPortal(
    <group position={position} quaternion={quaternion} scale={scale}>
      <primitive object={meshState.mesh} />
    </group>,
    splatScene
  )
}
