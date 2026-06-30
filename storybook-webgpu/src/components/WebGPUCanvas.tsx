import styled from '@emotion/styled'
import { Canvas, type CanvasProps } from '@react-three/fiber'
import { atom, useAtomValue } from 'jotai'
import { useEffect, useRef, type FC } from 'react'
import type { WebGPURendererParameters } from 'three/src/renderers/webgpu/WebGPURenderer.js'
import { WebGPURenderer, type Renderer } from 'three/webgpu'

import type { RendererArgs } from '../controls/rendererControls'
import { useControl } from '../hooks/useControl'
import { Stats } from './Stats'

const CanvasContainer = styled('div')`
  position: fixed;
  right: 0;
  top: 0;
  width: 85vw;
  height: 100vh;
  max-width: 85vw;
  max-height: 100vh;
  overflow: hidden;
  z-index: 1;
`

export const availableAtom = atom(
  async () =>
    typeof navigator !== 'undefined' &&
    navigator.gpu !== undefined &&
    (await navigator.gpu.requestAdapter()) != null
)

const MessageElement = styled('div')`
  position: absolute;
  top: 16px;
  right: 16px;
  left: 16px;
  color: white;
  font-size: small;
  letter-spacing: 0.02em;
  text-align: center;
`

const Message: FC<{ forceWebGL: boolean }> = ({ forceWebGL }) => {
  const available = useAtomValue(availableAtom)
  if (!available) {
    return (
      <MessageElement>
        Your browser does not support WebGPU yet. Running under WebGL2 as a
        fallback.
      </MessageElement>
    )
  }
  if (forceWebGL) {
    return <MessageElement>Running under WebGL2.</MessageElement>
  }
  return null
}

export interface WebGPUCanvasProps extends Omit<CanvasProps, 'gl'> {
  renderer?: WebGPURendererParameters & {
    onInit?: (renderer: WebGPURenderer) => void | Promise<void>
  }
}

export const WebGPUCanvas: FC<WebGPUCanvasProps> = ({
  renderer: { onInit, ...otherProps } = {},
  children,
  ...canvasProps
}) => {
  const available = useAtomValue(availableAtom)
  let forceWebGL = useControl(({ forceWebGL }: RendererArgs) => forceWebGL)
  forceWebGL ||= !available
  const pixelRatio = useControl(({ pixelRatio }: RendererArgs) => pixelRatio)

  const ref = useRef<Renderer>(null)
  useEffect(() => {
    return () => {
      // WORKAROUND: Renderer won't be disposed when used in Storybook.
      setTimeout(() => {
        ref.current?.dispose()
      }, 500)
    }
  }, [])

  return (
    <>
      <CanvasContainer>
        <Canvas
          key={forceWebGL ? 'webgl' : 'webgpu'}
          {...canvasProps}
          gl={async props => {
            // Three requests the device with spec-minimum limits unless told
            // otherwise: 128 MB storage-buffer binding, 256 MB max buffer, 8192
            // max 2D texture. All three are exceeded by large splat clouds — the
            // per-splat struct buffer (48 B/splat → 192 MB at 4M, 400 MB at 8M)
            // and the SH texture (11200×11158 at full 8.33M). Request the
            // adapter's real maxima so large clouds allocate. Skipped under WebGL;
            // clamped to what the adapter reports (some browsers — e.g. Firefox's
            // core adapter — may still cap at the minimums).
            const requiredLimits: Record<string, number> = {}
            if (!forceWebGL && navigator.gpu != null) {
              const adapter = await navigator.gpu.requestAdapter()
              if (adapter != null) {
                requiredLimits.maxStorageBufferBindingSize =
                  adapter.limits.maxStorageBufferBindingSize
                requiredLimits.maxBufferSize = adapter.limits.maxBufferSize
                requiredLimits.maxTextureDimension2D =
                  adapter.limits.maxTextureDimension2D
              }
            }
            const renderer = new WebGPURenderer({
              ...(props as any),
              ...otherProps,
              requiredLimits: {
                ...requiredLimits,
                ...(otherProps.requiredLimits ?? {})
              },
              forceWebGL
            })
            ref.current = renderer
            await renderer.init()

            // Require the model-view matrix premultiplied on the CPU side.
            // See: https://github.com/mrdoob/three.js/issues/30955
            renderer.highPrecision = true

            await onInit?.(renderer)
            return renderer
          }}
          dpr={pixelRatio}
        >
          {children}
          <Stats />
        </Canvas>
      </CanvasContainer>
      <Message forceWebGL={forceWebGL} />
    </>
  )
}
