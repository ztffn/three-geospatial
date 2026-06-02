'use client'

import type { ReactElement } from 'react'
import OceanControlsInternal from './OceanControlsInternal'

interface OceanControlsProps {
  waveGenerator: unknown
  oceanManager: unknown
  onAtmosphereChange?: (params: unknown) => void
}

export default function OceanControls({
  waveGenerator,
  oceanManager,
  onAtmosphereChange
}: OceanControlsProps): ReactElement | null {
  if (waveGenerator == null || oceanManager == null || typeof window === 'undefined') {
    return null
  }

  return (
    <OceanControlsInternal
      waveGenerator={waveGenerator}
      oceanManager={oceanManager}
      onAtmosphereChange={onAtmosphereChange}
    />
  )
}
