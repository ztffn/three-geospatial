<!--
DEPLOY-TWIN.md — operator runbook for twin.humatopia.ai on the OVH VPS.
Written to let a fresh session deploy WITHOUT re-living the 2026-06-12
session: it front-loads host facts, token recovery, the exact command, and
every gotcha that actually bit. Read "Deploy in 3 steps" first.
-->

# Deploying the Digital Twin → `twin.humatopia.ai`

> **Host history:** the original mediaserver (100.81.225.107, Tailscale) DIED
> 2026-06 (`nvme0`). Everything runs on the OVH VPS now. If an SSH to a
> `100.x` address times out, you are using dead-host config. Authoritative
> infra facts: `huma/huma-infra/runbooks/HOSTS.md` + `vps-recovery.md`.

## Deploy in 3 steps (verified end-to-end 2026-06-12)

```bash
# 1. COMMIT FIRST — the script ships `git archive HEAD`; working tree changes don't deploy.
# 2. Tokens (browser tokens, public-by-design; never stored in files, never commit):
export TWIN_ION_TOKEN=$(curl -s https://twin.humatopia.ai/$(curl -s https://twin.humatopia.ai/ \
  | grep -o 'assets/index-[^"]*\.js' | head -1) \
  | grep -oE 'eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}' | sort -u | head -1)
export TWIN_GMAPS_KEY=$(grep '^STORYBOOK_GOOGLE_MAP_API_KEY=' .env | cut -d= -f2)
# Optional — live shadow-fleet AIS layer. Omit and markers stay empty (no error);
# WITHOUT these the proxy 503s "BarentsWatch credentials missing". RUNTIME creds
# (not build-args): the script writes them into the container's .env on the VPS.
export BARENTSWATCH_CLIENT_ID=$(grep '^BARENTSWATCH_CLIENT_ID=' .env | cut -d= -f2-)
export BARENTSWATCH_CLIENT_SECRET=$(grep '^BARENTSWATCH_CLIENT_SECRET=' .env | cut -d= -f2-)
# 3.
ssh-add ~/.ssh/huma-ovh-vps && pnpm deploy:twin
```

The script (`ops/deploy-twin.sh`) does: archive HEAD → ssh to the VPS → buildx
`--load` (LOCAL image — the VPS has GHCR **pull-only**; `--push` fails) →
compose recreate → `/health` poll. It **syncs `docker-compose.twin.yml` from the
shipped archive** and **writes `/opt/huma-twin/.env` whole each deploy** — the sha
pin **plus** the BarentsWatch creds (chmod 600) — so the VPS compose can't drift,
reboots keep the image, AND the live AIS layer survives every deploy. Build takes
5–10 min (8 GB RAM + swap; pnpm install dominates).

## Host facts

| Fact | Value |
|---|---|
| SSH | `ssh -i ~/.ssh/huma-ovh-vps ubuntu@51.255.201.253` (sudo NOPASSWD; **no `huma-deploy` user**) |
| Twin | `/opt/huma-twin/docker-compose.twin.yml` → `127.0.0.1:13002`, container `huma-twin` |
| Builder | buildx `huma-builder` (docker-container, linux/amd64) exists on the VPS |
| Tunnel | `humatopia-home` cloudflared (remotely managed) — twin ingress + DNS already exist; **deploys need ZERO Cloudflare changes** |
| CF creds (only if changing ingress) | `humatopia-frontend/.env.local` / `huma-infra/.env.local`; GET-modify-PUT the FULL config — a bad PUT takes down humatopia.ai |

## Token recovery (when env vars are long gone)

Both are browser tokens baked into the public bundle — security is provider-side
restriction, not secrecy. `TWIN_ION_TOKEN`: the single JWT in the live bundle
(payload keys `aud/iat/id/iss/jti`) — extraction one-liner above. `TWIN_GMAPS_KEY`:
`STORYBOOK_GOOGLE_MAP_API_KEY` in root `.env` (it is NOT inlined in the twin
bundle — terrain comes via Ion asset 2275207 — but the script guard requires it).

## Gotchas that actually bit (don't re-learn these)

1. **`VAR=x sudo docker compose …` strips VAR.** Use `sudo VAR=x docker compose …`
   or set it inside the sudo'd shell. Symptom: container recreates "healthy"
   but runs the OLD image — always verify the bundle hash changed (below).
2. **New runtime assets 404 in prod.** Dev sirv serves ALL of
   `storybook-webgpu/assets/`; the production build copies only the explicit
   `staticAssets` list in `examples/ocean-globe-waterpro-demo/vite.config.ts`.
   Any new GLB/texture/font referenced at runtime MUST be added there. Assets too
   big to ship via `git archive` (gitignored/LFS-excluded binaries — e.g. the
   136 MB SPZ splat) can't go through `staticAssets` at all; host them on the
   public R2 bucket instead (see [Large / public runtime assets](#large--public-runtime-assets-r2--too-big-for-gitstaticassets)).
3. **Stale browser `index.html` → black screen + 404 on old bundle.** Fixed
   server-side (`index.html` is `no-cache`, hashed assets immutable) — but any
   tab loaded BEFORE that fix needs one hard reload.
4. **Shell env does not persist between agent Bash calls** — export tokens and
   run the deploy in ONE command.
5. Cloudflare caps asset `cache-control` at its zone Browser-TTL (4 h) —
   harmless; hashed filenames make staleness impossible.
6. **AIS layer 503 "credentials missing" = runtime creds not shipped.** The live
   shadow-fleet layer needs `BARENTSWATCH_CLIENT_ID`/`_SECRET` (real OAuth
   secrets, unlike the public browser tokens) in the operator's repo `.env`.
   These are RUNTIME env, not build-args — the deploy exports them (step 2) and
   writes them into `/opt/huma-twin/.env` (chmod 600). If AIS 503s, your local
   `.env` lacks them. Empty markers are the designed graceful state — never
   fabricated. Two bugs caused this (both fixed 2026-06-16): the old deploy
   pinned only `TWIN_IMAGE` (clobbering the creds), AND it never synced
   `/opt/huma-twin/docker-compose.twin.yml`, so the VPS copy drifted to a version
   missing the `BARENTSWATCH_*` env entries — the container was never told to
   read them, no matter what `.env` held. Tell-tale: `TWIN_IMAGE` interpolates
   but `docker compose config` shows the creds empty. The deploy now re-syncs the
   compose file from the archive every run.

## Large / public runtime assets (R2 — too big for git/staticAssets)

The deploy ships `git archive HEAD`, so gitignored/LFS-excluded binaries never
reach the build — `staticAssets` can't help. Such assets (e.g. the 136 MB
Realtime-Geospatial SPZ splat, `storybook-webgpu/assets/*.spz`, gitignored) are
served from a **public** R2 bucket and referenced by an absolute URL the client
fetches at runtime.

- **Bucket `humatopia-public`** — a public-only Cloudflare R2 bucket, SEPARATE from
  the private `humatopia-prod` (which holds user data and must NEVER be public).
  Served via custom domain **`assets.humatopia.ai`** (Cloudflare edge — the bytes
  never touch the VPS). Bucket CORS allows `https://twin.humatopia.ai` + localhost.
- **No credentials on the twin.** The twin references only the public URL
  (`spzUrl='https://assets.humatopia.ai/<key>'` in `GlobeWaterproOcean-Story.tsx`).
  No presigning, no R2 keys, no proxy route on the VPS — keep it that way; that is
  the whole point of using a public bucket for public showcase data.

Upload a new public asset (S3 creds are account-scoped, in `humatopia-frontend/.env.local`):

```sh
cd ~/Projects/huma/humatopia-frontend
node --env-file=.env.local scripts/r2-asset-ops.mjs upload /abs/file.spz <key> --bucket humatopia-public
```

Then point the client at `https://assets.humatopia.ai/<key>`, commit, redeploy.

Account-level ops (create bucket, bind/enable custom domain, set CORS) need
`CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` from `huma-infra/.env.local` — the
`SOS_*` S3 keys CANNOT toggle public access. Use the CF token transiently in-shell;
never deploy it. **GOTCHA:** binding a custom domain via the API
(`POST .../r2/buckets/{b}/custom_domains`, even with `"enabled":true`) creates it
`enabled:false` → every request 401s ("Unauthorized", `server: cloudflare`). Enable
with `PUT .../r2/buckets/{b}/domains/custom/{domain}` `{"enabled":true}` (NOT
`/custom_domains/{domain}`, which 404s with code 10015); confirm via
`GET .../domains/custom` (it shows the `enabled` field). Verify the asset:

```sh
curl -s -o /dev/null -D - -H "Origin: https://twin.humatopia.ai" -H "Range: bytes=0-0" \
  https://assets.humatopia.ai/<key>   # expect 206 + access-control-allow-origin
```

## Verify (after every deploy)

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://twin.humatopia.ai/health     # 200
curl -s 'https://twin.humatopia.ai/.netlify/functions/met?lat=59.43&lon=5.21' | head -c 80
curl -s https://twin.humatopia.ai/ | grep -o '/assets/index-[^"]*\.js'        # hash CHANGED (if app code changed)
curl -s -o /dev/null -w '%{http_code}\n' https://twin.humatopia.ai/public/ship-demo-compressed.glb  # 200
```

In the browser console expect: `[ready] atmosphere LUTs`, ocean chunks built,
and `[TurbineCables] loaded baked snapshot (no solve)` (cables are pre-baked in
`storybook-webgpu/src/ocean/cable-bake.ts`; live wind only yaws rotors — the
layout, and therefore the snapshot sig, is wind-independent).

## Rollback

```bash
ssh ubuntu@51.255.201.253 "sudo docker images humatopia-twin --format '{{.Tag}}'"   # pick old sha
ssh ubuntu@51.255.201.253 "cd /opt/huma-twin && sudo TWIN_IMAGE=humatopia-twin:sha-<old> \
  docker compose -f docker-compose.twin.yml up -d --force-recreate \
  && echo TWIN_IMAGE=humatopia-twin:sha-<old> | sudo tee .env"
```

## Local verification (no host, no deploy)

```bash
ALLOW_BAKED_BROWSER_TOKENS=1 pnpm build:globe-waterpro   # reads root .env tokens
pnpm build:twin-server
STATIC_DIR=examples/ocean-globe-waterpro-demo/dist \
  node examples/ocean-globe-waterpro-demo/server/dist/server.cjs   # → localhost:3000
```
