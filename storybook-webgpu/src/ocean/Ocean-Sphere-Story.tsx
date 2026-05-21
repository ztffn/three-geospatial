import { OrbitControls } from '@react-three/drei'
import { extend, useFrame, useThree, type ThreeElement } from '@react-three/fiber'
import { useEffect, useRef, useState, type FC } from 'react'
import { AgXToneMapping } from 'three'
import { pass, toneMapping, uniform } from 'three/tsl'
import { PostProcessing, type Renderer } from 'three/webgpu'

import {
  getECIToECEFRotationMatrix,
  getMoonDirectionECI,
  getSunDirectionECI
} from '@takram/three-atmosphere'
import {
  aerialPerspective,
  AtmosphereContextNode,
  AtmosphereLight,
  AtmosphereLightNode,
  skyEnvironment
} from '@takram/three-atmosphere/webgpu'
import { dithering, lensFlare } from '@takram/three-geospatial/webgpu'

import type { StoryFC } from '../components/createStory'
import { Globe } from '../components/Globe'
import { GlobeControls } from '../components/GlobeControls'
import { WebGPUCanvas } from '../components/WebGPUCanvas'
import {
  localDateArgs,
  localDateArgTypes,
  useLocalDateControls,
  type LocalDateArgs
} from '../controls/localDateControls'
import {
  locationArgs,
  locationArgTypes,
  useLocationControls,
  type LocationArgs
} from '../controls/locationControls'
import {
  toneMappingArgs,
  toneMappingArgTypes,
  useToneMappingControls,
  type ToneMappingArgs
} from '../controls/toneMappingControls'
import { useGuardedFrame } from '../hooks/useGuardedFrame'
import { useResource } from '../hooks/useResource'
import { useTransientControl } from '../hooks/useTransientControl'

// Import our new spherical ocean components
import { 
  WaveGenerator, 
  OceanChunks,
  OceanSphereRenderer,
  SphericalMapping 
} from '@three-geospatial/ocean-ifft'

declare module '@react-three/fiber' {
  interface ThreeElements {
    atmosphereLight: ThreeElement<typeof AtmosphereLight>
  }
}

extend({ AtmosphereLight })

const Content: FC<StoryProps> = () => {
  const renderer = useThree<Renderer>(({ gl }) => gl as any)
  const scene = useThree(({ scene }) => scene)
  const camera = useThree(({ camera }) => camera)
  const [waveGenerator, setWaveGenerator] = useState<any>(null)

  const context = useResource(() => new AtmosphereContextNode(), [])
  context.camera = camera

  // Post-processing:
  const [postProcessing, toneMappingNode] = useResource(
    manage => {
      const passNode = manage(pass(scene, camera, { samples: 0 }))
      const colorNode = passNode.getTextureNode('output')
      const depthNode = passNode.getTextureNode('depth')

      const aerialNode = manage(
        aerialPerspective(context, colorNode, depthNode)
      )
      const lensFlareNode = manage(lensFlare(aerialNode))
      const toneMappingNode = manage(
        toneMapping(AgXToneMapping, uniform(0), lensFlareNode)
      )
      const postProcessing = new PostProcessing(renderer)
      postProcessing.outputNode = toneMappingNode.add(dithering)

      return [postProcessing, toneMappingNode]
    },
    [renderer, scene, camera, context]
  )

  useGuardedFrame(() => {
    postProcessing.render()
  }, 1)
  
  useFrame(() => {
    camera.layers.enableAll()
  })

  useToneMappingControls(toneMappingNode, () => {
    postProcessing.needsUpdate = true
  })

  // Set up world origin rebasing for consistent positioning
  useLocationControls(context.matrixWorldToECEF.value)

  useLocalDateControls(date => {
    const { matrixECIToECEF, sunDirectionECEF, moonDirectionECEF } = context
    const dateObj = new Date(date)
    getECIToECEFRotationMatrix(dateObj, matrixECIToECEF.value)
    getSunDirectionECI(dateObj, sunDirectionECEF.value).applyMatrix4(
      matrixECIToECEF.value
    )
    getMoonDirectionECI(dateObj, moonDirectionECEF.value).applyMatrix4(
      matrixECIToECEF.value
    )
  })

  // Simple lighting toggles:
  const envNode = useResource(() => skyEnvironment(context), [context])
  const lightRef = useRef<AtmosphereLight>(null)
  useTransientControl(
    ({ directLight, indirectLight, environmentMap }: StoryArgs) => ({
      directLight,
      indirectLight,
      environmentMap
    }),
    ({ directLight, indirectLight, environmentMap }) => {
      const light = lightRef.current
      if (light != null) {
        light.direct.value = directLight
        light.indirect.value = indirectLight
      }
      scene.environmentNode = environmentMap ? envNode : null
    }
  )

  // Debug logging
  useEffect(() => {
    console.log('Ocean sphere radius:', SphericalMapping.OCEAN_RADIUS)
    console.log('Earth radius:', SphericalMapping.EARTH_RADIUS) 
    console.log('Wave generator:', waveGenerator)
  }, [waveGenerator])

  return (
    <>
      <atmosphereLight ref={lightRef} args={[context]} />
      
      {/* Terrain sphere using 3D tiles - positioned at world origin */}
      <Globe>
        <GlobeControls enableDamping />
      </Globe>

      {/* Switch back to spherical ocean system */}
      <WaveGenerator onInitialized={setWaveGenerator} />
      {waveGenerator && (
        <OceanSphereRenderer 
          waveGenerator={waveGenerator} 
          atmosphereContext={context}
          radius={SphericalMapping.EARTH_RADIUS + 10}
        />
      )}
      
      {/* Depth-foam probe: a tall capsule at the world origin so the
          ocean depth pre-pass has visible geometry to capture. Sized for
          this scene's scale (world units = meters). Layer 0 (default) =
          included in the depth pre-pass. Sphere of influence is what
          matters; precise sea-level alignment comes once contact foam
          consumes the depth values. */}
      <mesh position={[0, 0, 0]}>
        <capsuleGeometry args={[10, 100, 8, 24]} />
        <meshBasicMaterial color="#ff6b3d" />
      </mesh>

      {/* Focus camera on ocean level */}
      <OrbitControls target={[0, 0, 0]} minDistance={10} maxDistance={100000} />
    </>
  )
}

interface StoryProps {}

interface StoryArgs
  extends ToneMappingArgs,
    LocationArgs,
    LocalDateArgs {
  directLight: boolean
  indirectLight: boolean
  environmentMap: boolean
}

export const Story: StoryFC<StoryProps, StoryArgs> = props => {
  return (
    <>
      <WebGPUCanvas
        shadows
        camera={{ position: [0, 5, 10], fov: 50 }} // Very close to surface for LOD
        renderer={{
          antialias: true,
          logarithmicDepthBuffer: true,
          onInit: renderer => {
            renderer.library.addLight(AtmosphereLightNode, AtmosphereLight)
          }
        }}
      >
        <Content {...props} />
      </WebGPUCanvas>
    </>
  )
}

Story.args = {
  ...toneMappingArgs({ toneMappingExposure: 10 }),
  ...locationArgs({ longitude: 30, latitude: 35, height: 300 }),
  ...localDateArgs({ dayOfYear: 0, timeOfDay: 9 }),
  environmentMap: true,
  directLight: true,
  indirectLight: true
}

Story.argTypes = {
  ...toneMappingArgTypes(),
  ...locationArgTypes(),
  ...localDateArgTypes(),
  environmentMap: {
    control: {
      type: 'boolean'
    }
  },
  directLight: {
    control: {
      type: 'boolean'
    }
  },
  indirectLight: {
    control: {
      type: 'boolean'
    }
  }
}