import { useFrame, useThree, type ThreeElements } from '@react-three/fiber'
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useState
} from 'react'

import type { GaussianSplatData } from '../GaussianSplatData'
import { GaussianSplatMesh } from '../GaussianSplatMesh'
import { PLYSplatLoader } from '../PLYSplatLoader'

type GroupProps = ThreeElements['group']

export interface GaussianSplatsProps extends GroupProps {
  /** URL of a `.ply` Gaussian splat file. Mutually exclusive with `data`. */
  url?: string
  /** Pre-parsed splat data. Mutually exclusive with `url`. */
  data?: GaussianSplatData
  /** Render order of the splat mesh (default 2, after opaque geometry). */
  renderOrder?: number
}

/**
 * Renders 3D Gaussian splats from a `.ply` file or pre-parsed
 * {@link GaussianSplatData}. Re-sorts back-to-front every frame as the camera
 * moves so the alpha compositing stays correct.
 */
export const GaussianSplats = forwardRef<GaussianSplatMesh, GaussianSplatsProps>(
  function GaussianSplats({ url, data, renderOrder = 2, ...props }, ref) {
    const [loaded, setLoaded] = useState<GaussianSplatData | undefined>(data)

    useEffect(() => {
      if (url == null) {
        setLoaded(data)
        return
      }
      let disposed = false
      const loader = new PLYSplatLoader()
      loader.load(
        url,
        result => {
          if (!disposed) {
            setLoaded(result)
          }
        },
        undefined,
        error => {
          console.error(`Failed to load splat file: ${url}`, error)
        }
      )
      return () => {
        disposed = true
      }
    }, [url, data])

    const mesh = useMemo(
      () => (loaded != null ? new GaussianSplatMesh(loaded) : null),
      [loaded]
    )

    useEffect(() => {
      if (mesh == null) {
        return
      }
      return () => {
        mesh.dispose()
      }
    }, [mesh])

    // ref.current is null until the file finishes loading.
    useImperativeHandle(ref, () => mesh!, [mesh])

    const renderer = useThree(({ gl }) => gl)
    const camera = useThree(({ camera }) => camera)

    useFrame(() => {
      mesh?.update(renderer, camera)
    })

    if (mesh == null) {
      return null
    }
    return (
      <group {...props}>
        <primitive object={mesh} renderOrder={renderOrder} />
      </group>
    )
  }
)
