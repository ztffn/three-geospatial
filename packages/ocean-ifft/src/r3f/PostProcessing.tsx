'use client'

import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef, type ReactElement } from 'react'
import * as THREE from 'three/webgpu'
import { pass, toneMapping, uniform } from 'three/tsl'
import type { AtmosphereContext } from '@takram/three-atmosphere/webgpu'
import { aerialPerspective, StarsNode } from '@takram/three-atmosphere/webgpu'
import { dithering, lensFlare } from '@takram/three-geospatial/webgpu'
import type { AtmosphereSettings } from '../../components/AtmosphereLayer'

const STARS_ASSET_PATH = new URL('../public/atmosphere/stars.bin', import.meta.url).href

interface PostProcessingProps {
  enabled: boolean
  toneMapping?: {
    exposure: number
  }
  lensFlare?: {
    bloomIntensity: number
  }
  atmosphereContext: AtmosphereContext | null
  atmosphereSettings: AtmosphereSettings
}

export default function PostProcessing({
  enabled,
  toneMapping: toneMappingSettings,
  lensFlare: lensFlareSettings,
  atmosphereContext,
  atmosphereSettings
}: PostProcessingProps): ReactElement | null {
  const { gl, scene, camera, size } = useThree()
  const renderer = gl as unknown as THREE.WebGPURenderer
  const postProcessingRef = useRef<THREE.PostProcessing | null>(null)
  const starsNodeRef = useRef<StarsNode | null>(null)

  useEffect(() => {
    if (!enabled || renderer == null || scene == null || camera == null || atmosphereContext == null) {
      postProcessingRef.current = null
      return
    }

    try {
      const scenePass = pass(scene, camera, { samples: 0 })
      const colorNode = scenePass.getTextureNode('output')
      const depthNode = scenePass.getTextureNode('depth')

      const aerialNode = aerialPerspective(colorNode, depthNode)
      const skyNode = (aerialNode as { skyNode?: any }).skyNode
      if (skyNode) {
        skyNode.showSun = atmosphereSettings.showSun
        skyNode.showMoon = atmosphereSettings.showMoon
        skyNode.showStars = atmosphereSettings.showStars
        starsNodeRef.current?.dispose()
        const starsNode = new StarsNode(STARS_ASSET_PATH)
        starsNode.intensity.value = atmosphereSettings.showStars ? 1 : 0
        starsNodeRef.current = starsNode
        skyNode.starsNode = starsNode
      }

      const lensFlareNode = lensFlare(aerialNode)
      if (lensFlareSettings?.bloomIntensity != null) {
        lensFlareNode.bloomIntensity.value = lensFlareSettings.bloomIntensity
      }

      const exposure = toneMappingSettings?.exposure ?? 10
      const toneNode = toneMapping(THREE.AgXToneMapping, uniform(exposure), lensFlareNode)
      const finalNode = toneNode.add(dithering)

      const postProcessing = new THREE.PostProcessing(renderer)
      postProcessing.outputNode = finalNode
      postProcessingRef.current = postProcessing

      const handleResize = (): void => {
        const pp: { setSize?: (w: number, h: number) => void; needsUpdate?: boolean } | null =
          postProcessingRef.current
        if (pp?.setSize) {
          pp.setSize(size.width, size.height)
          pp.needsUpdate = true
        }
      }

      handleResize()

      return () => {
        postProcessingRef.current = null
        starsNodeRef.current?.dispose()
        starsNodeRef.current = null
      }
    } catch (error) {
      console.error('Failed to initialize Takram post-processing:', error)
      postProcessingRef.current = null
    }
  }, [
    atmosphereContext,
    atmosphereSettings.showMoon,
    atmosphereSettings.showStars,
    atmosphereSettings.showSun,
    camera,
    enabled,
    lensFlareSettings,
    renderer,
    scene,
    size.height,
    size.width,
    toneMappingSettings
  ])

  useFrame(() => {
    postProcessingRef.current?.render()
  }, 1)

  return null
}
