'use client'

import { useThree } from '@react-three/fiber'
import { useEffect, useRef, type ReactElement } from 'react'
import { wave_generator } from '../waves/wave-generator.js'
import { GUIAdapter } from '../../components/GUIAdapter'

interface WaveGeneratorInstance {
  Init: (params: {
    scene: unknown
    camera: unknown
    renderer: unknown
    gui: GUIAdapter
  }) => Promise<void>
  Update_?: (deltaMs: number) => void | Promise<void>
  params_?: {
    gui?: unknown
  }
  cascades?: unknown
  size?: unknown
}

interface WaveGeneratorProps {
  onInitialized: (waveGen: WaveGeneratorInstance) => void
}

export default function WaveGenerator({ onInitialized }: WaveGeneratorProps): ReactElement | null {
  const { gl, scene, camera } = useThree()
  const waveGenRef = useRef<WaveGeneratorInstance | null>(null)
  const guiRef = useRef<GUIAdapter | null>(null)
  const initializedRef = useRef(false)

  useEffect(() => {
    if (initializedRef.current || gl == null) return

    const initWaveGenerator = async (): Promise<void> => {
      try {
        const gui = new GUIAdapter()
        gui.close()
        guiRef.current = gui

        const waveGen = new wave_generator.WaveGenerator() as WaveGeneratorInstance

        await waveGen.Init({
          scene,
          camera,
          renderer: gl,
          gui
        })

        waveGenRef.current = waveGen
        initializedRef.current = true

        console.log('Wave generator initialized:', waveGen)
        console.log('Wave generator properties:', {
          hasUpdate: typeof waveGen.Update_ === 'function',
          hasParams: waveGen.params_ != null,
          cascades: waveGen.cascades,
          size: waveGen.size
        })

        onInitialized(waveGen)
      } catch (error) {
        console.error('Failed to initialize wave generator:', error)
        console.error('Error stack:', error instanceof Error ? error.stack : 'No stack')
      }
    }

    void initWaveGenerator()

    return () => {
      guiRef.current?.destroy()
    }
  }, [gl, scene, camera, onInitialized])

  return null
}
