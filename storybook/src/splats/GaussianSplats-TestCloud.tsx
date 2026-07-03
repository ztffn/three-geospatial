import { OrbitControls } from '@react-three/drei'
import { Canvas } from '@react-three/fiber'
import type { StoryFn } from '@storybook/react-vite'
import { useMemo, type FC } from 'react'

import type { GaussianSplatData } from '@takram/three-geospatial-splats'
import { GaussianSplats } from '@takram/three-geospatial-splats/r3f'

// Generates a genuine Gaussian splat dataset shaped as a thick sphere shell,
// colored by surface direction. This exercises the full pipeline (covariance
// construction, depth sorting, EWA projection) without an external asset.
function createSphereSplatCloud(count: number): GaussianSplatData {
  const positions = new Float32Array(count * 3)
  const scales = new Float32Array(count * 3)
  const rotations = new Float32Array(count * 4)
  const colors = new Uint8Array(count * 4)

  // log(0.03): small, roughly isotropic splats.
  const logScale = Math.log(0.03)

  for (let i = 0; i < count; ++i) {
    // Uniformly distributed direction on the unit sphere.
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

    // Identity orientation (WXYZ).
    rotations[i * 4] = 1

    // Color by direction so the sphere reads clearly.
    colors[i * 4] = Math.round((nx * 0.5 + 0.5) * 255)
    colors[i * 4 + 1] = Math.round((ny * 0.5 + 0.5) * 255)
    colors[i * 4 + 2] = Math.round((nz * 0.5 + 0.5) * 255)
    colors[i * 4 + 3] = 255
  }

  return { count, positions, scales, rotations, colors }
}

const Scene: FC = () => {
  const data = useMemo(() => createSphereSplatCloud(50000), [])
  return (
    <>
      <OrbitControls />
      <GaussianSplats data={data} />
    </>
  )
}

const Story: StoryFn = () => {
  return (
    <Canvas camera={{ fov: 45, position: [3, 1, 3] }}>
      <color attach='background' args={[0.02, 0.02, 0.04]} />
      <Scene />
    </Canvas>
  )
}

export default Story
