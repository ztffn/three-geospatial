import { Canvas, useFrame } from '@react-three/fiber'
import { useEffect, useState } from 'react'
import * as THREE from 'three/webgpu'
import WebGPU from 'three/examples/jsm/capabilities/WebGPU.js'
import { OrbitControls } from '@react-three/drei'

import TakramAtmosphereOcean from '../../packages/ocean-ifft/components/TakramAtmosphereOcean'

function OceanScene() {
  // Minimal wrapper to ensure WebGPU renderer is used.
  return <TakramAtmosphereOcean />
}

export default function OceanWebGPU() {
  const [supported, setSupported] = useState(false)

  useEffect(() => {
    setSupported(WebGPU.isAvailable())
  }, [])

  if (!supported) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          padding: '1rem'
        }}
      >
        WebGPU is not available. Use Chrome/Edge 113+ with WebGPU enabled.
      </div>
    )
  }

  return (
    <div style={{ width: '100%', height: '100vh' }}>
      <Canvas
        gl={async glProps => {
          const renderer = new THREE.WebGPURenderer({
            ...glProps,
            antialias: true,
            logarithmicDepthBuffer: true
          } as any)
          renderer.setPixelRatio(window.devicePixelRatio)
          renderer.shadowMap.enabled = true
          renderer.outputColorSpace = THREE.SRGBColorSpace
          await renderer.init()
          return renderer
        }}
        camera={{ position: [0, 3, 10], fov: 50, near: 0.1, far: 1e6 }}
      >
        <OrbitControls target={[0, 0, 0]} minDistance={2} maxDistance={1000} />
        <OceanScene />
      </Canvas>
    </div>
  )
}
