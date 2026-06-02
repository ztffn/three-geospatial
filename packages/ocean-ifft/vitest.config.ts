/// <reference types='vitest/config' />

// vitest.config.ts — Test target for the ocean-ifft package. Pure-logic units
// (e.g. the WaterPro preset applier's hex→linear conversion and optional-block
// wiring) run under jsdom via the @nx/vite plugin, matching the other packages'
// vitest setup. No build/dts concerns here — this package has no bundle target.

import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin'
import { defineConfig } from 'vite'

export default defineConfig({
  root: __dirname,
  cacheDir: '../../node_modules/.vite/packages/ocean-ifft',
  plugins: [nxViteTsPaths()],
  test: {
    name: 'ocean-ifft',
    watch: false,
    globals: true,
    environment: 'jsdom',
    include: ['{src,tests}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: './test-output/vitest/coverage',
      provider: 'v8' as const
    }
  }
})
