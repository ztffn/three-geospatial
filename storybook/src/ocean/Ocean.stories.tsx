import type { Meta, StoryObj } from '@storybook/react-vite'

import _OceanWebGPU from './Ocean-WebGPU'

const meta = {
  title: 'ocean/Ocean (WebGPU)',
  component: _OceanWebGPU,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        story:
          'Minimal WebGPU ocean + atmosphere demo using the ported ocean-ifft components. Requires a WebGPU-capable browser.'
      }
    }
  }
} satisfies Meta<typeof _OceanWebGPU>

export default meta

type Story = StoryObj<typeof meta>

export const WebGPU: Story = {
  render: () => <_OceanWebGPU />
}
