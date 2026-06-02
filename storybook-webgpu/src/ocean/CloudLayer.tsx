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
    // geometry and doesn't paint the atmosphere sky over them. alphaTest
    // discards the gaps between clouds so real sky shows there.
    mat.depthWrite = true
    mat.alphaTest = 0.05
    mat.side = DoubleSide // visible from inside (ground) and outside (space)

    // sampleCloud → vec4(litAlbedo, edgedCoverage). Shell adds the emissive
    // `intensity` punch so clouds carry through the atmosphere wash; reflections
    // deliberately omit it (AgX-safe).
    const s = field.sampleCloud(normalize(positionWorld)) as any
    mat.colorNode = s.rgb.mul(field.uniforms.intensity)
    mat.opacityNode = s.a.mul(field.uniforms.opacity)
    return mat
  }, [field])

  return (
    <mesh material={material} frustumCulled={false}>
      <sphereGeometry args={[radius, 64, 48]} />
    </mesh>
  )
}
