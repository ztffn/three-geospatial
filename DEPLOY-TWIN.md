<!--
DEPLOY-TWIN.md — operator runbook for shipping the digital twin to
twin.humatopia.ai on the Humatopia self-hosted infra (mediaserver + Cloudflare
Tunnel), mirroring the humatopia-frontend home-server pattern. Covers the
one-time setup, the per-release deploy, and the rollback path.
-->

# Deploying the Digital Twin → `twin.humatopia.ai`

The deployed artifact is the standalone Vite SPA at
`examples/ocean-globe-waterpro-demo/` (atmosphere + 3D Tiles terrain + WaterPro
ocean + turbine farm + the `DigitalTwinUI` HUD). It is served by a tiny Node
server (`examples/ocean-globe-waterpro-demo/server/index.ts`) that also answers
the same-origin MET proxy at `/.netlify/functions/met` — replacing the Netlify
Function used on Netlify, with **no secret** (MET needs only a User-Agent).

## Architecture

```
twin.humatopia.ai
  → Cloudflare Tunnel (cloudflared on mediaserver)
  → 127.0.0.1:13002                 (13000=prod frontend, 13001=dev frontend)
  → Docker container `huma-twin`  →  node server.cjs (sirv static + MET proxy + /health)
```

Build runs **on the mediaserver buildx builder** — never ship a locally-built
`dist/` (a dev token in the root `.env` would be inlined into the public bundle).
Tokens are passed as `--build-arg` and are public-by-design, made safe only by
provider-side domain + asset restriction.

## One-time setup

1. **Browser tokens** (public, but restrict them):
   - Cesium Ion token at https://ion.cesium.com/tokens — referrer
     `https://twin.humatopia.ai/*`, scoped to asset IDs `2275207, 2767062`.
   - Google Maps key — HTTP-referrer restricted to `https://twin.humatopia.ai/*`.
   - Export both in the operator shell (never commit):
     ```bash
     export TWIN_ION_TOKEN='<cesium-ion-token>'
     export TWIN_GMAPS_KEY='<google-maps-key>'
     ```

2. **buildx builder** on the host (if not already present):
   ```bash
   ssh steffen@100.81.225.107 \
     'docker buildx create --name huma-builder --driver docker-container --bootstrap --use'
   ```

3. **Compose dir** on the host:
   ```bash
   ssh steffen@100.81.225.107 'sudo -u huma-deploy mkdir -p /opt/huma-twin'
   scp ops/docker-compose.twin.yml steffen@100.81.225.107:/tmp/docker-compose.twin.yml
   ssh steffen@100.81.225.107 'sudo -u huma-deploy cp /tmp/docker-compose.twin.yml /opt/huma-twin/'
   ```
   (GHCR pull auth: the host must already be `docker login ghcr.io`'d, as for
   humatopia-frontend. The image can be public to skip pull auth.)

4. **Cloudflare** — add the DNS record + Tunnel ingress (Zero Trust → Networks →
   Tunnels → the Humatopia tunnel):
   - Public hostname: `twin.humatopia.ai` → `http://127.0.0.1:13002`
   - This auto-creates the proxied DNS record for `twin`.

## Per-release deploy

From `main` (the deployed ref), with `TWIN_ION_TOKEN` / `TWIN_GMAPS_KEY` exported:

```bash
pnpm deploy:twin            # deploys HEAD
pnpm deploy:twin <git-ref>  # deploys a specific ref
```

The script: `git archive` → host → `docker buildx build --push` (GHCR) →
`docker compose pull && up -d --force-recreate` → polls `:13002/health`.

## Rollback

```bash
ssh steffen@100.81.225.107 sudo -u huma-deploy bash -c \
  'cd /opt/huma-twin && TWIN_IMAGE=ghcr.io/huma-energy/humatopia-twin:sha-<old> \
   docker compose -f docker-compose.twin.yml up -d --force-recreate'
```

## Local verification (no deploy)

```bash
pnpm build:globe-waterpro && pnpm build:twin-server   # needs tokens in root .env
STATIC_DIR=examples/ocean-globe-waterpro-demo/dist \
  node examples/ocean-globe-waterpro-demo/server/dist/server.cjs
# → http://localhost:3000  +  /.netlify/functions/met?lat=59.4&lon=5.2
```
