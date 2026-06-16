import { OrbitControls } from '@react-three/drei'
import { useThree } from '@react-three/fiber'
import {
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
  type FC
} from 'react'
import { Color } from 'three'

import type { StoryFC } from '../components/createStory'
import { WebGPUCanvas } from '../components/WebGPUCanvas'
import { useControl } from '../hooks/useControl'
import { FishSchool } from './FishSchool'

interface StoryArgs {
  largeCount: number
  largeSize: number
  largeRadiusX: number
  largeRadiusZ: number
  largeDepth: number
  largeSpeed: number
  largeTailBeat: number
  largeTailAmplitude: number
  largeFlock: number
  smallCount: number
  smallSize: number
  smallRadiusX: number
  smallRadiusZ: number
  smallDepth: number
  smallSpeed: number
  smallTailBeat: number
  smallTailAmplitude: number
  smallFlock: number
  smallFlockGroups: number
  largeFlockGroups: number
  flockScale: number
  metalness: number
  roughness: number
  brightness: number
  wander: number
  currentX: number
  currentZ: number
  showBounds: boolean
}

// Single source of truth for the story defaults — also used by ExportControls
// to know which keys to emit (the live args object also carries renderer globals).
const DEFAULT_ARGS: StoryArgs = {
  largeCount: 5,
  largeSize: 1,
  largeRadiusX: 220,
  largeRadiusZ: 160,
  largeDepth: 10.5,
  largeSpeed: 2.2,
  largeTailBeat: 4,
  largeTailAmplitude: 0.05,
  largeFlock: 0.18,
  smallCount: 275,
  smallSize: 1,
  smallRadiusX: 240,
  smallRadiusZ: 180,
  smallDepth: 18.5,
  smallSpeed: 8.8,
  smallTailBeat: 10,
  smallTailAmplitude: 0.09,
  smallFlock: 1,
  smallFlockGroups: 5,
  largeFlockGroups: 4,
  flockScale: 0.045,
  metalness: 0,
  roughness: 0.4,
  brightness: 0.4,
  wander: 0.35,
  currentX: 0.4,
  currentZ: 0,
  showBounds: false
}

const Content: FC = () => {
  const args = useControl((args: StoryArgs) => args)

  return (
    <>
      <SceneSetup />
      <ambientLight intensity={1.2} />
      <directionalLight position={[30, 60, 40]} intensity={1.8} />
      <directionalLight
        position={[-40, 20, -30]}
        intensity={0.6}
        color='#74d6ff'
      />

      <mesh rotation-x={-Math.PI / 2} position={[0, -0.15, 0]}>
        <planeGeometry args={[260, 180, 1, 1]} />
        <meshBasicMaterial color='#082a47' transparent opacity={0.72} />
      </mesh>

      <gridHelper
        args={[180, 18, '#1b6f86', '#0e415d']}
        position={[0, -0.1, 0]}
      />

      <FishSchool
        textureUrl='/public/fish/largefish-cutout.png'
        normalUrl='/public/fish/largefish-normal.png'
        maxCount={256}
        count={args.largeCount}
        fishLength={12}
        fishHeight={6.2}
        fishWidthSegments={12}
        radiusX={args.largeRadiusX}
        radiusZ={args.largeRadiusZ}
        depth={args.largeDepth}
        size={args.largeSize}
        speed={args.largeSpeed}
        tailBeat={args.largeTailBeat}
        tailAmplitude={args.largeTailAmplitude}
        flock={args.largeFlock}
        flockScale={args.flockScale}
        flockGroups={args.largeFlockGroups}
        metalness={args.metalness}
        roughness={args.roughness}
        brightness={args.brightness}
        wander={args.wander}
        turnRate={1}
        currentX={args.currentX}
        currentZ={args.currentZ}
        opacity={1}
        seed={10}
        debug={args.showBounds}
      />
      <FishSchool
        textureUrl='/public/fish/smallfish-cutout.png'
        normalUrl='/public/fish/smallfish-normal.png'
        maxCount={2048}
        count={args.smallCount}
        fishLength={4}
        fishHeight={1.74}
        fishWidthSegments={8}
        radiusX={args.smallRadiusX}
        radiusZ={args.smallRadiusZ}
        depth={args.smallDepth}
        size={args.smallSize}
        speed={args.smallSpeed}
        tailBeat={args.smallTailBeat}
        tailAmplitude={args.smallTailAmplitude}
        flock={args.smallFlock}
        flockScale={args.flockScale}
        flockGroups={args.smallFlockGroups}
        metalness={args.metalness}
        roughness={args.roughness}
        brightness={args.brightness}
        wander={args.wander}
        turnRate={1.4}
        currentX={args.currentX}
        currentZ={args.currentZ}
        opacity={1}
        seed={20}
        debug={args.showBounds}
      />

      <OrbitControls target={[0, 0, 0]} minDistance={20} maxDistance={260} />
    </>
  )
}

const SceneSetup: FC = () => {
  const { camera, gl, scene } = useThree()

  useEffect(() => {
    const background = new Color('#061f38')
    scene.background = background
    gl.setClearColor(background, 1)
    camera.lookAt(0, 0, 0)
    camera.updateProjectionMatrix()
  }, [camera, gl, scene])

  return null
}

const exportButtonStyle: CSSProperties = {
  position: 'fixed',
  left: 16,
  bottom: 16,
  zIndex: 10,
  padding: '8px 12px',
  fontSize: 12,
  fontFamily: 'monospace',
  color: 'white',
  background: 'rgba(8, 42, 71, 0.85)',
  border: '1px solid rgba(116, 214, 255, 0.5)',
  borderRadius: 6,
  cursor: 'pointer'
}

// Dumps the live control values as a pasteable `Story.args` block to the console
// and the clipboard, so settings dialed in via the Storybook panel can be copied
// straight back into DEFAULT_ARGS.
const ExportControls: FC = () => {
  const args = useControl((args: StoryArgs) => args)
  const [copied, setCopied] = useState(false)

  const handleExport = useCallback(() => {
    const body = (Object.keys(DEFAULT_ARGS) as Array<keyof StoryArgs>)
      .map(key => `  ${key}: ${JSON.stringify(args[key])}`)
      .join(',\n')
    const text = `Story.args = {\n${body}\n}`
    console.log(text)
    void navigator.clipboard?.writeText(text)
    setCopied(true)
    setTimeout(() => {
      setCopied(false)
    }, 1500)
  }, [args])

  return (
    <button type='button' style={exportButtonStyle} onClick={handleExport}>
      {copied ? 'Copied ✓' : 'Export settings'}
    </button>
  )
}

interface StoryProps {}

export const Story: StoryFC<StoryProps, StoryArgs> = () => {
  return (
    <>
      <WebGPUCanvas
        camera={{
          position: [0, 58, 126],
          fov: 46
        }}
        renderer={{
          antialias: true,
          logarithmicDepthBuffer: true
        }}
      >
        <Content />
      </WebGPUCanvas>
      <ExportControls />
    </>
  )
}

Story.args = DEFAULT_ARGS

Story.argTypes = {
  largeCount: { control: { type: 'range', min: 0, max: 256, step: 1 } },
  largeSize: { control: { type: 'range', min: 0.2, max: 3, step: 0.05 } },
  largeRadiusX: { control: { type: 'range', min: 10, max: 220, step: 1 } },
  largeRadiusZ: { control: { type: 'range', min: 10, max: 160, step: 1 } },
  largeDepth: { control: { type: 'range', min: 0.5, max: 30, step: 0.5 } },
  largeSpeed: { control: { type: 'range', min: 0, max: 12, step: 0.1 } },
  largeTailBeat: { control: { type: 'range', min: 0, max: 20, step: 0.1 } },
  largeTailAmplitude: { control: { type: 'range', min: 0, max: 1, step: 0.01 } },
  largeFlock: { control: { type: 'range', min: 0, max: 1, step: 0.01 } },
  smallCount: { control: { type: 'range', min: 0, max: 2048, step: 1 } },
  smallSize: { control: { type: 'range', min: 0.2, max: 3, step: 0.05 } },
  smallRadiusX: { control: { type: 'range', min: 10, max: 240, step: 1 } },
  smallRadiusZ: { control: { type: 'range', min: 10, max: 180, step: 1 } },
  smallDepth: { control: { type: 'range', min: 0.5, max: 35, step: 0.5 } },
  smallSpeed: { control: { type: 'range', min: 0, max: 16, step: 0.1 } },
  smallTailBeat: { control: { type: 'range', min: 0, max: 20, step: 0.1 } },
  smallTailAmplitude: { control: { type: 'range', min: 0, max: 1, step: 0.01 } },
  smallFlock: { control: { type: 'range', min: 0, max: 1, step: 0.01 } },
  smallFlockGroups: { control: { type: 'range', min: 1, max: 8, step: 1 } },
  largeFlockGroups: { control: { type: 'range', min: 1, max: 8, step: 1 } },
  flockScale: { control: { type: 'range', min: 0.002, max: 0.1, step: 0.001 } },
  metalness: { control: { type: 'range', min: 0, max: 1, step: 0.01 } },
  roughness: { control: { type: 'range', min: 0, max: 1, step: 0.01 } },
  brightness: { control: { type: 'range', min: 0, max: 1.5, step: 0.01 } },
  wander: { control: { type: 'range', min: 0, max: 2, step: 0.01 } },
  currentX: { control: { type: 'range', min: -4, max: 4, step: 0.1 } },
  currentZ: { control: { type: 'range', min: -4, max: 4, step: 0.1 } },
  showBounds: { control: { type: 'boolean' } }
}
