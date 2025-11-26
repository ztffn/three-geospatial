import type { Meta } from '@storybook/react-vite'

import { createStory } from '../components/createStory'
import { Story as OceanStory } from './Ocean-Basic-Story'

import OceanCode from './Ocean-Basic-Story?raw'

export default {
  title: 'ocean/Ocean (WebGPU)',
  tags: ['order:10'],
  parameters: {
    layout: 'fullscreen',
    docs: {
      codePanel: true,
      source: {
        language: 'tsx'
      },
      description: {
        story:
          'Atmosphere light with a simple water plane. Requires a WebGPU-capable browser.'
      }
    }
  }
} satisfies Meta

export const WebGPU = createStory(OceanStory, {
  parameters: {
    docs: {
      source: {
        code: OceanCode
      }
    }
  }
})
