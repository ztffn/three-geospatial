// React Three Fiber component for the WebGPU splat path: loads a .spz or .ply URL
// (or pre-parsed data), renders with the GaussianSplatNodeMaterial + GPU radix
// sort, and optionally octree LOD — the GPU-driven counterpart to the WebGL-only
// `<GaussianSplats>` (which is PLY-URL only). Drives `mesh.update` each frame.
// Requires a WebGPURenderer (use inside an R3F canvas backed by `WebGPURenderer`).

import { useFrame, useThree, type ThreeElements } from '@react-three/fiber'
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useState
} from 'react'

import type { GaussianSplatData } from '../GaussianSplatData'
import {
  GaussianSplatMesh,
  type SplatLodMeshOptions
} from '../GaussianSplatMesh'
import { PLYSplatLoader } from '../PLYSplatLoader'
import { loadSpzSplatData } from '../SpzSplatLoader'
import { GaussianSplatNodeMaterial } from './GaussianSplatNodeMaterial'
import { GpuSplatSorter } from './GpuSplatSorter'
import { SplatLodPipeline } from './SplatLodPipeline'

type GroupProps = ThreeElements['group']

// Loads a splat URL by extension: .spz via spz-js decode, otherwise the PLY loader.
async function loadSplatUrl(url: string): Promise<GaussianSplatData> {
  if (url.toLowerCase().endsWith('.spz')) {
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`Failed to fetch splat file (${response.status}): ${url}`)
    }
    return await loadSpzSplatData(await response.arrayBuffer())
  }
  return await new Promise<GaussianSplatData>((resolve, reject) => {
    new PLYSplatLoader().load(url, resolve, undefined, reject)
  })
}

export interface GaussianSplatsGPUProps extends GroupProps {
  /** URL of a `.spz` or `.ply` splat file. Mutually exclusive with `data`. */
  url?: string
  /** Pre-parsed splat data (e.g. from `loadSpzSplatData`). Mutually exclusive with `url`. */
  data?: GaussianSplatData
  /**
   * Octree LOD options (budget, distance bands, …). Omit to draw the whole cloud
   * (GPU-sorted, no LOD). See {@link SplatLodMeshOptions}.
   */
  lod?: SplatLodMeshOptions
  /** Camera rotation, in degrees, that triggers a re-sort / re-LOD. */
  sortThresholdDegrees?: number
  /** Linear scale applied to the splat radiance (for tone-mapped HDR scenes). */
  intensity?: number
  /** Render order of the splat mesh (default 2, after opaque geometry). */
  renderOrder?: number
}

/**
 * Renders 3D Gaussian splats under the Three.js `WebGPURenderer`: SPZ/PLY loading,
 * the `GaussianSplatNodeMaterial` (projection + SH colour in a compute pre-pass),
 * GPU radix sort, and optional octree LOD. Re-sorts/re-selects each frame as the
 * camera moves. The WebGL-only `<GaussianSplats>` (from the `r3f` entry) is the
 * non-WebGPU counterpart.
 */
export const GaussianSplatsGPU = forwardRef<
  GaussianSplatMesh,
  GaussianSplatsGPUProps
>(function GaussianSplatsGPU(
  {
    url,
    data,
    lod,
    sortThresholdDegrees,
    intensity = 1,
    renderOrder = 2,
    ...props
  },
  ref
) {
  const [loaded, setLoaded] = useState<GaussianSplatData | undefined>(data)

  useEffect(() => {
    if (url == null) {
      setLoaded(data)
      return
    }
    let disposed = false
    loadSplatUrl(url)
      .then(result => {
        if (!disposed) {
          setLoaded(result)
        }
      })
      .catch((error: unknown) => {
        console.error(`Failed to load splat file: ${url}`, error)
      })
    return () => {
      disposed = true
    }
  }, [url, data])

  const state = useMemo(() => {
    if (loaded == null) {
      return null
    }
    let material!: GaussianSplatNodeMaterial
    const useLod = lod != null
    const mesh = new GaussianSplatMesh(loaded, {
      createMaterial: geometry => {
        // The LOD path scales coverage by the per-splat alpha cross-fade; the
        // full-cloud path leaves coverage unscaled.
        material = new GaussianSplatNodeMaterial(geometry, { lodFade: useLod })
        return material
      },
      sorter: new GpuSplatSorter(),
      // Inject the WebGPU GPU pipeline factory so the renderer-agnostic mesh stays
      // free of `three/webgpu` at runtime.
      ...(useLod
        ? {
            lod: {
              ...lod,
              createPipeline: (octree, positions, count) =>
                new SplatLodPipeline(octree, positions, count)
            }
          }
        : {}),
      ...(sortThresholdDegrees != null ? { sortThresholdDegrees } : {})
    })
    return { mesh, material }
    // `lod` / `sortThresholdDegrees` are construction-time; changing them rebuilds
    // the mesh. `intensity` is applied live in the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded])

  const mesh = state?.mesh ?? null

  useEffect(() => {
    return () => {
      mesh?.dispose()
    }
  }, [mesh])

  useEffect(() => {
    if (state != null) {
      state.material.intensity.value = intensity
    }
  }, [state, intensity])

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
})
