# Repository Guidelines

## Project Structure & Modules
- Nx monorepo using pnpm. Publishable libraries live in `packages/*` (`core`, `atmosphere`, `clouds`, `effects`, `ocean-ifft`), Storybook compositions in `storybook` and `storybook-webgpu`, CLI-style data tooling in `apps/data`, and example sandboxes in `examples`. Built output lands in `dist/`.
- Type declarations shared via `types/`; assets stay co-located under each package’s `assets/`.
- Prefer adding new code as libraries under `packages/` with `tags` in `project.json` (`type:lib` or `type:app`) so Nx dependency boundaries stay intact.

## Build, Test, and Development Commands
- Install: `pnpm install` (Git LFS assets may require `git lfs pull`).
- Lint all: `pnpm exec nx lint` or `pnpm exec nx run-many --target=lint --parallel=8`.
- Format: `pnpm exec nx format:write --all`.
- Test: `pnpm exec nx test` (uses Vitest; `--passWithNoTests` is enabled, but add coverage when touching core paths).
- Build everything: `pnpm exec nx build` (production config); libs/apps separately via `pnpm exec nx run-many --target=build --projects=tag:type:lib` or `--projects=tag:type:app`.
- Storybook: `pnpm exec nx storybook storybook --port=4400` (WebGPU variant: `storybook-webgpu`).

## Coding Style & Naming
- TypeScript-first, ES modules. Default to 2-space indent, no semicolons, and descriptive named exports; keep files small and domain-focused.
- Linting via flat ESLint with `eslint-config-love` and Nx module-boundary checks—no cross-package imports without tags and public entrypoints.
- Formatting by Prettier with import sorting; run the formatter before pushing. Keep shaders/assets under `assets/` and avoid inline large binaries.

## Testing Guidelines
- Vitest is the primary runner; colocate specs as `*.spec.ts` or `*.spec.tsx` next to source. Favor deterministic math/geometry fixtures and guard edge cases (projection bounds, WebGPU/WebGL parity).
- For changes that affect visuals, add Storybook stories or update existing ones rather than snapshot-heavy tests.
- Aim to cover new public APIs and failure modes; prefer table-driven tests for coordinate transforms.

## Commit & Pull Request Guidelines
- Commit messages: short, imperative sentences (e.g., `Add ellipsoid normal helper`). Align with the existing history; group related edits.
- PRs should describe intent, approach, and verification. Link issues when available, include before/after screenshots or Storybook URLs for visual changes, and note any env vars or data dependencies.
- Keep diffs minimal: avoid drive-by formatting outside touched areas; run lint/format/test targets before requesting review.

## Environment & Assets
- Storybook needs `STORYBOOK_GOOGLE_MAP_API_KEY` and `STORYBOOK_ION_API_TOKEN` in a root `.env`; never commit keys.
- Large binary data relies on Git LFS; ensure it is installed locally. Place new datasets in `apps/data` workflows and document generation scripts.
