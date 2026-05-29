import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin'
import type { StorybookConfig } from '@storybook/react-vite'
import react from '@vitejs/plugin-react'
import { mergeConfig, type UserConfig } from 'vite'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..', '..')

const config: StorybookConfig = {
  stories: ['../src/**/*.@(mdx|stories.@(js|jsx|ts|tsx))'],
  addons: [getAbsolutePath('@storybook/addon-docs')],
  framework: {
    name: getAbsolutePath('@storybook/react-vite'),
    options: {}
  },
  features: {
    actions: false,
    interactions: false
  },

  staticDirs: [
    { from: '../assets', to: '/public' },
    { from: '../../packages/ocean-ifft/public', to: '/ocean-ifft' },
    { from: '../../packages/ocean-ifft/resources', to: '/ocean-ifft-resources' }
  ],

  viteFinal: config =>
    mergeConfig(config, {
      plugins: [react(), nxViteTsPaths()],
      // Load .env from repo root (where STORYBOOK_ION_API_TOKEN /
      // STORYBOOK_GOOGLE_MAP_API_KEY live). Without this, Vite's default
      // envDir is the storybook-webgpu/ cwd and root env vars never reach
      // import.meta.env — every tile story 401s on Cesium Ion / Google.
      envDir: repoRoot,
      worker: {
        plugins: () => [nxViteTsPaths()]
      },
      build: {
        commonjsOptions: {
          // Ignore built-in modules used by workerpool.
          ignore: ['os', 'child_process', 'worker_threads']
        },
        sourcemap: process.env.NODE_ENV !== 'production'
      },
      resolve: {
        alias: {
          '@three-geospatial/ocean-ifft': resolve(
            repoRoot,
            'packages/ocean-ifft/src/index.ts'
          )
        }
      },
      server: {
        fs: {
          allow: [repoRoot]
        }
      }
    } satisfies UserConfig)
}

export default config

// To customize your Vite configuration you can use the viteFinal field.
// Check https://storybook.js.org/docs/react/builders/vite#configuration
// and https://nx.dev/recipes/storybook/custom-builder-configs

function getAbsolutePath(value: string): any {
  return dirname(require.resolve(join(value, 'package.json')))
}
