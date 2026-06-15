// Vite config for the standalone Globe WaterPro Ocean demo.
// Mirrors the storybook-webgpu staticDirs mapping so the storybook story
// component can be reused unmodified: /public/* -> storybook-webgpu/assets,
// /ocean-ifft-resources/* -> packages/ocean-ifft/resources. Only the assets
// the WaterPro globe story actually touches are copied into the build.

import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import type { ServerResponse } from 'node:http'
import path from 'node:path'
import sirv from 'sirv'
import { defineConfig, loadEnv, type Plugin } from 'vite'

import { fetchMergedForecast } from '../../netlify/functions/_met-core'
import {
  fetchAisPositions,
  fetchVesselTrack
} from '../../netlify/functions/_ais-core'
import { SHADOW_FLEET } from './ui/shadowFleet'

const SHADOW_FLEET_IMOS = SHADOW_FLEET.map(v => v.imo)

const repoRoot = path.resolve(__dirname, '../../')

// Bridge the UNPREFIXED BarentsWatch secrets from the root .env into
// process.env so the dev AIS proxy (which reads process.env, exactly like the
// prod server) can authenticate. Vite only surfaces VITE_/STORYBOOK_ vars, and
// only to the client bundle — these two stay server-side and never get inlined.
// Skipped on Netlify, where env comes from the platform. Without this the dev
// AIS endpoint 503s ("credentials missing") even though .env has the values.
if (process.env.NETLIFY !== 'true') {
  const rootEnv = loadEnv('development', repoRoot, '')
  for (const key of ['BARENTSWATCH_CLIENT_ID', 'BARENTSWATCH_CLIENT_SECRET']) {
    if (process.env[key] == null && rootEnv[key] != null) {
      process.env[key] = rootEnv[key]
    }
  }
}
const storybookAssets = path.resolve(repoRoot, 'storybook-webgpu/assets')
const oceanIfftResources = path.resolve(repoRoot, 'packages/ocean-ifft/resources')

// Files referenced at runtime by GlobeWaterproOcean-Story.tsx +
// OceanChunksWaterpro.tsx. Atmosphere LUTs are computed on-GPU in the WebGPU
// pipeline (no .bin LUTs needed); stars.bin is bundled via `new URL(...)`.
const staticAssets: Array<{ from: string; to: string }> = [
  // Subsea cable network: submarine power (OSM/ODbL) + telecom (TeleGeography/
  // CC BY-NC-SA) for the North Sea/Arctic overview, fetched and drawn as ECEF
  // line geometry by the scene.
  {
    from: path.join(storybookAssets, 'subsea-cables.json'),
    to: 'public/subsea-cables.json'
  },
  // Draco+WebP compressed turbines (light farm model + detailed hero). ~440 KB
  // and ~6 MB — decoded via the DRACOLoader the useGLTF hook configures.
  {
    from: path.join(storybookAssets, 'turbine-demo_compressed.glb'),
    to: 'public/turbine-demo_compressed.glb'
  },
  {
    from: path.join(storybookAssets, 'turbine-demo3_compressed.glb'),
    to: 'public/turbine-demo3_compressed.glb'
  },
  // Service vessels (ShipModel.tsx SHIP_DEFS) — buoyancy + hull occluders.
  {
    from: path.join(storybookAssets, 'ship-demo-compressed.glb'),
    to: 'public/ship-demo-compressed.glb'
  },
  {
    from: path.join(storybookAssets, 'ship-demo-small-compressed.glb'),
    to: 'public/ship-demo-small-compressed.glb'
  },
  // Patrol ship (Bodø scenario) + offshore platform (Norwegian Sea scenario).
  {
    from: path.join(storybookAssets, 'patrolship-compressed.glb'),
    to: 'public/patrolship-compressed.glb'
  },
  {
    from: path.join(storybookAssets, 'platform-compressed.glb'),
    to: 'public/platform-compressed.glb'
  },
  // Huma brand mark (top-left overlay in main.tsx): favicon + HumaDisplay
  // wordmark font. Served at /public/brand/* (dev via sirv, build via copy).
  {
    from: path.join(storybookAssets, 'brand/huma-favicon.png'),
    to: 'public/brand/huma-favicon.png'
  },
  {
    from: path.join(storybookAssets, 'brand/HumaDisplay-Light.otf'),
    to: 'public/brand/HumaDisplay-Light.otf'
  },
  {
    from: path.join(storybookAssets, 'brand/HumaDisplay-Regular.otf'),
    to: 'public/brand/HumaDisplay-Regular.otf'
  },
  {
    from: path.join(oceanIfftResources, 'textures/simplex-noise.png'),
    to: 'ocean-ifft-resources/textures/simplex-noise.png'
  },
  ...['nx', 'ny', 'nz', 'px', 'py', 'pz'].map(f => ({
    from: path.join(oceanIfftResources, `textures/cube/sky/${f}.jpg`),
    to: `ocean-ifft-resources/textures/cube/sky/${f}.jpg`
  }))
]

function staticDirsPlugin(): Plugin {
  let outDir = 'dist'
  return {
    name: 'static-dirs',
    configResolved(config) {
      outDir = config.build.outDir
    },
    configureServer(server) {
      // Dev: serve the same URL prefixes Storybook does via sirv middleware.
      server.middlewares.use('/public', sirv(storybookAssets, { dev: true }))
      server.middlewares.use(
        '/ocean-ifft-resources',
        sirv(oceanIfftResources, { dev: true })
      )
    },
    async writeBundle() {
      // Build: copy only the explicitly listed runtime assets.
      const root = path.resolve(__dirname, outDir)
      for (const { from, to } of staticAssets) {
        const dest = path.join(root, to)
        await fs.promises.mkdir(path.dirname(dest), { recursive: true })
        await fs.promises.copyFile(from, dest)
      }
    }
  }
}

// Write a JSON response (shared by both dev proxies below). Dev responses are
// always no-store so the browser re-hits the live upstream each time.
function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown
): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

// Dev-server mirror of the MET proxy. In production the self-hosted server
// answers this path; under plain `vite` there are no functions, so emulate it
// with middleware that runs the same fetchMergedForecast (server-side, so the
// MET User-Agent is set and there's no CORS). One identical URL in dev + prod.
function metDevProxyPlugin(): Plugin {
  return {
    name: 'met-dev-proxy',
    configureServer(server) {
      server.middlewares.use('/.netlify/functions/met', (req, res) => {
        const url = new URL(req.url ?? '', 'http://localhost')
        const lat = Number(url.searchParams.get('lat'))
        const lon = Number(url.searchParams.get('lon'))
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
          sendJson(res, 400, { error: 'lat and lon required' })
          return
        }
        fetchMergedForecast(lat, lon)
          .then(forecast => sendJson(res, 200, forecast))
          .catch((err: Error) => sendJson(res, 502, { error: err.message }))
      })
    }
  }
}

// Dev mirror of the BarentsWatch AIS proxy. Same same-origin path the client
// polls in prod; runs the token exchange + latest-positions fetch server-side
// (secret stays off the bundle). 503 when credentials are absent so the client
// simply shows no markers — never fabricated positions.
function aisDevProxyPlugin(): Plugin {
  return {
    name: 'ais-dev-proxy',
    configureServer(server) {
      server.middlewares.use(
        '/.netlify/functions/ais-shadow-fleet',
        (_req, res) => {
          fetchAisPositions(SHADOW_FLEET_IMOS)
            .then(data => sendJson(res, 200, data))
            .catch((err: Error) => sendJson(res, 503, { error: err.message }))
        }
      )
      server.middlewares.use(
        '/.netlify/functions/ais-track',
        (req, res) => {
          const url = new URL(req.url ?? '', 'http://localhost')
          const mmsi = Number(url.searchParams.get('mmsi'))
          if (!Number.isFinite(mmsi) || mmsi <= 0) {
            sendJson(res, 400, { error: 'missing or invalid mmsi' })
            return
          }
          fetchVesselTrack(mmsi)
            .then(data => sendJson(res, 200, data))
            .catch((err: Error) => sendJson(res, 503, { error: err.message }))
        }
      )
    }
  }
}

// Make the IFFT ocean chunk-builder worker production-safe WITHOUT modifying
// any file under packages/ocean-ifft/. Two textual transforms applied via
// Vite's transform hook:
//
//   1. ocean-builder-threaded.js — the chunk-rebuilder constructor passes
//      `new URL('./ocean-builder-threaded-worker.js', import.meta.url)` to a
//      WorkerThreadPool that internally calls `new Worker(url, { type: 'module' })`.
//      Vite's static analyzer recognizes the `new Worker(new URL(...), { type:
//      'module' })` pattern ONLY when it's directly inline; through the pool
//      indirection it never bundles the worker's deps. Result: the emitted
//      worker file ships a literal `import * as THREE from 'three/webgpu'`
//      that the browser can't resolve (returns SPA fallback HTML for the bare
//      specifier → worker dies silently → chunks never build → black ocean).
//      Fix: prepend an `import workerUrl from './ocean-builder-threaded-worker.js?worker&url'`
//      and replace the inline `new URL(...)` with a reference to that import.
//      Combined with `worker.format: 'es'` below, the bundled worker is an ES
//      module with three/webgpu inlined.
//
//   2. ocean-builder-threaded-worker.js — wrap the `self.onmessage` handler in
//      a try/catch and add an explicit `self.addEventListener('error', ...)`.
//      In the production-bundled IIFE/ES worker context, synchronous throws
//      from inside Init/Build don't surface to the main thread (the browser
//      swallows them) and the WorkerThreadPool sits with the slot permanently
//      "busy", so chunks never get rebuilt. Mirroring exceptions back as
//      synthetic messages lets the resolve callback fire, frees the pool
//      slot, and prevents silent deadlocks. Surfaced exceptions appear in
//      DevTools as `[ocean-worker:error]` (see main.tsx for the listener).
//
// Both transforms are applied to source-as-loaded; the on-disk files in
// packages/ocean-ifft/ are never touched.
function ifftWorkerHardeningPlugin(): Plugin {
  const builderPath = 'packages/ocean-ifft/src/ocean/ocean-builder-threaded.js'
  const workerPath =
    'packages/ocean-ifft/src/ocean/ocean-builder-threaded-worker.js'
  return {
    name: 'ifft-worker-hardening',
    enforce: 'pre',
    transform(code, id) {
      // Skip Vite's post-process view of the ?worker&url import — by the
      // time this transform sees that id, the source has already been
      // replaced by Vite with `export default "__VITE_WORKER_ASSET__..."`.
      // The actual worker source is visited via the worker sub-build (see
      // `worker.plugins` below) with the query-free id.
      if (id.includes('?worker')) return null
      const normalized = id.replace(/\\/g, '/')
      if (normalized.endsWith(builderPath)) {
        const target =
          "new URL('./ocean-builder-threaded-worker.js', import.meta.url)"
        if (!code.includes(target)) return null
        return {
          code:
            "import __OCEAN_BUILDER_WORKER_URL__ from " +
            "'./ocean-builder-threaded-worker.js?worker&url';\n" +
            code.replace(target, '__OCEAN_BUILDER_WORKER_URL__'),
          map: null
        }
      }
      if (normalized.endsWith(workerPath)) {
        // Match the canonical onmessage block at the end of the worker file,
        // independent of indentation, line endings (CRLF vs LF), and minor
        // whitespace variations. Captures the full block from `self.onmessage`
        // through the closing `};`.
        const onmessageRe =
          /self\.onmessage\s*=\s*\(msg\)\s*=>\s*\{[\s\S]*?self\.postMessage\(\s*\{\s*data:\s*rebuiltData\s*\}\s*\)\s*;[\s\S]*?\}\s*;/
        if (!onmessageRe.test(code)) {
          this.warn(
            'ifft-worker-hardening: expected onmessage block in worker file did not match HEAD. Worker fix skipped — ocean will likely be flaky in production.'
          )
          return null
        }
        const replacement = [
          "// Build-time injection by examples/ocean-globe-waterpro-demo/vite.config.ts",
          "// (ifftWorkerHardeningPlugin). Surfaces synchronous Init/Build throws as",
          "// synthetic messages so the WorkerThreadPool can free the busy slot",
          "// instead of deadlocking forever.",
          "self.addEventListener('error', function (e) {",
          "  self.postMessage({ __workerError: true, message: e.message, filename: e.filename, lineno: e.lineno });",
          "});",
          "self.onmessage = function (msg) {",
          "  try {",
          "    CHUNK.Init(msg.data.params);",
          "    const rebuiltData = CHUNK.Build();",
          "    self.postMessage({ data: rebuiltData });",
          "  } catch (err) {",
          "    self.postMessage({ __workerError: true, message: err && err.message, stack: err && err.stack });",
          "  }",
          "};"
        ].join('\n')
        return { code: code.replace(onmessageRe, replacement), map: null }
      }
      return null
    }
  }
}

// Fail the build if any JWT- or PEM-shaped secret ended up in the emitted
// JS UNLESS the caller acknowledges that a domain-restricted browser token
// is expected (Cesium Ion / Google Maps style — token MUST be in the bundle,
// safety comes from provider-side restriction).
//
// Netlify sets NETLIFY=true on its build runners; that's the opt-out
// signal — Netlify env vars are the source of truth for the restricted
// token. Any LOCAL `vite build` will trip the guard if a token from a
// committed/local .env got inlined.
function secretGuardPlugin(): Plugin {
  let outDir = 'dist'
  return {
    name: 'secret-guard',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir
    },
    async closeBundle() {
      if (
        process.env.NETLIFY === 'true' ||
        process.env.ALLOW_BAKED_BROWSER_TOKENS === '1'
      ) {
        // eslint-disable-next-line no-console
        console.log(
          '[secret-guard] Bundle contains browser tokens by design (NETLIFY=true or ALLOW_BAKED_BROWSER_TOKENS=1). ' +
            'Ensure tokens are domain- and asset-restricted at the provider.'
        )
        return
      }
      const root = path.resolve(__dirname, outDir)
      const assetsDir = path.join(root, 'assets')
      if (!fs.existsSync(assetsDir)) return
      const jsFiles = fs
        .readdirSync(assetsDir)
        .filter(f => f.endsWith('.js'))
        .map(f => path.join(assetsDir, f))
      const jwtRe = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/
      const pemRe = /-----BEGIN [A-Z ]*PRIVATE KEY-----/
      for (const file of jsFiles) {
        const txt = fs.readFileSync(file, 'utf8')
        const jwt = jwtRe.exec(txt)
        if (jwt != null) {
          throw new Error(
            `\n[secret-guard] JWT-shaped string found in ${path.relative(root, file)}: ${jwt[0].slice(0, 24)}…\n` +
              `Vite inlined a token from import.meta.env at BUILD TIME.\n` +
              `Local builds must not embed secrets — run the build on Netlify, ` +
              `or set ALLOW_BAKED_BROWSER_TOKENS=1 only if this token is provider-restricted.\n` +
              `Build aborted.`
          )
        }
        if (pemRe.test(txt)) {
          throw new Error(
            `[secret-guard] PEM private-key block found in ${path.relative(root, file)}. Build aborted.`
          )
        }
      }
    }
  }
}

export default defineConfig({
  root: __dirname,
  // Env source-of-truth depends on who's driving the build:
  //   - Local dev (`npm run dev:globe-waterpro`): read root .env so terrain
  //     loads on localhost without copy-pasting tokens into a demo-local file.
  //   - Netlify build (NETLIFY=true, set automatically on their build runners
  //     AND by `netlify deploy --build`): IGNORE root .env entirely; tokens
  //     come ONLY from process.env (populated by Netlify UI env vars). This
  //     prevents a developer's full-permission dev token from getting inlined
  //     into a public deploy.
  envDir: process.env.NETLIFY === 'true' ? __dirname : repoRoot,
  envPrefix: ['VITE_', 'STORYBOOK_'],
  publicDir: false,
  plugins: [
    react(),
    ifftWorkerHardeningPlugin(),
    staticDirsPlugin(),
    metDevProxyPlugin(),
    aisDevProxyPlugin(),
    secretGuardPlugin()
  ],
  // Bundled workers ship as ES modules — required by ocean-builder-threaded.js's
  // `new Worker(url, { type: 'module' })`. Default is 'iife', which would emit a
  // classic worker that the type:module call wouldn't load correctly.
  // The ifftWorkerHardening plugin must also run in the worker sub-build to
  // inject the onmessage try-catch wrapper into the worker source file.
  worker: {
    format: 'es',
    plugins: () => [ifftWorkerHardeningPlugin()]
  },
  resolve: {
    alias: {
      '@three-geospatial/ocean-ifft/components': path.resolve(
        repoRoot,
        'packages/ocean-ifft/components'
      ),
      '@three-geospatial/ocean-ifft/resources': path.resolve(
        repoRoot,
        'packages/ocean-ifft/resources'
      ),
      '@three-geospatial/ocean-ifft': path.resolve(
        repoRoot,
        'packages/ocean-ifft/src/index.ts'
      ),
      '@takram/three-atmosphere/webgpu': path.resolve(
        repoRoot,
        'packages/atmosphere/src/webgpu'
      ),
      '@takram/three-atmosphere': path.resolve(
        repoRoot,
        'packages/atmosphere/src'
      ),
      '@takram/three-geospatial/webgpu': path.resolve(
        repoRoot,
        'packages/core/src/webgpu'
      ),
      '@takram/three-geospatial': path.resolve(repoRoot, 'packages/core/src')
    }
  },
  server: {
    fs: {
      allow: [repoRoot]
    }
  },
  build: {
    sourcemap: false,
    target: 'esnext'
  }
})
