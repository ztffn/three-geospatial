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
# 3.
ssh-add ~/.ssh/huma-ovh-vps && pnpm deploy:twin
```

The script (`ops/deploy-twin.sh`) does: archive HEAD → ssh to the VPS → buildx
`--load` (LOCAL image — the VPS has GHCR **pull-only**; `--push` fails) →
compose recreate → `/health` poll → **pins the sha in `/opt/huma-twin/.env`**
(reboot-safe). Build takes 5–10 min (8 GB RAM + swap; pnpm install dominates).

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
   Any new GLB/texture/font referenced at runtime MUST be added there.
3. **Stale browser `index.html` → black screen + 404 on old bundle.** Fixed
   server-side (`index.html` is `no-cache`, hashed assets immutable) — but any
   tab loaded BEFORE that fix needs one hard reload.
4. **Shell env does not persist between agent Bash calls** — export tokens and
   run the deploy in ONE command.
5. Cloudflare caps asset `cache-control` at its zone Browser-TTL (4 h) —
   harmless; hashed filenames make staleness impossible.

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
