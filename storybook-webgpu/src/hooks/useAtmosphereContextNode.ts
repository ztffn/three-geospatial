// useAtmosphereContextNode.ts — Injects an AtmosphereContext into the renderer's
// TSL node-build context so atmosphere nodes (aerialPerspective, skyEnvironment,
// StarsNode) resolve it via getAtmosphere() rather than constructor arguments.
// Required by the post-webgpu/clouds takram atmosphere API; one call replaces
// the per-story useLayoutEffect + tslContext boilerplate.

import { useThree } from '@react-three/fiber'
import { useLayoutEffect } from 'react'
import { context as tslContext } from 'three/tsl'
import type { Renderer } from 'three/webgpu'

import type { AtmosphereContext } from '@takram/three-atmosphere/webgpu'

export function useAtmosphereContextNode(context: AtmosphereContext): void {
  const renderer = useThree<Renderer>(({ gl }) => gl as any)
  useLayoutEffect(() => {
    renderer.contextNode = tslContext({
      ...(renderer.contextNode as any).value,
      getAtmosphere: () => context,
    })
  }, [renderer, context])
}
