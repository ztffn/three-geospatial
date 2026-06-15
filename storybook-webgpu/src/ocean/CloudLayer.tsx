// CloudLayer.tsx — Lightweight planetary cloud shell for the WebGPU globe scene.
// A transparent DoubleSide sphere at cloud altitude over the WGS84 ellipsoid. Its
// coverage/colour come from the SHARED cloud field (see cloud-coverage.ts) so the
// shell, the ocean's cloud reflection, and the ocean's cloud shadow all sample
// one identical model. No volumetric raymarch — a single shaded shell, cheap;
// atmospheric tint comes from the aerial-perspective post-pass as scene geometry.

import { useMemo, type FC } from 'react'
import { DoubleSide } from 'three'
import { normalize, positionWorld } from 'three/tsl'
import { MeshBasicNodeMaterial } from 'three/webgpu'

import { Ellipsoid } from '@takram/three-geospatial'
import type { CloudField } from './cloud-coverage'

/** Coverage value below which a fragment is treated as a sky gap and discarded. */
const COVERAGE_CLIP = 0.05

interface CloudLayerProps {
  /** Shared cloud field (uniforms + coverage sampler). */
  field: CloudField
  /** Metres above the WGS84 ellipsoid — drives the shell geometry radius. */
  altitude?: number
}

export const CloudLayer: FC<CloudLayerProps> = ({ field, altitude = 4000 }) => {
  const radius = Ellipsoid.WGS84.maximumRadius + altitude

  const material = useMemo(() => {
    const mat = new MeshBasicNodeMaterial()
    mat.transparent = true
    // Write depth so the aerial-perspective post-pass treats cloud pixels as
    // geometry and doesn't paint the atmosphere sky over them. The alpha-test
    // discards the gaps between clouds so real sky shows there.
    mat.depthWrite = true
    mat.side = DoubleSide // visible from inside (ground) and outside (space)

    // sampleCloud → vec4(litAlbedo, edgedCoverage). Shell adds the emissive
    // `intensity` punch so clouds carry through the atmosphere wash; reflections
    // deliberately omit it (AgX-safe).
    const s = field.sampleCloud(normalize(positionWorld)) as any
    mat.colorNode = s.rgb.mul(field.uniforms.intensity)
    mat.opacityNode = s.a.mul(field.uniforms.opacity)
    // Gap-discard threshold in COVERAGE space. The discard tests the dimmed
    // output alpha (edged·opacity); scaling the threshold by the SAME opacity
    // keeps the clip at a constant coverage point (edged ≤ COVERAGE_CLIP) no
    // matter how low global opacity goes. A fixed scalar alphaTest would instead
    // move the clip up the soft smoothstep ramp as opacity drops — hard-cutting
    // the fade into a crisp rim. At opacity 0 this discards everything, so the
    // shell writes no stray depth. Uniform-driven node → no per-frame rebuild.
    mat.alphaTestNode = field.uniforms.opacity.mul(COVERAGE_CLIP)
    return mat
  }, [field])

  return (
    <mesh material={material} frustumCulled={false}>
      <sphereGeometry args={[radius, 64, 48]} />
    </mesh>
  )
}
