// G-A scaffold story registration. The Story file mounts the globe-scale
// ocean scene (atmosphere + 3D-tiles terrain + tiled IFFT ocean via the
// LEGACY material) inside storybook-webgpu, mirroring localhost:5173's
// GlobeOceanProto.tsx. Phases G-B/G-C will swap the chunk material to the
// WaterPro TSL composition; this scaffold proves the scene composes.

import type { Meta } from '@storybook/react-vite'
import { createStory } from '../components/createStory'
import { Story as GlobeWaterproOceanStory } from './GlobeWaterproOcean-Story'
import GlobeWaterproOceanCode from './GlobeWaterproOcean-Story?raw'

export default {
  title: 'ocean/Globe WaterPro Ocean',
  parameters: {
    layout: 'fullscreen',
    docs: {
      codePanel: true,
      source: { language: 'tsx' },
      description: {
        story:
          'Globe-scale ocean scaffold mirroring localhost:5173 (examples/ocean-ifft-demo). Mounts AtmosphereContextNode + 3D-tiles Cesium terrain + the legacy IFFT ocean (WaveGenerator + OceanChunks + ocean-material.js). Subsequent phases (G-B/G-C) replace the chunk material with the WaterPro TSL composition.',
      },
    },
  },
} satisfies Meta

export const GlobeWaterproOcean = createStory(GlobeWaterproOceanStory, {
  parameters: {
    docs: {
      source: { code: GlobeWaterproOceanCode },
    },
  },
})
