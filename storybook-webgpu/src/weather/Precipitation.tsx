// Precipitation.tsx — Thin R3F wrapper that mounts the precipitation system.
// Owns nothing but lifecycle: builds the detachable engine once, re-anchors it to
// the camera each frame, derives the altitude visibility fade and the ENU wind
// vector from props, and pushes them in. All visuals live in the pure factory
// (createPrecipitationSystem). Detach the whole effect by removing this element.

import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef, type FC } from 'react'
import type { Scene } from 'three'
import { Vector3 } from 'three'

import {
  createPrecipitationSystem,
  EARTH_MAX_RADIUS,
  type PrecipitationValues
} from './createPrecipitationSystem'

const DEG = Math.PI / 180

export interface PrecipitationProps {
  /** Normalized fall density [0,1]. */
  intensity: number
  /** 0 = rain, 1 = snow. */
  mode: number
  /** Wind at 10 m, metres/second. */
  windSpeedMps: number
  /** Meteorological bearing the wind blows FROM (deg). */
  windFromDeg: number
  opacity?: number
  /** Camera-local box + drop dimensions, metres. */
  area?: number
  height?: number
  dropLength?: number
  dropWidth?: number
  flakeSize?: number
  fallSpeedRain?: number
  fallSpeedSnow?: number
  /** Altitude band (m above the ellipsoid) over which the field fades out. */
  fadeStartAlt?: number
  fadeEndAlt?: number
  /** Maximum drop budget allocated on the GPU. */
  maxCount?: number
  /** Live submerged factor getter: 0 above water → 1 fully underwater. Read every
   *  frame (it changes faster than React renders) so the value can't lag. Drives
   *  the underwater morph (rain/snow → slow suspended specks). */
  submerged?: () => number
  /** Baseline particle density when fully submerged — there are always suspended
   *  particles underwater, independent of whether it's raining above. */
  underwaterIntensity?: number
  /** Underwater speck params: slow upward rise (m/s), speck size (m), opacity. */
  uwRise?: number
  uwSize?: number
  uwOpacity?: number
  /** Sea-level radius (m) for the altitude fade — pass the local site radius
   *  (target.length()). Defaults to the WGS84 equatorial radius, which is wrong by
   *  up to ~20 km at non-equatorial latitudes. */
  seaLevelRadius?: number
  /** Scene to mount into — pass the post-processing overlay scene so rain
   *  composites AFTER the atmosphere pass. Defaults to the R3F scene. */
  scene?: Scene
}

export const Precipitation: FC<PrecipitationProps> = props => {
  const {
    fadeStartAlt = 1500,
    fadeEndAlt = 6000,
    maxCount = 30000,
    scene: targetScene
  } = props

  const camera = useThree(({ camera }) => camera)

  const system = useMemo(
    () => createPrecipitationSystem({ maxCount }),
    [maxCount]
  )
  useEffect(() => () => { system.dispose(); }, [system])

  // Mount into the target scene (the post overlay scene → composites after the
  // atmosphere). Imperative add: overlayScene is a plain Scene, not R3F-managed.
  useEffect(() => {
    if (targetScene == null) return
    targetScene.add(system.object3D)
    return () => {
      targetScene.remove(system.object3D)
    }
  }, [targetScene, system])

  // Latest props read inside the frame loop without re-subscribing useFrame.
  const propsRef = useRef(props)
  propsRef.current = props
  const fadeRef = useRef({ fadeStartAlt, fadeEndAlt })
  fadeRef.current = { fadeStartAlt, fadeEndAlt }

  const camPos = useMemo(() => new Vector3(), [])

  useFrame(() => {
    const pr = propsRef.current
    const { fadeStartAlt: a0, fadeEndAlt: a1 } = fadeRef.current

    system.update(camera)

    // Altitude fade: 1 below the band, 0 above it (smoothstep). The reference is
    // the LOCAL site radius (target.length()); the WGS84 max radius is wrong by up
    // to ~20 km at high latitude and would shove the fade band kilometres off.
    camera.getWorldPosition(camPos)
    const alt = camPos.length() - (pr.seaLevelRadius ?? EARTH_MAX_RADIUS)
    const t = a1 > a0 ? (alt - a0) / (a1 - a0) : 0
    const clamped = t < 0 ? 0 : t > 1 ? 1 : t
    const fade = 1 - clamped * clamped * (3 - 2 * clamped)

    // Live submerged factor (0→1). Underwater always carries a baseline density of
    // suspended specks, independent of the rain above. The baseline scales with
    // sub² (not sub) so on surfacing it collapses EARLY in the ~0.2 s ease — when
    // it isn't raining, the brief "water off the camera" clears quickly instead of
    // lingering as falling rain. Actual rain (pr.intensity) is unaffected via max().
    const sub = pr.submerged?.() ?? 0
    const effIntensity = Math.max(pr.intensity, (pr.underwaterIntensity ?? 0.4) * sub * sub)

    // Meteorological FROM bearing → ENU vector the wind blows TO. Wind only applies
    // when it's actually RAINING (rain amount > ~0); with no rain the underwater
    // baseline / surface-transition "water off the camera" falls straight vertical
    // rather than wind-slanted — it reads as water on the lens, not rain in wind.
    const toBearing = (pr.windFromDeg + 180) * DEG
    const windScale = Math.min(pr.intensity / 0.03, 1)
    const speed = pr.windSpeedMps * windScale

    const values: PrecipitationValues = {
      intensity: effIntensity,
      opacity: pr.opacity ?? 0.05,
      mode: pr.mode,
      fade,
      windEast: speed * Math.sin(toBearing),
      windNorth: speed * Math.cos(toBearing),
      area: pr.area ?? 35,
      height: pr.height ?? 45,
      dropLength: pr.dropLength ?? 0.9,
      dropWidth: pr.dropWidth ?? 0.04,
      flakeSize: pr.flakeSize ?? 0.25,
      fallSpeedRain: pr.fallSpeedRain ?? 9,
      fallSpeedSnow: pr.fallSpeedSnow ?? 1.2,
      uw: sub,
      uwRise: pr.uwRise ?? 0.12,
      uwSize: pr.uwSize ?? 0.05,
      uwOpacity: pr.uwOpacity ?? 0.06
    }
    system.sync(values)
  })

  // When mounted into an external scene, the component renders nothing in the R3F
  // tree (the object3D lives in that scene); otherwise add it to the R3F scene.
  return targetScene != null ? null : <primitive object={system.object3D} />
}
