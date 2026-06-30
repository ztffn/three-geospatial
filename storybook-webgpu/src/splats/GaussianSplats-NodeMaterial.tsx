// WebGPU storybook story for the Gaussian splat node material. Renders EITHER a
// real SPZ capture (spz-js → loadSpzSplatData → GaussianSplatNodeMaterial) or a
// procedurally generated sphere shell, under a plain OrbitControls camera with no
// globe, no logarithmic depth, and no separate-scene composite. This isolates the
// loader + EWA material from the twin integration: if the SPZ renders correctly
// here but wrong in the twin, the bug is in the twin's compositing, not the splats.

import { OrbitControls } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import { useControls } from 'leva'
import { useEffect, useMemo, useRef, useState, type FC } from 'react'
import type { Renderer } from 'three/webgpu'

import {
  GaussianSplatMesh,
  GaussianSplatNodeMaterial,
  GpuSplatSorter,
  loadSpzSplatData,
  SplatLodPipeline,
  type GaussianSplatData
} from '@takram/three-geospatial-splats/webgpu'

import type { StoryFC } from '../components/createStory'
import { Description } from '../components/Description'
import { WebGPUCanvas } from '../components/WebGPUCanvas'
import { rendererArgs, rendererArgTypes } from '../controls/rendererControls'

// SPZ capture served from storybook-webgpu/assets (staticDir → /public). The same
// 8.33M-splat "Superior Marshall Wildfire" sample the twin loads, decoded here in
// the clean standalone path for an apples-to-apples correctness comparison.
const SPZ_URL = '/public/d4ae1c10.spz'

// Generates a genuine Gaussian splat dataset shaped as a thick sphere shell,
// colored by surface direction, so the covariance and sort paths are exercised.
function createSphereSplatCloud(count: number): GaussianSplatData {
  const positions = new Float32Array(count * 3)
  const scales = new Float32Array(count * 3)
  const rotations = new Float32Array(count * 4)
  const colors = new Uint8Array(count * 4)

  // log(0.03): small, roughly isotropic splats.
  const logScale = Math.log(0.03)

  for (let i = 0; i < count; ++i) {
    const u = Math.random() * 2 - 1
    const phi = Math.random() * Math.PI * 2
    const r = Math.sqrt(1 - u * u)
    const nx = r * Math.cos(phi)
    const ny = r * Math.sin(phi)
    const nz = u
    const radius = 1 + (Math.random() - 0.5) * 0.1

    positions[i * 3] = nx * radius
    positions[i * 3 + 1] = ny * radius
    positions[i * 3 + 2] = nz * radius

    scales[i * 3] = logScale
    scales[i * 3 + 1] = logScale
    scales[i * 3 + 2] = logScale

    // Identity orientation (WXYZ).
    rotations[i * 4] = 1

    colors[i * 4] = Math.round((nx * 0.5 + 0.5) * 255)
    colors[i * 4 + 1] = Math.round((ny * 0.5 + 0.5) * 255)
    colors[i * 4 + 2] = Math.round((nz * 0.5 + 0.5) * 255)
    colors[i * 4 + 3] = 255
  }

  return { count, positions, scales, rotations, colors }
}

const Content: FC = () => {
  const renderer = useThree<Renderer>(({ gl }) => gl as unknown as Renderer)
  const camera = useThree(({ camera }) => camera)

  const { source, lod, debug, intensity, lodSize, budget, maxSplats } =
    useControls('Splats', {
    // SPZ is the default — this story exists to validate the real capture.
    source: {
      value: 'SPZ capture',
      options: ['SPZ capture', 'Procedural sphere']
    },
    // Octree LOD on/off. ON = the fully-GPU pipeline (per-splat alpha cross-fade +
    // compaction + sort + indirect draw). OFF = the full-cloud path (GPU radix sort,
    // every loaded splat drawn, no fade) — exercises the non-LOD code path. Rebuilds.
    lod: { value: true },
    // Coordinate/debug, mirrors SpzSplatLoader. flipYZ = RDF→RUB; raw = none;
    // isotropic = equal scales + identity rotation (round blobs). Reloads on change.
    debug: { value: 'flipYZ', options: ['flipYZ', 'raw', 'isotropic'] },
    // No AgX tonemapping here (unlike the twin), so 1 = true 0..1 capture colour.
    intensity: { value: 1, min: 0, max: 4, step: 0.01 },
    // Screen-space LOD cull (px). Collapses splats whose projected stddev is below
    // this → zero fragments → bounds transparent overdraw (the 4M GPU bottleneck).
    // Crank up to trade far-field density for fps; 0 draws every splat.
    lodSize: { value: 1, min: 0, max: 8, step: 0.1 },
    // Octree-LOD render budget: max splats DRAWN per frame. The LOD selector
    // coarsens the farthest octree leaves to fit this, bounding overdraw. Live (no
    // reload). `maxSplats` caps what's LOADED; `budget` caps what's drawn.
    budget: {
      value: 1_000_000,
      options: {
        '4M': 4_000_000,
        '2M': 2_000_000,
        '1M': 1_000_000,
        '500k': 500_000,
        '250k': 250_000
      }
    },
    // Decimation cap. 0 = full (8.33M). Reloads. LOD then bounds what's drawn.
    maxSplats: {
      value: 1_000_000,
      options: {
        Full: 0,
        '4M': 4_000_000,
        '2M': 2_000_000,
        '1M': 1_000_000,
        '500k': 500_000
      }
    }
    }
  )

  const [data, setData] = useState<GaussianSplatData | null>(null)

  useEffect(() => {
    let cancelled = false
    if (source === 'Procedural sphere') {
      setData(createSphereSplatCloud(50000))
      return
    }
    setData(null)
    const started = performance.now()
    void fetch(SPZ_URL)
      .then(async response => {
        if (!response.ok) {
          throw new Error(`SPZ fetch ${response.status} for ${SPZ_URL}`)
        }
        return await response.arrayBuffer()
      })
      .then(async buffer =>
        await loadSpzSplatData(buffer, {
          ...(maxSplats > 0 ? { maxSplats } : {}),
          debug: debug as 'flipYZ' | 'raw' | 'isotropic'
        })
      )
      .then(loaded => {
        if (cancelled) {
          return
        }
         
        console.log(
          `[SplatTest] SPZ loaded: ${loaded.count.toLocaleString()} splats in ${Math.round(performance.now() - started)} ms`
        )
        setData(loaded)
      })
      .catch((error: unknown) => {
         
        console.error('[SplatTest] SPZ load failed:', error)
      })
    return () => {
      cancelled = true
    }
  }, [source, debug, maxSplats])

  const meshState = useMemo(() => {
    if (data == null) {
      return null
    }
    let material!: GaussianSplatNodeMaterial
    const mesh = new GaussianSplatMesh(data, {
      // Octree LOD (PlayCanvas's unified-gsplat approach, ported): build a spatial
      // octree with importance-decimated LOD levels at load, then each frame pick a
      // budgeted target LOD per leaf. The injected GPU pipeline expands that into a
      // per-splat temporal cross-fade, compacts the drawn set, sorts it, and draws it
      // indirectly — bounding the rasterized count. `budget` is tuned live below.
      // Toggled off → the full-cloud path (no pipeline, no fade, every splat drawn).
      ...(lod
        ? {
            lod: {
              budget: 1_000_000,
              createPipeline: (octree, positions, count) =>
                new SplatLodPipeline(octree, positions, count)
            }
          }
        : {}),
      // GPU radix sort (PlayCanvas multipass port) for the non-LOD full-cloud path;
      // dormant while LOD is active (the LOD pipeline sorts its compacted subset).
      sorter: new GpuSplatSorter(),
      // lodFade: scale coverage by the per-splat cross-fade alpha (LOD path only).
      // Linear (non-log) depth, depthWrite off — matches this canvas (no
      // logarithmicDepthBuffer) and the canonical sorted-no-depth splat compositing.
      // None of the twin's log-depth / depthWrite / composite.
      createMaterial: geometry => {
        material = new GaussianSplatNodeMaterial(geometry, { lodFade: lod })
        return material
      }
    })
    return { mesh, material }
  }, [data, lod])

  useEffect(() => {
    const mesh = meshState?.mesh
    return () => {
      mesh?.dispose()
    }
  }, [meshState])

  useEffect(() => {
    if (meshState != null) {
      meshState.material.intensity.value = intensity
      meshState.material.lodSize.value = lodSize
    }
  }, [meshState, intensity, lodSize])

  useEffect(() => {
    meshState?.mesh.setLodBudget(budget)
  }, [meshState, budget])

  // Live LOD diagnostics in the panel: `drawn` = splats actually rendered (should
  // cap at budget); `leaves` = visible/total (visible < total ⇒ frustum culling is
  // dropping off-screen leaves — pan so part of the cloud leaves the view to see it
  // drop). Stays "—" if the worker never resolves (LOD off — check the console).
  const [, setLodInfo] = useControls('LOD stats', () => ({
    drawn: { value: '—', editable: false },
    leaves: { value: '—', editable: false }
  }))
  const lastLodInfo = useRef('')

  useFrame(() => {
    if (meshState == null) {
      return
    }
    meshState.mesh.update(renderer, camera)
    // Push LOD stats to the panel only when they change (no per-frame re-render).
    const stats = meshState.mesh.lodStats
    if (stats != null) {
      const line = `${stats.activeCount}|${stats.visibleLeaves}/${stats.totalLeaves}`
      if (line !== lastLodInfo.current) {
        lastLodInfo.current = line
        setLodInfo({
          drawn: stats.activeCount.toLocaleString(),
          leaves: `${stats.visibleLeaves}/${stats.totalLeaves}`
        })
      }
    }
  })

  return (
    <>
      <color attach='background' args={[0.02, 0.02, 0.04]} />
      <OrbitControls />
      {meshState != null && <primitive object={meshState.mesh} />}
    </>
  )
}

interface StoryProps {}

export const Story: StoryFC<StoryProps> = () => (
  // Camera framed for the ~8 m capture (radius ≈ 4.6 m, centroid near origin).
  <WebGPUCanvas camera={{ fov: 45, position: [9, 5, 11], near: 0.1, far: 1000 }}>
    <Content />
    <Description />
  </WebGPUCanvas>
)

Story.args = {
  ...rendererArgs()
}

Story.argTypes = {
  ...rendererArgTypes()
}
