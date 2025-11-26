import { OrbitControls, Plane } from '@react-three/drei'
import { extend, useFrame, useThree, type ThreeElement } from '@react-three/fiber'
import { useEffect, useMemo, useState, type FC } from 'react'
import { AgXToneMapping, Matrix4, Vector3 } from 'three'
import { mrt, output, pass, toneMapping, uniform } from 'three/tsl'
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
import { Ellipsoid, Geodetic, radians } from '@takram/three-geospatial'
import { highpVelocity, temporalAntialias } from '@takram/three-geospatial/webgpu'

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
import { WaveGenerator, OceanChunks } from '@three-geospatial/ocean-ifft'

declare module '@react-three/fiber' {
  interface ThreeElements {
    atmosphereLight: ThreeElement<typeof AtmosphereLight>
  }
}

extend({ AtmosphereLight })

const ECEFWaterPatch: FC<{ matrix: Matrix4 }> = ({ matrix }) => {
  return (
    <group matrix={matrix} matrixAutoUpdate={false}>
      <Plane args={[5000, 5000]} rotation={[-Math.PI / 2, 0, 0]}>
        <meshPhysicalMaterial
          color='#3b83f6'
          roughness={0.15}
          metalness={0.05}
          transmission={0.1}
          thickness={2}
          clearcoat={0.5}
        />
      </Plane>
    </group>
  )
}

const Content: FC<StoryProps> = ({ longitude, latitude, height }) => {
  const renderer = useThree<Renderer>(({ gl }) => gl as any)
  const scene = useThree(({ scene }) => scene)
  const camera = useThree(({ camera }) => camera)
  const [waveGenerator, setWaveGenerator] = useState<any>(null)

  const context = useResource(() => new AtmosphereContextNode(), [])
  context.camera = camera
  const envNode = useResource(() => skyEnvironment(context), [context])
  scene.environmentNode = envNode

  const {
    matrix: targetMatrix,
    position: targetPosition,
    cameraPosition,
    torusPosition,
    upVector
  } = useMemo(() => {
    const geodetic = new Geodetic(radians(longitude), radians(latitude), height)
    const position = geodetic.toECEF()
    const basis = new Matrix4()
    Ellipsoid.WGS84.getEastNorthUpFrame(position, basis)
    const matrix = new Matrix4()
    matrix.copy(basis)
    matrix.setPosition(position.x, position.y, position.z)

    const east = new Vector3()
    const north = new Vector3()
    const up = new Vector3()
    basis.extractBasis(east, north, up)
    const camPos = new Vector3()
      .copy(position)
      .addScaledVector(up, 50000)
      .addScaledVector(north, 50000)

    const torusPos = new Vector3().copy(position).addScaledVector(up, 2000)

    return {
      matrix,
      position,
      cameraPosition: camPos,
      torusPosition: torusPos,
      upVector: up
    }
  }, [longitude, latitude, height])

  const [postProcessing, passNode, toneMappingNode] = useResource(
    manage => {
      const passNode = manage(
        pass(scene, camera, { samples: 0 }).setMRT(
          mrt({
            output,
            velocity: highpVelocity
          })
        )
      )
      const colorNode = passNode.getTextureNode('output')
      const depthNode = passNode.getTextureNode('depth')
      const velocityNode = passNode.getTextureNode('velocity')

      const aerialNode = manage(aerialPerspective(context, colorNode, depthNode))
      const lensFlareNode = manage(lensFlare(aerialNode))
      const toneMappingNode = manage(
        toneMapping(AgXToneMapping, uniform(0), lensFlareNode)
      )
      const taaNode = manage(
        temporalAntialias(highpVelocity)(
          toneMappingNode,
          depthNode,
          velocityNode,
          camera
        )
      )
      const postProcessing = new PostProcessing(renderer)
      postProcessing.outputNode = taaNode.add(dithering)
      if (postProcessing.outputNode == null) {
        postProcessing.outputNode = colorNode
      }
      return [postProcessing, passNode, toneMappingNode]
    },
    [renderer, scene, camera, context]
  )

  useGuardedFrame(() => {
    postProcessing.render()
  }, 1)

  useEffect(() => {
    camera.position.copy(cameraPosition)
    camera.up.copy(upVector)
    camera.lookAt(targetPosition)
  }, [camera, cameraPosition, targetPosition, upVector])

  useToneMappingControls(toneMappingNode, () => {
    postProcessing.needsUpdate = true
  })

  useLocationControls(context.matrixWorldToECEF.value)

  useLocalDateControls(date => {
    if (!Number.isFinite(date)) return
    const { matrixECIToECEF, sunDirectionECEF, moonDirectionECEF } = context
    const dateObj = new Date(date)
    if (Number.isNaN(dateObj.getTime())) return
    getECIToECEFRotationMatrix(dateObj, matrixECIToECEF.value)
    getSunDirectionECI(dateObj, sunDirectionECEF.value).applyMatrix4(
      matrixECIToECEF.value
    )
    getMoonDirectionECI(dateObj, moonDirectionECEF.value).applyMatrix4(
      matrixECIToECEF.value
    )
  })

  // Ensure all layers are visible for tiles + water
  useFrame(() => {
    camera.layers.enableAll()
  })

  return (
    <>
      <atmosphereLight args={[context]} />
      <ambientLight intensity={0.5} />
      <OrbitControls target={targetPosition.toArray()} minDistance={1000} />
      <GlobeControls enableDamping overlayScene={scene} />
      <mesh position={torusPosition.toArray()}>
        <torusGeometry args={[500, 150, 32, 64]} />
        <meshBasicMaterial color='hotpink' />
      </mesh>
      <ECEFWaterPatch matrix={targetMatrix} />
      <WaveGenerator onInitialized={setWaveGenerator} />
      {waveGenerator && (
        <OceanChunks waveGenerator={waveGenerator} atmosphereContext={context} />
      )}
      {/* Debug wireframe for globe alignment */}
      <group matrix={context.matrixWorldToECEF.value} matrixAutoUpdate={false}>
        <mesh>
          <sphereGeometry args={[Ellipsoid.WGS84.radii.x + 10, 64, 64]} />
          <meshBasicMaterial color='yellow' wireframe />
        </mesh>
      </group>
    </>
  )
}

interface StoryProps {
  longitude: number
  latitude: number
  height: number
}

interface StoryArgs extends ToneMappingArgs, LocationArgs, LocalDateArgs {}

export const Story: StoryFC<StoryProps, StoryArgs> = props => {
  return (
    <WebGPUCanvas
      renderer={{
        logarithmicDepthBuffer: true,
        onInit: renderer => {
          renderer.library.addLight(AtmosphereLightNode, AtmosphereLight)
        }
      }}
      camera={{ position: [0, 0, 0], near: 1, far: 1e8 }}
    >
      <Globe>
        <Content {...props} />
      </Globe>
    </WebGPUCanvas>
  )
}

Story.args = {
  ...locationArgs({ longitude: 0, latitude: 0, height: 0 }),
  ...localDateArgs({ dayOfYear: 0, timeOfDay: 9 }),
  ...toneMappingArgs({ toneMappingExposure: 10 })
}

Story.argTypes = {
  ...locationArgTypes(),
  ...localDateArgTypes(),
  ...toneMappingArgTypes()
}

export default Story
