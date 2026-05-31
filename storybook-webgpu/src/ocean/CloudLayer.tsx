// CloudLayer.tsx — Lightweight planetary cloud shell for the WebGPU globe scene.
// A transparent DoubleSide sphere at cloud altitude over the WGS84 ellipsoid whose
// opacity comes from one of two coverage sources: 'procedural' (inline TSL FBM
// noise, art-directable for the mood presets) or 'live' (near-real-time global
// cloud cover from matteason's Live Cloud Maps, equirectangular, EUMETSAT-
// derived). No volumetric raymarch — a single textured shell, cheap; atmospheric
// tint comes from the aerial-perspective post-pass as ordinary scene geometry.

import { useEffect, useMemo, type FC } from 'react'
import {
  Color,
  DoubleSide,
  NoColorSpace,
  RepeatWrapping,
  TextureLoader,
  Vector3,
} from 'three'
import {
  asin,
  atan,
  dot,
  float,
  mx_fractal_noise_float,
  normalize,
  positionWorld,
  smoothstep,
  texture,
  time,
  uniform,
  vec2,
  vec3,
} from 'three/tsl'
import { MeshBasicNodeMaterial, type UniformNode } from 'three/webgpu'

import { Ellipsoid } from '@takram/three-geospatial'

interface CloudLayerProps {
  /** Metres above the WGS84 ellipsoid for the cloud shell. */
  altitude?: number
  /** Global opacity multiplier. */
  opacity?: number
  /** Coverage threshold — higher = sparser clouds. */
  coverage?: number
  /** UV scroll speed (wind). */
  windSpeed?: number
  /** Noise tiling — higher = smaller, more frequent cloud blobs. */
  tiles?: number
  /**
   * TO-sun direction in the scene's world frame (ECEF) — the atmosphere
   * context's `sunDirectionECEF` uniform. Drives day/night brightness and
   * terminator shading. Omit for always-lit (no sun darkening).
   */
  sunDirection?: UniformNode<Vector3>
  /** Lit (day) cloud colour. */
  dayColor?: string
  /** Ambient floor at night so clouds aren't pure black. */
  nightAmbient?: number
  /** Density darkening — dense cores go darker (0 = flat, 1 = black cores). */
  density?: number
  /**
   * Radiance multiplier. Clouds are among the brightest things in a daytime
   * scene; >1 lets them punch through the atmosphere's aerial-perspective wash
   * instead of dissolving into the sky. Lower for dimmer/moodier skies.
   */
  intensity?: number
  /**
   * Coverage source. 'procedural' = inline FBM noise (art-directable, the mood
   * presets). 'live' = near-real-time global cloud cover from matteason's Live
   * Cloud Maps (equirectangular, EUMETSAT-derived, refreshed ~3h). In live mode
   * cloud POSITIONS are real/fixed, so coverage/tiles/windSpeed have no effect;
   * the grading knobs (color/density/intensity/sun) still apply. Requires
   * attribution: "Contains modified EUMETSAT data".
   */
  source?: 'procedural' | 'live'
}

const LIVE_CLOUDS_URL =
  'https://clouds.matteason.co.uk/images/2048x1024/clouds-alpha.png'

export const CloudLayer: FC<CloudLayerProps> = ({
  altitude = 4000,
  opacity = 0.9,
  coverage = 0.45,
  windSpeed = 0.004,
  tiles = 10,
  sunDirection,
  dayColor = '#ffffff',
  nightAmbient = 0.03,
  density = 0.1,
  intensity = 2.5,
  source = 'procedural',
}) => {
  // Stable uniforms so prop tweaks don't rebuild the material/graph.
  const opacityU = useMemo(() => uniform(opacity), [])
  const coverageU = useMemo(() => uniform(coverage), [])
  const tilesU = useMemo(() => uniform(tiles), [])
  const windU = useMemo(() => uniform(windSpeed), [])
  const ambientU = useMemo(() => uniform(nightAmbient), [])
  const dayColorU = useMemo(() => uniform(new Color(dayColor)), [])
  const densityU = useMemo(() => uniform(density), [])
  const intensityU = useMemo(() => uniform(intensity), [])
  opacityU.value = opacity
  coverageU.value = coverage
  tilesU.value = tiles
  windU.value = windSpeed
  ambientU.value = nightAmbient
  dayColorU.value.set(dayColor)
  densityU.value = density
  intensityU.value = intensity

  const radius = Ellipsoid.WGS84.maximumRadius + altitude

  // Live cloud-cover texture (equirectangular). Loaded only in 'live' mode.
  const cloudTex = useMemo(() => {
    if (source !== 'live') return null
    const t = new TextureLoader().load(LIVE_CLOUDS_URL)
    t.wrapS = RepeatWrapping
    t.colorSpace = NoColorSpace
    t.flipY = false // deterministic: image top row at v=0 (north), matches v below
    return t
  }, [source])
  useEffect(() => () => cloudTex?.dispose(), [cloudTex])

  const material = useMemo(() => {
    const mat = new MeshBasicNodeMaterial()
    mat.transparent = true
    // Write depth so the aerial-perspective post-pass treats cloud pixels as
    // geometry and doesn't paint the atmosphere sky over them. alphaTest
    // discards the gaps between clouds so real sky shows there (rather than a
    // fogged dome from depth-written transparent gaps).
    mat.depthWrite = true
    mat.alphaTest = 0.05
    mat.side = DoubleSide // visible from inside (ground) and outside (space)

    const dir = normalize(positionWorld)
    let cov
    if (source === 'live' && cloudTex != null) {
      // Equirectangular UV from ECEF lon/lat. ECEF: +X→(0°N,0°E), +Y→(0°N,90°E),
      // +Z→north pole. With flipY=false, image top row (north) is at v=0.
      const lon = atan(dir.y, dir.x)
      const lat = asin(dir.z)
      const equiUV = vec2(
        lon.div(Math.PI * 2).add(0.5),
        float(0.5).sub(lat.div(Math.PI))
      )
      cov = texture(cloudTex, equiUV).a.saturate() // alpha = cloud presence
    } else {
      // Fractal (FBM) noise sampled by world DIRECTION — uniform cloud scale, no
      // pole distortion. `tiles` = angular frequency; scrolled by wind.
      const p = dir.mul(tilesU).add(vec3(time.mul(windU), float(0), float(0)))
      const n = mx_fractal_noise_float(p, 6, 2.0, 0.5)
      cov = n.mul(float(0.5)).add(float(0.5)).saturate()
    }
    const edged = smoothstep(coverageU, coverageU.add(float(0.25)), cov)

    // Day/night + terminator shading from the sun direction (TO-sun · cloud-up).
    // At night (sun below the cloud's horizon) brightness falls to nightAmbient
    // so clouds aren't lit white in the dark; at the terminator the sun-facing
    // side stays bright while the far side darkens (the moody-lighting basis).
    const brightness =
      sunDirection != null
        ? ambientU.add(
            smoothstep(
              float(-0.15),
              float(0.25),
              dot(normalize(positionWorld), sunDirection)
            ).mul(float(1).sub(ambientU))
          )
        : float(1)
    // Density darkening: dense cores (cov well above the coverage threshold)
    // get darker, reading as heavy cloud undersides from the ground. Thin
    // edges (cov near threshold) stay bright/wispy.
    const thickness = smoothstep(coverageU, float(1.0), cov)
    const densityFactor = float(1).sub(densityU.mul(thickness))
    mat.colorNode = vec3(dayColorU)
      .mul(brightness)
      .mul(densityFactor)
      .mul(intensityU)
    mat.opacityNode = edged.mul(opacityU)
    return mat
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, cloudTex])

  return (
    <mesh material={material} frustumCulled={false}>
      <sphereGeometry args={[radius, 64, 48]} />
    </mesh>
  )
}
