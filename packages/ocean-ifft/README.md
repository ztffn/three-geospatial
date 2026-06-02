# @three-geospatial/ocean-ifft

WebGPU ocean IFFT prototype wrapped for the three-geospatial monorepo. This package exposes a minimal set of React components (R3F) that bridge the legacy ocean engine to our WebGPU renderer and atmosphere.

> Status: prototype. The core simulation is still an imported JS codebase and will be incrementally migrated to TypeScript.

## Packages and layout

- `src/` – package entrypoints. `src/index.ts` re-exports the R3F layer under `src/r3f`.
- `components/` – current React components (R3F). These will move under `src/r3f/` in a future cleanup.
- `resources/` – shaders and textures used by the legacy engine.
- `public/` – static assets served in Storybook/demo.
- `presets/` – JSON presets for ocean parameters.

## Usage

```ts
import { WaveGenerator, OceanChunks, PostProcessing, OceanControls } from '@three-geospatial/ocean-ifft'
```

## Development

- Lint (components only): `pnpm exec eslint packages/ocean-ifft/components --ext .ts,.tsx`
- Storybook (WebGPU): `pnpm exec nx storybook storybook-webgpu --port=4400`

## TODO

- Migrate the legacy JS engine under `src` to TypeScript with proper types.
- Align folder structure with other packages (move components into `src/r3f`, add build target).
- Replace remaining `any` bridges and remove temporary lint relaxations once engine is typed.
