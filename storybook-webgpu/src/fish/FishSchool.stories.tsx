import type { Meta } from '@storybook/react-vite'

import { createStory } from '../components/createStory'
import { Story as FishSchoolStory } from './FishSchool-Story'

import FishSchoolCode from './FishSchool-Story?raw'

export default {
  title: 'fish/FishSchool',
  tags: ['order:35'],
  parameters: {
    layout: 'fullscreen',
    docs: {
      codePanel: true,
      source: {
        language: 'tsx',
        code: FishSchoolCode
      },
      description: {
        story:
          'CPU-instanced fish school prototype with independent shallow-water depth control.'
      }
    }
  }
} satisfies Meta

export const ShallowWater = createStory(FishSchoolStory)
