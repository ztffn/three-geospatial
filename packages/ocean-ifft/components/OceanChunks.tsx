'use client'

import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef, type ReactElement } from 'react'
import * as THREE from 'three'
import type { AtmosphereContextNode } from '@takram/three-atmosphere/webgpu'
import OceanChunkManager from '../src/ocean/ocean.js'
import { createLinearDepthMaterial } from '../src/ocean/depth-material.js'

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

  // WaterPro linear-depth pre-pass: renders the full scene with a custom
  // material that encodes (-view_z - near)/(far - near) into the R channel of
  // a HalfFloat RGBA color texture. Using a plain color texture avoids the
  // WebGPU restriction where DepthTexture attachments are not tracked as
  // TEXTURE_BINDING resources and cannot be sampled in a subsequent pass.
  const depthMaterial = useMemo(() => createLinearDepthMaterial(), [])
  const depthTargetRef = useRef<THREE.RenderTarget | null>(null)
  if (depthTargetRef.current == null) {
    const w = Math.max(1, size.width)
    const h = Math.max(1, size.height)
    // FloatType (rgba32float) is required: at ECEF scales with cameraFar=1e8,
    // HalfFloat's ~11-bit mantissa collapses (terrainDepth-cameraNear)/(far-near)
    // ratios for nearby geometry to ~0, which makes wcdRaw strongly negative and
    // triggers max shoreline foam over the entire ocean.
    depthTargetRef.current = new THREE.RenderTarget(w, h, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      type: THREE.FloatType,
      format: THREE.RGBAFormat,
      depthBuffer: true,
    })
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

        const cam = camera as THREE.PerspectiveCamera
        await oceanManager.Init({
          scene,
          camera,
          renderer: gl,
          sunpos,
          waveGenerator,
          layer: 0,
          depthTexture: depthTarget.texture,
          viewportSize: new THREE.Vector2(size.width, size.height),
          cameraNear: cam.near ?? 1.0,
          cameraFar: cam.far ?? 1e8,
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

  // Linear-depth pre-pass: override all scene materials with depthMaterial so
  // every opaque fragment writes (-view_z - near)/(far - near) into the R
  // channel. Ocean group is hidden so it's excluded from the depth encoding.
  // Renders defaultScene so capsule/terrain outside the ocean group are captured.
  // Priority 0.5 — between R3F's default render (0) and postprocessing (1).
  useFrame(() => {
    const manager = oceanManagerRef.current as unknown as { group?: THREE.Object3D } | null
    if (manager == null) return
    const renderer = gl as unknown as {
      setRenderTarget: (t: THREE.RenderTarget | null) => void;
      render: (s: THREE.Scene, c: THREE.Camera) => void;
      clear: () => void;
      setClearColor: (c: number, a?: number) => void;
      getClearColor: (target: THREE.Color) => THREE.Color;
      getClearAlpha: () => number;
    } | null
    if (renderer == null) return

    const oceanGroup = manager.group
    const wasVisible = oceanGroup?.visible
    const prevBackground = defaultScene.background
    if (oceanGroup != null) oceanGroup.visible = false

    const overridden: Array<{ mesh: THREE.Mesh; mat: THREE.Material | THREE.Material[] }> = []
    defaultScene.traverse((obj) => {
      const mesh = obj as unknown as THREE.Mesh
      const mat = (mesh as any).material
      // skip transparent-only meshes (no alphaTest); they don't write meaningful depth
      if ((obj as any).isMesh && obj.visible && mat != null) {
        const mats = Array.isArray(mat) ? mat : [mat]
        if (mats.every((m: any) => m.transparent && !(m.alphaTest > 0))) return
        overridden.push({ mesh, mat })
        mesh.material = depthMaterial as unknown as THREE.Material
      }
    })
    // Clear to white (R=1) so empty pixels decode to cameraFar (no-geometry path
    // in the TSL water-column-depth node). Clearing to black would decode to
    // cameraNear and signal terrain everywhere, drowning the ocean in foam.
    const prevClear = new THREE.Color()
    renderer.getClearColor(prevClear)
    const prevAlpha = renderer.getClearAlpha()
    try {
      defaultScene.background = null
      renderer.setRenderTarget(depthTarget)
      renderer.setClearColor(0xffffff, 1.0)
      renderer.clear()
      renderer.render(defaultScene, camera)
    } finally {
      renderer.setRenderTarget(null)
      renderer.setClearColor(prevClear.getHex(), prevAlpha)
      defaultScene.background = prevBackground
      overridden.forEach(({ mesh, mat }) => { mesh.material = mat })
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
