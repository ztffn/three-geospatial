'use client';

interface OceanControlsProps {
  waveGenerator: any;
  oceanManager: any;
  onAtmosphereChange?: (params: any) => void;
}

// Internal controls are imported directly; caller should ensure a client-only environment.
import OceanControlsInternal from './OceanControlsInternal';

export default function OceanControls({ waveGenerator, oceanManager, onAtmosphereChange }: OceanControlsProps) {
  if (!waveGenerator || !oceanManager || typeof window === 'undefined') {
    return null;
  }

  return (
    <OceanControlsInternal
      waveGenerator={waveGenerator}
      oceanManager={oceanManager}
      onAtmosphereChange={onAtmosphereChange}
    />
  );
}
