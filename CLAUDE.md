# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Architecture Overview

This is a **monorepo** for geospatial rendering libraries in Three.js, managed with **Nx**. The project follows a modular approach with four main publishable packages:

### Core Packages (`packages/`)
- **core**: Fundamental GIS rendering functions, geometries, and utilities
- **atmosphere**: Precomputed atmospheric scattering implementation (Bruneton model)
- **clouds**: Geospatial volumetric cloud rendering
- **effects**: Post-processing effects for geospatial rendering

### Supporting Directories
- **storybook/**: WebGL Storybook stories and examples (separate from libraries to avoid circular deps)
- **storybook-webgpu/**: WebGPU Storybook stories for next-gen implementation
- **apps/data/**: Command-line app for generating precomputed data

### Dual Implementation Strategy
The project is transitioning from **WebGL shader-chunk-based** to **WebGPU node-based** architecture:
- Current WebGL implementation uses traditional shaders in `src/shaders/`
- New WebGPU implementation uses Three.js node materials in `src/webgpu/`
- Both implementations coexist during transition

### Key Dependencies
- **Three.js ecosystem**: three, @react-three/fiber, @react-three/drei, @react-three/postprocessing
- **3d-tiles-renderer**: For 3D Tiles support
- **postprocessing**: Effect composer framework
- **astronomy-engine**: Celestial calculations
- **React/TypeScript**: Component framework and type safety

## Common Development Commands

### Main Commands (run from root)
```bash
# Development
nx storybook                    # Run WebGL Storybook (port 4400)
nx storybook-webgpu            # Run WebGPU Storybook (port 4400)

# Building
nx build                       # Build all libraries and apps
nx build-libs                  # Build only libraries
nx build {package-name}        # Build specific package (core, atmosphere, clouds, effects)

# Testing
nx test                        # Run all tests (Vitest)
nx test {package-name}         # Test specific package

# Code Quality
nx lint                        # Run ESLint on all packages
nx format-all                  # Format code with Prettier

# Clean
pnpm clean                     # Clean all build outputs and caches
nx reset                       # Reset Nx cache
```

### Individual Package Commands
Each package supports these Nx-inferred targets:
- `nx build {package}` - Build library
- `nx test {package}` - Run tests
- `nx lint {package}` - Lint code
- `nx typecheck {package}` - Type checking

### Storybook Troubleshooting
If encountering dependency or hook errors:
```bash
rm -r storybook/node_modules
nx reset
nx storybook
# Open in new browser window
```

## Environment Setup

Create `.env` file in root with:
```
STORYBOOK_GOOGLE_MAP_API_KEY=your_key_here
STORYBOOK_ION_API_TOKEN=your_token_here
```

## Code Organization Patterns

### Package Structure
```
packages/{name}/
├── src/
│   ├── index.ts              # Main exports
│   ├── r3f/                  # React Three Fiber components
│   ├── shaders/              # WebGL GLSL shaders
│   ├── webgpu/               # WebGPU node implementations
│   └── helpers/              # Utility functions
├── assets/                   # Binary data (textures, LUTs)
└── vite.config.ts           # Build configuration
```

### Import Patterns
- Packages export multiple entry points: main, r3f, shaders, webgpu
- Use `@takram/three-{package}` for imports in examples
- Internal cross-package imports use workspace references

### Testing
- Uses **Vitest** with jsdom environment
- Test files: `*.test.ts` or `*.spec.ts`
- Coverage reports in `./test-output/vitest/coverage`

## Development Notes

### WebGPU Branch
Currently on `webgpu-clouds` branch implementing next-generation node-based architecture. This will eventually replace the current WebGL implementation.

### Asset Management
- Uses Git LFS for binary assets
- Precomputed atmospheric data in `packages/atmosphere/assets/`
- 3D models and textures in `storybook/assets/` and `storybook-webgpu/assets/`

### Storybook Separation
Stories are intentionally separated from packages to avoid circular dependencies and enable fast-refresh for component-only files.