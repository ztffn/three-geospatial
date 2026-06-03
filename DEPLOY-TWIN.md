<!--
DEPLOY-TWIN.md — operator runbook for twin.humatopia.ai on the Humatopia
self-hosted infra (mediaserver Docker + Cloudflare Tunnel). Written to let a
fresh session deploy without re-discovering the environment: it front-loads the
host facts, credential locations, and the exact safe Cloudflare-edit procedure.
Read the "Start here" section first; the rest is reference.
-->

# Deploying the Digital Twin → `twin.humatopia.ai`

## Start here (orientation for a new session)

- **Artifact**: the standalone Vite SPA at `examples/ocean-globe-waterpro-demo/`
  (atmosphere + Cesium-Ion 3D-Tiles terrain + WaterPro ocean + turbine farm +
  the `DigitalTwinUI` HUD). NOT the Storybook. Built via `pnpm build:globe-waterpro`.
- **Server**: `examples/ocean-globe-waterpro-demo/server/index.ts` — a tiny Node
  server (`sirv` static + SPA fallback + `/.netlify/functions/met` + `/health`).
  It replaces the Netlify Function; the MET proxy needs **no secret** (only MET's
  mandated User-Agent). Bundled to a single `server.cjs` by `pnpm build:twin-server`.
- **Hosting**: Docker on the `mediaserver` host, fronted by a Cloudflare Tunnel.
  This is the same pattern as `humatopia-frontend` (NOT Netlify, NOT Vercel).
- **Only two secrets exist**, and both are *browser* tokens baked into the bundle
  (Cesium Ion + Google Maps). Safety is provider-side domain/asset restriction,
  never server secrecy. The server itself needs no secrets.

```
twin.humatopia.ai
  → Cloudflare Tunnel (cloudflared --token on mediaserver; REMOTELY-managed, no host config file)
  → 127.0.0.1:13002                 (13000 = prod frontend, 13001 = dev frontend, 13002 = twin)
  → Docker container `huma-twin`  →  node server.cjs
```

## Host facts (verified — don't re-discover these)

| Fact | Value |
|---|---|
| SSH | `ssh steffen@100.81.225.107` (Tailscale; host must be on the tailnet) |
| sudo | steffen has **NO** general passwordless sudo. Only `sudo -n -u huma-deploy …` is NOPASSWD |
| docker | steffen is in the `docker` group → runs docker/compose directly, no sudo |
| `/opt` | root-owned. `/opt/huma-mvp`, `/opt/huma-gateway` are `huma-deploy:huma-deploy`. Creating a new `/opt/huma-twin` needs a **one-time root mkdir** (interactive sudo / the operator) |
| buildx | persistent builder `huma-builder` (docker-container driver, linux/amd64) already exists |
| GHCR | host is `docker login ghcr.io`'d with push rights to the `huma-energy` org |
| image | `ghcr.io/huma-energy/humatopia-twin` (tags `sha-<short>`, `latest`) |
| port | twin uses host loopback `127.0.0.1:13002` (13000/13001 are taken by the frontend; host `:3000` is colanode) |
| build dir | working-tree builds land in `~/twin-build` on the host |

## Cloudflare (the part that bites)

The tunnel is **remotely-managed** (`cloudflared … tunnel run --token`); there is
**no local ingress config file** to edit. Ingress + DNS are changed via the CF API.

- **Credentials live in `humatopia-frontend/.env.local`** (sibling repo):
  `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
  `CLOUDFLARE_TUNNEL_ID_HUMATOPIA_HOME` (tunnel `cf23195e-0bfc-4103-938e-4a9ae7f6eddb`),
  `CLOUDFLARE_ZONE_ID_HUMATOPIA_AI`. `source .env.local` to load them.
- The tunnel **also serves live `humatopia.ai`**. A `PUT …/configurations`
  **replaces the entire ingress set** — so you must GET the full config, modify
  ONLY `.config.ingress`, keep the `{"service":"http_status:404"}` catch-all
  **last**, then PUT the whole thing back. Botching this takes down humatopia.ai.

Safe procedure (already applied once for twin; idempotent):

```bash
cd /Users/steffen/Projects/huma/humatopia-frontend && set -a && source .env.local && set +a
ACC=$CLOUDFLARE_ACCOUNT_ID; TUN=$CLOUDFLARE_TUNNEL_ID_HUMATOPIA_HOME; ZONE=$CLOUDFLARE_ZONE_ID_HUMATOPIA_AI
BASE="https://api.cloudflare.com/client/v4/accounts/$ACC/cfd_tunnel/$TUN/configurations"

# 1. GET + BACK UP the full config first
curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$BASE" > /tmp/twin-cf-backup.json
cfg=$(jq '.result.config' /tmp/twin-cf-backup.json)

# 2. Insert the twin rule before the catch-all (idempotent)
ni=$(echo "$cfg" | jq '(.ingress|map(select(.hostname!="twin.humatopia.ai"))) as $i
      | $i[:-1] + [{"hostname":"twin.humatopia.ai","service":"http://localhost:13002"}] + $i[-1:]')
newcfg=$(echo "$cfg" | jq --argjson ni "$ni" '.ingress=$ni')

# 3. ASSERT before PUT: catch-all last, humatopia.ai present, +1 rule. THEN:
jq -n --argjson c "$newcfg" '{config:$c}' | curl -s -X PUT -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" "$BASE" --data @- | jq '.success'

# 4. DNS (proxied CNAME to the tunnel) — once
curl -s -X POST -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
  "https://api.cloudflare.com/client/v4/zones/$ZONE/dns_records" \
  --data "{\"type\":\"CNAME\",\"name\":\"twin\",\"content\":\"${TUN}.cfargotunnel.com\",\"proxied\":true}" | jq '.success'

# Rollback if needed: PUT {"config": <.result.config from /tmp/twin-cf-backup.json>}
```

After a change, always confirm `humatopia.ai` is still alive:
`curl -s -o /dev/null -w '%{http_code}\n' https://humatopia.ai/` → expect `307` (alive).
`api.humatopia.ai` → `404` is its *designed* root response, not a regression.

## Deploying a release

### A. Full release with tokens (canonical)

Mint NEW browser tokens restricted to `https://twin.humatopia.ai/*` (Cesium Ion
scoped to asset IDs `2275207, 2767062`; Google Maps HTTP-referrer restricted),
then:

```bash
export TWIN_ION_TOKEN='…'  TWIN_GMAPS_KEY='…'      # never commit
pnpm deploy:twin            # archives git HEAD → host buildx → GHCR → compose recreate → /health
```

`ops/deploy-twin.sh` is parameterized via env: `TWIN_COMPOSE_DIR`
(default `/opt/huma-twin`), `TWIN_DEPLOY_USER` (default `huma-deploy`),
`TWIN_IMAGE_BASE`, `TWIN_HEALTH_PORT`. It **requires** the two tokens (guard);
it ships `git archive HEAD`, so **commit first** or your changes won't deploy.

### B. Token-less promotion (no terrain/tiles, infra-only)

The script's token guard blocks this, so do it manually. Build is identical
(`NETLIFY=true` ⇒ Vite sources tokens only from build-args; with none passed the
bundle is token-less and the `secret-guard` plugin still passes). Terrain +
Google tiles render blank; ocean/atmosphere/turbines/HUD/MET all work.

```bash
# ship the working tree (or git archive a ref) to the host, then on the host:
cd ~/twin-build && docker build -t humatopia-twin:test .          # token-less
docker tag humatopia-twin:test ghcr.io/huma-energy/humatopia-twin:latest
docker push ghcr.io/huma-energy/humatopia-twin:latest
# compose-managed run (steffen-owned dir avoids the /opt root mkdir):
mkdir -p ~/huma-twin && cp <repo>/ops/docker-compose.twin.yml ~/huma-twin/
docker rm -f huma-twin-test 2>/dev/null                            # free :13002
cd ~/huma-twin && TWIN_IMAGE=ghcr.io/huma-energy/humatopia-twin:latest \
  docker compose -f docker-compose.twin.yml up -d
```

To use the canonical `/opt/huma-twin` + `huma-deploy` location instead, an
operator first runs (interactive sudo, once):
`sudo mkdir -p /opt/huma-twin && sudo chown huma-deploy:huma-deploy /opt/huma-twin`.

## Verify (public)

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://twin.humatopia.ai/health   # 200
curl -s 'https://twin.humatopia.ai/.netlify/functions/met?lat=59.43&lon=5.21' | jq '.series|length'
```
Gotcha: your **local** resolver may negative-cache `twin` as NXDOMAIN for a few
minutes after the DNS is created. Verify via `dig @1.1.1.1 twin.humatopia.ai` or
`curl --resolve twin.humatopia.ai:443:104.21.22.186 …` instead of waiting.

## Local verification (no host, no deploy)

```bash
ALLOW_BAKED_BROWSER_TOKENS=1 pnpm build:globe-waterpro   # reads root .env tokens
pnpm build:twin-server
STATIC_DIR=examples/ocean-globe-waterpro-demo/dist \
  node examples/ocean-globe-waterpro-demo/server/dist/server.cjs   # → localhost:3000
```

## Rollback

```bash
cd ~/huma-twin   # or /opt/huma-twin
TWIN_IMAGE=ghcr.io/huma-energy/humatopia-twin:sha-<old> \
  docker compose -f docker-compose.twin.yml up -d --force-recreate
```
