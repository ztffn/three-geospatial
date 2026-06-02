// Storybook meta for the WaterPro depth-node demo.
// Registers the story under ocean/WaterPro Depth Demo.
// Story source is in WaterproDepthDemo-Story.tsx.

import type { Meta } from '@storybook/react-vite'
import { createStory } from '../components/createStory'
import { Story as WaterproDepthDemoStory } from './WaterproDepthDemo-Story'
import WaterproDepthDemoCode from './WaterproDepthDemo-Story?raw'

export default {
  title: 'ocean/WaterPro Depth Demo',
  parameters: {
    layout: 'fullscreen',
    docs: {
      codePanel: true,
      source: { language: 'tsx' },
      description: {
        story:
          'Depth pre-pass → waterColorNode + shorelineFoamNode. No IFFT. Terrain box top at y=−1; foam expected over box, deep blue elsewhere.'
      }
    }
  }
} satisfies Meta

export const DepthDemo = createStory(WaterproDepthDemoStory, {
  parameters: {
    docs: {
      source: { code: WaterproDepthDemoCode }
    }
  }
})
