// Storybook meta for the atmosphere-driven WaterPro demo.
// Sibling of WaterproDepthDemo.stories — does NOT replace it. Adds a separate
// entry that mounts AtmosphereContextNode + preset selector, mirroring the
// material pattern from ocean-material.js (MeshStandard + colorSpace=SRGB +
// PBR-lit colorNode + 0.55 dim + AgX exposure 10 post-pass).

import type { Meta } from '@storybook/react-vite'
import { createStory } from '../components/createStory'
import { Story as WaterproAtmosphereStory } from './WaterproAtmosphere-Story'
import WaterproAtmosphereCode from './WaterproAtmosphere-Story?raw'

export default {
  title: 'ocean/WaterPro Atmosphere',
  parameters: {
    layout: 'fullscreen',
    docs: {
      codePanel: true,
      source: { language: 'tsx' },
      description: {
        story:
          'WaterPro pipeline driven by AtmosphereContextNode. Sun direction, sky reflection, and atmospheric haze all flow from the atmosphere context. Preset selector writes water-only fields; atmosphere/caustics/oceanFloor/postProcessing/fresnel.underwater/ssr fields from the source presets are intentionally skipped.'
      }
    }
  }
} satisfies Meta

export const Atmosphere = createStory(WaterproAtmosphereStory, {
  parameters: {
    docs: {
      source: { code: WaterproAtmosphereCode }
    }
  }
})
