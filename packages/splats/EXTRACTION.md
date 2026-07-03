# Extracting into a standalone open-source repo

How to lift `packages/splats/` out of this Nx monorepo into its own MIT-licensed
repository. The package is already nearly self-contained (see
[`ARCHITECTURE.md` § Extraction note](./ARCHITECTURE.md)), so this is mostly
mechanical. Do it in a fresh session — this is the plan.

## 1. Copy and rename

- Copy `packages/splats/{src,README.md,ARCHITECTURE.md,package.json,vite.config.ts,tsconfig*.json}`
  into a new repo.
- Rename the package in `package.json` (e.g. `three-spz-splats`). Set `repository`,
  `homepage`, `bugs`.

## 2. Fix dependencies

- **Drop `@takram/three-geospatial`** from `dependencies` — the `src/` imports
  nothing from it (verified: `rg "@takram/three-geospatial" src` → no hits).
- Keep `dependencies`: `spz-js`, `tiny-invariant`.
- Keep `peerDependencies`: `three` (required); `@react-three/fiber` + `react`
  (only for `r3f` / the WebGPU `GaussianSplatsGPU` component); `3d-tiles-renderer`
  (only for the tiles plugin — used as a structural type, so any recent version).
- The three entry points (`.`, `./webgpu`, `./r3f`) and their `exports` map carry
  over unchanged.

## 3. Build + types

- The package builds with its existing `vite.config.ts` (library mode) + `tsc`
  for declarations. Confirm the build emits `build/{index,webgpu,r3f}.{js,cjs}` and
  `types/`. Replace any Nx-inferred targets with plain scripts
  (`vite build`, `tsc --emitDeclarationOnly`, `vitest`, `eslint`).
- The `SplatLodWorker.ts` is a Vite worker module
  (`new Worker(new URL('./SplatLodWorker.ts', import.meta.url), { type: 'module' })`).
  This bundles correctly under Vite (and the consumer's Vite). Document that
  non-Vite consumers may need a worker plugin, or ship a prebuilt worker.

## 4. Tests + CI

- Unit tests exist: `GaussianSplatSorter.test.ts`, `PLYSplatLoader.test.ts`
  (Vitest). Keep `vite.config.ts`'s test config.
- CI: typecheck (`tsc --noEmit`), `eslint`, `vitest run`, `vite build`. No WebGPU
  in CI — rendering is verified manually (see below).

## 5. A standalone demo (replaces the Storybook harness)

The current visual harness lives **outside** the package
(`storybook-webgpu/src/splats/GaussianSplats-NodeMaterial.tsx`) and does not travel
with it. Add a small `examples/` Vite app to the new repo:

- Use `<GaussianSplatsGPU url="scene.spz" lod={{ budget: 1_000_000 }} />` inside an
  R3F `<Canvas>` backed by `WebGPURenderer`.
- **Replicate the device-limit raising** — request the adapter's
  `maxStorageBufferBindingSize` / `maxBufferSize` / `maxTextureDimension2D`
  (see `storybook-webgpu/src/components/WebGPUCanvas.tsx`). Without it, clouds above
  ~2M splats fail to allocate.
- Ship a **small** sample `.spz` (the 8.33M test asset is too big for git — host
  large assets on a CDN, or include a few-hundred-K sample).

## 6. License + attribution

- Add an MIT `LICENSE`.
- Keep the README's Attribution section. Add a `NOTICE` crediting the ported code:
  PlayCanvas Engine (radix sort, octree LOD — MIT), kishimisu/WebGPU-Radix-Sort
  (MIT). These are ports, so attribution is required.

## 7. Optional polish before announcing

- A dedicated `./webgpu/r3f` entry point so importing the React component doesn't
  pull React into non-React `./webgpu` consumers (currently `GaussianSplatsGPU` is
  exported from `./webgpu`; tree-shaking handles it, but a separate entry is cleaner).
- Move the octree build into the worker (currently CPU on the main thread at load).
- The temporal LOD cross-fade (GPU work-buffer + interval-compaction) — see the
  separate handover for that; it is the headline feature gap for "best-in-class".

## Sanity check before publishing

```bash
rg "@takram" src            # expect: no hits
npm pack --dry-run          # inspect the file list + exports
# In a scratch Vite app: import from each entry point and render a small .spz.
```
