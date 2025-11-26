import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  root: __dirname,
  publicDir: path.resolve(__dirname, '../../packages/ocean-ifft/public'),
  resolve: {
    alias: {
      '@three-geospatial/ocean-ifft/components': path.resolve(
        __dirname,
        '../../packages/ocean-ifft/components'
      ),
      '@three-geospatial/ocean-ifft/resources': path.resolve(
        __dirname,
        '../../packages/ocean-ifft/resources'
      ),
      '@three-geospatial/ocean-ifft': path.resolve(
        __dirname,
        '../../packages/ocean-ifft'
      ),
      '@takram/three-atmosphere': path.resolve(
        __dirname,
        '../../packages/atmosphere/src'
      ),
      '@takram/three-atmosphere/webgpu': path.resolve(
        __dirname,
        '../../packages/atmosphere/src/webgpu'
      ),
      '@takram/three-geospatial': path.resolve(
        __dirname,
        '../../packages/core/src'
      ),
      '@takram/three-geospatial/webgpu': path.resolve(
        __dirname,
        '../../packages/core/src/webgpu'
      )
    }
  },
  server: {
    fs: {
      allow: [
        path.resolve(__dirname, '../../'),
        path.resolve(__dirname, '../../packages/ocean-ifft')
      ]
    }
  }
})
