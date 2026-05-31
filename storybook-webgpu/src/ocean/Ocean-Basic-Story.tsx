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
  AtmosphereContext,
  AtmosphereLight,
  AtmosphereLightNode,
  skyEnvironment
} from '@takram/three-atmosphere/webgpu'
import { dithering, lensFlare } from '@takram/three-geospatial/webgpu'

import type { StoryFC } from '../components/createStory'
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
import { useAtmosphereContextNode } from '../hooks/useAtmosphereContextNode'
import { useTransientControl } from '../hooks/useTransientControl'
import { WaveGenerator, OceanChunks } from '@three-geospatial/ocean-ifft'

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

  const context = useResource(() => new AtmosphereContext(), [])
  useAtmosphereContextNode(context)
  context.camera = camera

  // Post-processing:
  const [postProcessing, toneMappingNode] = useResource(
    manage => {
      const passNode = manage(pass(scene, camera, { samples: 0 }))
      const colorNode = passNode.getTextureNode('output')
      const depthNode = passNode.getTextureNode('depth')

      const aerialNode = manage(
        aerialPerspective(colorNode, depthNode)
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
  const envNode = useResource(() => skyEnvironment(), [])
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

  return (
    <>
      <atmosphereLight ref={lightRef} />
      <OrbitControls target={[0, 0.5, 0]} minDistance={1} />
      <WaveGenerator onInitialized={setWaveGenerator} />
      {waveGenerator && (
        <OceanChunks waveGenerator={waveGenerator} atmosphereContext={context} />
      )}
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
        camera={{ position: [0, 2, 6], fov: 50 }}
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
  environmentMap: false,
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
  }
}
