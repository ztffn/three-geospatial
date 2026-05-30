// CloudLayer.tsx — Lightweight planetary cloud shell for the WebGPU globe scene.
// Renders a transparent BackSide sphere at cloud altitude over the WGS84
// ellipsoid whose opacity is driven by inline TSL fractal noise
// (mx_fractal_noise_float) over the sphere UVs, scrolled by time. No volumetric
// raymarch and no compute pipeline — a single textured shell, cheap;
// atmospheric tint comes from the aerial-perspective post-pass since the shell
// is ordinary scene geometry.

import { useMemo, type FC } from 'react'
import { BackSide, Color, Vector3 } from 'three'
import {
  dot,
  float,
  mx_fractal_noise_float,
  normalize,
  positionWorld,
  smoothstep,
  time,
  uniform,
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
}

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

  const material = useMemo(() => {
    const mat = new MeshBasicNodeMaterial()
    mat.transparent = true
    // Write depth so the aerial-perspective post-pass treats cloud pixels as
    // geometry and doesn't paint the atmosphere sky over them. alphaTest
    // discards the gaps between clouds so real sky shows there (rather than a
    // fogged dome from depth-written transparent gaps).
    mat.depthWrite = true
    mat.alphaTest = 0.05
    mat.side = BackSide

    // Fractal (FBM) noise sampled by world DIRECTION on the shell (not the
    // equirectangular UV, which distorts at the poles and barely varies across
    // the small patch of sky visible from ground level). `tiles` is the angular
    // frequency — higher = smaller, more numerous cloud blobs. Scrolled by wind.
    const dir = normalize(positionWorld)
    const p = dir.mul(tilesU).add(vec3(time.mul(windU), float(0), float(0)))
    const n = mx_fractal_noise_float(p, 6, 2.0, 0.5)
    const cov = n.mul(float(0.5)).add(float(0.5)).saturate()
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
  }, [])

  return (
    <mesh material={material} frustumCulled={false}>
      <sphereGeometry args={[radius, 64, 48]} />
    </mesh>
  )
}
