'use client'

import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef, useState, type ReactElement } from 'react'
import * as THREE from 'three'
import type { AtmosphereContextNode } from '@takram/three-atmosphere/webgpu'
import SphericalOceanChunkManager from '../ocean/spherical-ocean.js'
import { SphericalMapping } from '../coordinates/SphericalMapping'

interface WaveGeneratorLike {
  Update_?: (deltaMs: number) => void | Promise<void>
  params_?: {
    gui?: unknown
  }
  cascades?: unknown
  size?: unknown
  lodScale?: unknown
  waveLengths?: unknown
  foamStrength?: unknown
  foamThreshold?: unknown
  oceanSet?: unknown
}

interface MaskProviderLike {
  hasWaterAtLocation?: (longitude: number, latitude: number) => boolean
  getMasks?: () => any
}

type SphericalOceanManager = InstanceType<typeof SphericalOceanChunkManager>

interface OceanSphereRendererProps {
  waveGenerator: WaveGeneratorLike | null
  maskProvider?: MaskProviderLike | null
  radius?: number
  onOceanManagerReady?: (oceanManager: SphericalOceanManager) => void
  parent?: THREE.Object3D | null
  cameraOverride?: THREE.PerspectiveCamera | null
  atmosphereContext?: AtmosphereContextNode | null
  children?: React.ReactNode
}

export default function OceanSphereRenderer({
  waveGenerator,
  maskProvider,
  radius = SphericalMapping.OCEAN_RADIUS,
  onOceanManagerReady,
  parent,
  cameraOverride,
  atmosphereContext,
  children
}: OceanSphereRendererProps): ReactElement | null {
  const { gl, scene: defaultScene, camera: defaultCamera } = useThree()
  const oceanManagerRef = useRef<SphericalOceanManager | null>(null)
  const initializedRef = useRef(false)
  const scene = parent ?? defaultScene
  const camera = cameraOverride ?? defaultCamera
  const matrixECEFToWorld = useRef(new THREE.Matrix4())
  const worldSun = useRef(new THREE.Vector3())

  useEffect(() => {
    if (initializedRef.current || waveGenerator == null || gl == null) {
      if (waveGenerator == null) {
        console.log('OceanSphereRenderer: Waiting for waveGenerator')
      }
      if (gl == null) {
        console.log('OceanSphereRenderer: Waiting for gl (renderer)')
      }
      return
    }

    const initSphericalOcean = async (): Promise<void> => {
      try {
        console.log('Initializing spherical ocean...')
        console.log('Wave generator:', waveGenerator)
        console.log('Mask provider:', maskProvider)
        console.log('Ocean sphere radius:', radius)

        // Default sun position
        const sunpos = new THREE.Vector3(100000, 50000, 100000)
        
        const oceanManager = new SphericalOceanChunkManager({
          radius: radius,
          maskProvider: maskProvider
        })

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

        oceanManagerRef.current = oceanManager
        initializedRef.current = true
        console.log('Spherical ocean initialized successfully')

        onOceanManagerReady?.(oceanManager)
      } catch (error) {
        console.error('Failed to initialize spherical ocean:', error)
        console.error('Error details:', {
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : 'No stack',
          waveGenerator,
          maskProvider,
          radius
        })
      }
    }

    void initSphericalOcean()

    return () => {
      oceanManagerRef.current?.Destroy?.()
      oceanManagerRef.current = null
      initializedRef.current = false
    }
  }, [waveGenerator, maskProvider, radius, gl, scene, camera, onOceanManagerReady])

  useFrame((_, delta) => {
    if (oceanManagerRef.current == null || waveGenerator == null) return

    const deltaTime = delta * 1000

    try {
      // Update wave generator
      void waveGenerator.Update_?.(deltaTime)

      // Update spherical ocean chunks
      oceanManagerRef.current.Update_?.(deltaTime)

      // Update sun direction from atmosphere context
      if (
        atmosphereContext?.sunDirectionECEF != null &&
        atmosphereContext.matrixWorldToECEF != null
      ) {
        matrixECEFToWorld.current
          .copy(atmosphereContext.matrixWorldToECEF.value)
          .invert()
        
        worldSun.current
          .copy(atmosphereContext.sunDirectionECEF.value)
          .applyMatrix4(matrixECEFToWorld.current)
          .normalize()
        
        oceanManagerRef.current.SetSunDirection?.(worldSun.current)
      }

      // Debug logging for chunk count (once)
      if (oceanManagerRef.current.chunks_ != null) {
        const chunkCount = Object.keys(oceanManagerRef.current.chunks_).length
        const loggedChunks = (oceanManagerRef.current as any)._loggedChunks === true
        if (chunkCount > 0 && !loggedChunks) {
          console.log(`Spherical ocean chunks created: ${chunkCount}`)
          console.log('Chunk details:', oceanManagerRef.current.chunks_)
          ;(oceanManagerRef.current as any)._loggedChunks = true
        }
      }
    } catch (error) {
      console.error('Error updating spherical ocean:', error)
    }
  })

  return (
    <group name="ocean-sphere-renderer">
      {children}
    </group>
  )
}

// Export type for external use
export type { SphericalOceanManager, WaveGeneratorLike, MaskProviderLike }