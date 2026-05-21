'use client'

import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef, type ReactElement } from 'react'
import * as THREE from 'three'
import type { AtmosphereContextNode } from '@takram/three-atmosphere/webgpu'
import OceanChunkManager from '../src/ocean/ocean.js'

interface WaveGeneratorLike {
  Update_?: (deltaMs: number) => void | Promise<void>
  params_?: {
    gui?: unknown
  }
  cascades?: unknown
  size?: unknown
  lodScale?: unknown
  waveLengths?: unknown
}

type OceanManager = InstanceType<typeof OceanChunkManager>

interface OceanChunksProps {
  waveGenerator: WaveGeneratorLike | null
  onOceanManagerReady?: (oceanManager: OceanManager) => void
  parent?: THREE.Object3D | null
  cameraOverride?: THREE.PerspectiveCamera | null
  atmosphereContext?: AtmosphereContextNode | null
}

export default function OceanChunks({
  waveGenerator,
  onOceanManagerReady,
  parent,
  cameraOverride,
  atmosphereContext
}: OceanChunksProps): ReactElement | null {
  const { gl, scene: defaultScene, camera: defaultCamera } = useThree()
  const oceanManagerRef = useRef<OceanManager | null>(null)
  const initializedRef = useRef(false)
  const scene = parent ?? defaultScene
  const camera = cameraOverride ?? defaultCamera
  const matrixECEFToWorld = useMemo(() => new THREE.Matrix4(), [])
  const worldSun = useMemo(() => new THREE.Vector3(), [])

  useEffect(() => {
    if (initializedRef.current || waveGenerator == null || gl == null) {
      if (waveGenerator == null) {
        console.log('OceanChunks: Waiting for waveGenerator')
      }
      if (gl == null) {
        console.log('OceanChunks: Waiting for gl (renderer)')
      }
      return
    }

    let cancelled = false
    let createdOceanManager: OceanManager | null = null

    const initOceanChunks = async (): Promise<void> => {
      try {
        console.log('Initializing ocean chunks...')
        console.log('Wave generator:', waveGenerator)
        console.log('Wave generator properties:', {
          cascades: waveGenerator.cascades,
          size: waveGenerator.size,
          lodScale: waveGenerator.lodScale,
          waveLengths: waveGenerator.waveLengths,
          hasParams: waveGenerator.params_ != null
        })

        const sunpos = new THREE.Vector3(100000, 0, 100000)
        const oceanManager = new OceanChunkManager()
        createdOceanManager = oceanManager
        const gui = waveGenerator.params_?.gui

        await oceanManager.Init({
          scene,
          camera,
          renderer: gl,
          sunpos,
          waveGenerator,
          layer: 0,
          gui,
          guiParams: {}
        })

        if (cancelled) {
          oceanManager.Destroy?.()
          return
        }

        oceanManagerRef.current = oceanManager
        initializedRef.current = true
        console.log('Ocean chunks initialized successfully')

        onOceanManagerReady?.(oceanManager)
      } catch (error) {
        console.error('Failed to initialize ocean chunks:', error)
        console.error('Error details:', {
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : 'No stack',
          waveGenerator
        })
      }
    }

    void initOceanChunks()

    return () => {
      cancelled = true
      ;(oceanManagerRef.current ?? createdOceanManager)?.Destroy?.()
      oceanManagerRef.current = null
      initializedRef.current = false
    }
  }, [waveGenerator, gl, scene, camera, onOceanManagerReady])

  useFrame((_, delta) => {
    if (oceanManagerRef.current == null || waveGenerator == null) return

    const deltaTime = delta * 1000

    try {
      void waveGenerator.Update_?.(deltaTime)

      oceanManagerRef.current.Update_?.(deltaTime)
      if (
        atmosphereContext?.sunDirectionECEF != null &&
        atmosphereContext.matrixWorldToECEF != null
      ) {
        matrixECEFToWorld.copy(atmosphereContext.matrixWorldToECEF.value).invert()
        worldSun
          .copy(atmosphereContext.sunDirectionECEF.value)
          .applyMatrix4(matrixECEFToWorld)
          .normalize()
        oceanManagerRef.current.SetSunDirection?.(worldSun)
      }

      if (oceanManagerRef.current.chunks_ != null) {
        const chunkCount = Object.keys(oceanManagerRef.current.chunks_).length
        const loggedChunks = (oceanManagerRef.current as any)._loggedChunks === true
        if (chunkCount > 0 && !loggedChunks) {
          console.log(`Ocean chunks created: ${chunkCount}`)
          console.log('Chunk details:', oceanManagerRef.current.chunks_)
          ;(oceanManagerRef.current as any)._loggedChunks = true
        }
      }
    } catch (error) {
      console.error('Error updating ocean:', error)
    }
  })

  return null
}
