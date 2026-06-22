// Storybook registration for the WebGPU Gaussian splats stories. Surfaces the
// node-material render path under the "splats" section of the WebGPU storybook.

import type { Meta } from '@storybook/react-vite'

import { createStory } from '../components/createStory'
import { Story } from './GaussianSplats-NodeMaterial'

import Code from './GaussianSplats-NodeMaterial?raw'

export default {
  title: 'splats/Gaussian Splats',
  parameters: {
    docs: {
      codePanel: true,
      source: {
        language: 'tsx'
      }
    }
  }
} satisfies Meta

export const NodeMaterial = createStory(Story, {
  parameters: {
    docs: {
      source: {
        code: Code
      }
    }
  }
})
