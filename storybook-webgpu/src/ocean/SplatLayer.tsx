// Georeferenced Gaussian-splat layer for the Globe WaterPro twin scene. Places a
// splat cloud at the active-location ECEF target (ENU-oriented, leva-tunable
// scale/height/intensity) and renders it via the WebGPU GaussianSplatNodeMaterial
// as a sibling of the terrain in the same scene, so the twin's pass(scene,camera)
// depth-composites it against the 3D tiles (log-depth matched). Minimal proof of
// splats-in-twin; the procedural sphere-shell cloud stands in until real captures.

import { useFrame, useThree } from '@react-three/fiber'
import { useControls } from 'leva'
import { useEffect, useMemo, type FC } from 'react'
import { Quaternion, Vector3 } from 'three'
import type { Renderer } from 'three/webgpu'

import { Ellipsoid } from '@takram/three-geospatial'
import {
  GaussianSplatMesh,
  GaussianSplatNodeMaterial,
  type GaussianSplatData
} from '@takram/three-geospatial-splats/webgpu'

// Procedural splat dataset: a thick sphere shell colored by surface direction.
// Identical to the storybook NodeMaterial story so the in-twin render can be
// compared against the verified isolated one.
function createSphereSplatCloud(count: number): GaussianSplatData {
  const positions = new Float32Array(count * 3)
  const scales = new Float32Array(count * 3)
  const rotations = new Float32Array(count * 4)
  const colors = new Uint8Array(count * 4)
  const logScale = Math.log(0.03)

  for (let i = 0; i < count; ++i) {
    const u = Math.random() * 2 - 1
    const phi = Math.random() * Math.PI * 2
    const r = Math.sqrt(1 - u * u)
    const nx = r * Math.cos(phi)
    const ny = r * Math.sin(phi)
    const nz = u
    const radius = 1 + (Math.random() - 0.5) * 0.1

    positions[i * 3] = nx * radius
    positions[i * 3 + 1] = ny * radius
    positions[i * 3 + 2] = nz * radius

    scales[i * 3] = logScale
    scales[i * 3 + 1] = logScale
    scales[i * 3 + 2] = logScale

    rotations[i * 4] = 1

    colors[i * 4] = Math.round((nx * 0.5 + 0.5) * 255)
    colors[i * 4 + 1] = Math.round((ny * 0.5 + 0.5) * 255)
    colors[i * 4 + 2] = Math.round((nz * 0.5 + 0.5) * 255)
    colors[i * 4 + 3] = 255
  }

  return { count, positions, scales, rotations, colors }
}

export const SplatLayer: FC<{ target: Vector3 }> = ({ target }) => {
  const { enabled, scale, heightOffset, intensity } = useControls('Splats', {
    enabled: true,
    // Sphere-shell is unit radius, so `scale` is the cloud radius in metres.
    scale: { value: 25, min: 1, max: 1000, step: 1 },
    heightOffset: { value: 25, min: -200, max: 2000, step: 1 },
    // Radiance scale into the AgX HDR range (1 = raw 0..1 colors → blown out).
    intensity: { value: 0.1, min: 0, max: 2, step: 0.01 }
  })

  const renderer = useThree<Renderer>(({ gl }) => gl as unknown as Renderer)
  const camera = useThree(({ camera }) => camera)

  const { mesh, material } = useMemo(() => {
    const data = createSphereSplatCloud(50000)
    let nodeMaterial!: GaussianSplatNodeMaterial
    const splatMesh = new GaussianSplatMesh(data, {
      createMaterial: geometry => {
        // Dither-opaque mode: the splats render as opaque depth-writing geometry
        // (stochastic discard ∝ alpha, resolved by the twin's TAA), so the scene
        // pass occludes them against terrain/ocean/models and the deferred
        // aerial-perspective pass tints them — no translucent silhouette (no
        // black halo over the unrendered-sky clear color), no dedicated pass.
        // logarithmicDepthBuffer matches the twin renderer so the per-splat
        // depthNode emits log depth and depth-tests correctly at globe scale.
        nodeMaterial = new GaussianSplatNodeMaterial(geometry, {
          logarithmicDepthBuffer: true,
          dither: true
        })
        return nodeMaterial
      }
    })
    return { mesh: splatMesh, material: nodeMaterial }
  }, [])

  useEffect(() => {
    return () => {
      mesh.dispose()
    }
  }, [mesh])

  useEffect(() => {
    material.intensity.value = intensity
  }, [material, intensity])

  // Place the cloud at the target, lifted along the local surface up vector, with
  // its local +Y aligned to up (ENU) — the same convention as the turbine farm.
  const { position, quaternion } = useMemo(() => {
    const east = new Vector3()
    const north = new Vector3()
    const up = new Vector3()
    Ellipsoid.WGS84.getEastNorthUpVectors(target, east, north, up)
    const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), up)
    const pos = target.clone().addScaledVector(up, heightOffset)
    return {
      position: pos.toArray() as [number, number, number],
      quaternion: q.toArray() as [number, number, number, number]
    }
  }, [target, heightOffset])

  useFrame(() => {
    if (enabled) {
      mesh.update(renderer, camera)
    }
  })

  if (!enabled) {
    return null
  }
  return (
    <group position={position} quaternion={quaternion} scale={scale}>
      <primitive object={mesh} />
    </group>
  )
}
