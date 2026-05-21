'use client'

import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef, type ReactElement } from 'react'
import * as THREE from 'three'
import type { AtmosphereContextNode } from '@takram/three-atmosphere/webgpu'
import OceanChunkManager from '../src/ocean/ocean.js'

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
  const { gl, scene: defaultScene, camera: defaultCamera, size } = useThree()
  const oceanManagerRef = useRef<OceanManager | null>(null)
  const initializedRef = useRef(false)
  const scene = parent ?? defaultScene
  const camera = cameraOverride ?? defaultCamera
  const matrixECEFToWorld = useMemo(() => new THREE.Matrix4(), [])
  const worldSun = useMemo(() => new THREE.Vector3(), [])

  // Depth pre-pass target. Captures scene depth excluding the ocean layer so
  // the ocean fragment shader can read scene depth without the WebGPU
  // self-attachment-sampling restriction.
  //
  // Lazy useRef + setSize keeps the same DepthTexture identity across
  // canvas resizes and React StrictMode dev double-mount, so the ocean
  // material's binding stays valid and we don't re-init on every layout shift.
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

  // Resize without changing identity.
  useEffect(() => {
    depthTarget.setSize(Math.max(1, size.width), Math.max(1, size.height))
  }, [depthTarget, size.width, size.height])

  // Dispose only on real unmount.
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
          depthTexture: depthTarget.depthTexture,
          viewportSize: new THREE.Vector2(size.width, size.height),
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
    // depthTarget intentionally excluded: same identity across resizes (see lazy useRef above),
    // so the ocean material's binding remains valid for the component lifetime.
  }, [waveGenerator, gl, scene, camera, onOceanManagerReady])

  // Depth pre-pass: hide the ocean group, render the scene to depthTarget so
  // the ocean fragment shader can sample scene depth, then restore visibility.
  // Visibility toggle avoids the Three.js layer-mask gotcha where the main
  // camera defaults to layer 0 only.
  // Priority 0.5 — between R3F's default render (0) and postprocessing (1).
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
