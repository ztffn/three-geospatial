import type { Meta } from '@storybook/react-vite'

import { createStory } from '../components/createStory'
import { Story as OceanStory } from './Ocean-Basic-Story'
import { Story as OceanAerialStory } from './Ocean-AerialPerspective'
import { Story as GlobePatchStory } from './Ocean-Globe-Patch'

import OceanCode from './Ocean-Basic-Story?raw'
import OceanAerialCode from './Ocean-AerialPerspective?raw'
import GlobePatchCode from './Ocean-Globe-Patch?raw'

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

export const AerialPerspective = createStory(OceanAerialStory, {
  props: {
    longitude: 138.5,
    latitude: 36.2,
    height: 5000,
    heading: -90,
    pitch: -20,
    distance: 2000
  },
  parameters: {
    docs: {
      source: {
        code: OceanAerialCode
      }
    }
  }
})

export const GlobePatch = createStory(GlobePatchStory, {
  props: {
    longitude: 0,
    latitude: 0,
    height: 0
  },
  parameters: {
    docs: {
      source: {
        code: GlobePatchCode
      }
    }
  }
})
