'use client'

import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import * as THREE from 'three'
import type { AtmosphereContextNode } from '@takram/three-atmosphere/webgpu'
import SphericalOceanChunkManager from '../ocean/spherical-ocean.js'
import { SphericalMapping } from '../coordinates/SphericalMapping'

const DEPTH_PASS_PRIORITY = 0.5

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
  const { gl, scene: defaultScene, camera: defaultCamera, size } = useThree()
  const oceanManagerRef = useRef<SphericalOceanManager | null>(null)
  const initializedRef = useRef(false)
  const scene = parent ?? defaultScene
  const camera = cameraOverride ?? defaultCamera
  const matrixECEFToWorld = useRef(new THREE.Matrix4())
  const worldSun = useRef(new THREE.Vector3())

  // Depth pre-pass target. Captures the opaque scene (ocean meshes are on
  // OCEAN_LAYER and excluded by camera.layers.disable in the pre-pass).
  //
  // Lazy useRef + setSize keeps the DepthTexture identity stable across
  // canvas resizes and StrictMode dev double-mount, so the ocean material's
  // binding stays valid and we don't re-init the ocean on layout shifts.
  const depthTargetRef = useRef<THREE.RenderTarget | null>(null)
  if (depthTargetRef.current == null) {
    const w = Math.max(1, size.width)
    const h = Math.max(1, size.height)
    const target = new THREE.RenderTarget(w, h, { depthBuffer: true })
    // UnsignedIntType + DepthFormat is the most reliably-bound combination
    // across Three.js renderer backends for the depth attachment of an
    // off-screen RenderTarget. FloatType silently no-ops on WebGPU.
    const dt = new THREE.DepthTexture(w, h)
    dt.type = THREE.UnsignedIntType
    dt.format = THREE.DepthFormat
    target.depthTexture = dt
    depthTargetRef.current = target
  }
  const depthTarget = depthTargetRef.current

  useEffect(() => {
    depthTarget.setSize(Math.max(1, size.width), Math.max(1, size.height))
  }, [depthTarget, size.width, size.height])

  useEffect(() => {
    return () => {
      depthTargetRef.current?.dispose()
      depthTargetRef.current?.depthTexture?.dispose()
      depthTargetRef.current = null
    }
  }, [])

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
          depthTexture: depthTarget.depthTexture,
          viewportSize: new THREE.Vector2(size.width, size.height),
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
    // depthTarget intentionally excluded: stable identity (lazy useRef) so the
    // ocean material binding stays valid for the component lifetime.
  }, [waveGenerator, maskProvider, radius, gl, scene, camera, onOceanManagerReady])

  // Depth pre-pass: hide the ocean group, render the scene to depthTarget so
  // the ocean fragment shader can sample scene depth, then restore visibility.
  // Visibility toggle avoids the Three.js layer-mask gotcha where the main
  // camera defaults to layer 0 only.
  // Priority 0.5 — runs after R3F default (0) but before postprocessing (1).
  useFrame(() => {
    const manager = oceanManagerRef.current as unknown as { group?: THREE.Object3D } | null
    if (manager == null) return

    const renderer = gl as unknown as { setRenderTarget: (t: THREE.RenderTarget | null) => void; render: (s: THREE.Scene, c: THREE.Camera) => void } | null
    if (renderer == null) return

    const oceanGroup = manager.group
    const wasVisible = oceanGroup?.visible
    if (oceanGroup != null) oceanGroup.visible = false
    try {
      renderer.setRenderTarget(depthTarget)
      renderer.render(scene as THREE.Scene, camera)
    } finally {
      renderer.setRenderTarget(null)
      if (oceanGroup != null && wasVisible !== undefined) oceanGroup.visible = wasVisible
    }
  }, DEPTH_PASS_PRIORITY)

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