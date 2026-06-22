// WebGPU storybook story for the Gaussian splat node material. Renders a
// procedurally generated splat cloud (a colored sphere shell) under the Three.js
// WebGPU renderer via GaussianSplatNodeMaterial, exercising the full TSL path
// (covariance reconstruction, clip-space EWA projection, depth sorting) without
// depending on an external .ply / LFS asset.

import { OrbitControls } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, type FC } from 'react'
import type { Renderer } from 'three/webgpu'

import {
  GaussianSplatMesh,
  GaussianSplatNodeMaterial,
  type GaussianSplatData
} from '@takram/three-geospatial-splats/webgpu'

import type { StoryFC } from '../components/createStory'
import { Description } from '../components/Description'
import { WebGPUCanvas } from '../components/WebGPUCanvas'
import { rendererArgs, rendererArgTypes } from '../controls/rendererControls'

// Generates a genuine Gaussian splat dataset shaped as a thick sphere shell,
// colored by surface direction, so the covariance and sort paths are exercised.
function createSphereSplatCloud(count: number): GaussianSplatData {
  const positions = new Float32Array(count * 3)
  const scales = new Float32Array(count * 3)
  const rotations = new Float32Array(count * 4)
  const colors = new Uint8Array(count * 4)

  // log(0.03): small, roughly isotropic splats.
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

    // Identity orientation (WXYZ).
    rotations[i * 4] = 1

    colors[i * 4] = Math.round((nx * 0.5 + 0.5) * 255)
    colors[i * 4 + 1] = Math.round((ny * 0.5 + 0.5) * 255)
    colors[i * 4 + 2] = Math.round((nz * 0.5 + 0.5) * 255)
    colors[i * 4 + 3] = 255
  }

  return { count, positions, scales, rotations, colors }
}

const Content: FC = () => {
  const renderer = useThree<Renderer>(({ gl }) => gl as unknown as Renderer)
  const camera = useThree(({ camera }) => camera)

  const mesh = useMemo(() => {
    const data = createSphereSplatCloud(50000)
    return new GaussianSplatMesh(data, {
      createMaterial: geometry => new GaussianSplatNodeMaterial(geometry)
    })
  }, [])

  useEffect(() => {
    return () => {
      mesh.dispose()
    }
  }, [mesh])

  useFrame(() => {
    mesh.update(renderer, camera)
  })

  return (
    <>
      <color attach='background' args={[0.02, 0.02, 0.04]} />
      <OrbitControls />
      <primitive object={mesh} />
    </>
  )
}

interface StoryProps {}

export const Story: StoryFC<StoryProps> = () => (
  <WebGPUCanvas camera={{ fov: 45, position: [3, 1, 3] }}>
    <Content />
    <Description />
  </WebGPUCanvas>
)

Story.args = {
  ...rendererArgs()
}

Story.argTypes = {
  ...rendererArgTypes()
}
