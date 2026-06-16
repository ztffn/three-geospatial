#!/usr/bin/env bash
# Manual deploy for twin.humatopia.ai. Ships the current git HEAD to the
# mediaserver build host, builds the amd64 image on the persistent buildx
# builder, pushes to GHCR, then pulls + recreates the huma-twin container.
# Browser tokens are read from the operator's env (never committed) and passed
# as build-args. Mirrors humatopia-frontend/ops (HomeServerTarget), bash port.

set -euo pipefail

SSH_HOST="${TWIN_SSH_HOST:-51.255.201.253}"  # OVH VPS (mediaserver died 2026-06; see huma-infra/runbooks/HOSTS.md)
SSH_USER="${TWIN_SSH_USER:-ubuntu}"  # key: ~/.ssh/huma-ovh-vps
DEPLOY_USER="${TWIN_DEPLOY_USER:-ubuntu}"  # no huma-deploy user on the VPS
IMAGE_BASE="${TWIN_IMAGE_BASE:-humatopia-twin}"  # local image; VPS has GHCR pull-only
BUILD_DIR="${TWIN_BUILD_DIR:-/home/${SSH_USER}/twin-build}"
COMPOSE_DIR="${TWIN_COMPOSE_DIR:-/opt/huma-twin}"
HEALTH_PORT="${TWIN_HEALTH_PORT:-13002}"
REF="${1:-HEAD}"

: "${TWIN_ION_TOKEN:?set TWIN_ION_TOKEN to the Cesium Ion token restricted to twin.humatopia.ai/*}"
: "${TWIN_GMAPS_KEY:?set TWIN_GMAPS_KEY to the Google Maps key restricted to twin.humatopia.ai/*}"

# Optional BarentsWatch AIS client credentials for the live shadow-fleet layer.
# Absent → the AIS proxy 503s "credentials missing" and markers stay empty
# (graceful, never fabricated). Export them from the repo .env like the tokens.
# Unlike the browser tokens these are NOT build-args — the server reads
# process.env at request time, so they are shipped to the container RUNTIME env
# (the .env beside docker-compose.twin.yml on the VPS), not baked into the bundle.
BARENTSWATCH_CLIENT_ID="${BARENTSWATCH_CLIENT_ID:-}"
BARENTSWATCH_CLIENT_SECRET="${BARENTSWATCH_CLIENT_SECRET:-}"

SHORT_SHA="$(git rev-parse --short "$REF")"
DATE_STR="$(date -u +%Y%m%d)"
TAGS=(
  "${IMAGE_BASE}:sha-${SHORT_SHA}"
  "${IMAGE_BASE}:prod-${DATE_STR}"
  "${IMAGE_BASE}:latest"
)
TAG_FLAGS=""
for t in "${TAGS[@]}"; do TAG_FLAGS+=" -t ${t}"; done

echo "→ shipping ${REF} (${SHORT_SHA}) to ${SSH_USER}@${SSH_HOST}:${BUILD_DIR}"
git archive "$REF" | ssh "${SSH_USER}@${SSH_HOST}" \
  "rm -rf ${BUILD_DIR} && mkdir -p ${BUILD_DIR} && tar xf - -C ${BUILD_DIR}"

echo "→ building + pushing amd64 image (tokens via build-arg, not committed)"
# Persistent builder; bootstrap once if missing:
#   docker buildx create --name huma-builder --driver docker-container --bootstrap --use
ssh "${SSH_USER}@${SSH_HOST}" bash <<EOF
set -euo pipefail
cd ${BUILD_DIR}
docker buildx build --builder huma-builder --platform linux/amd64 --load \
  --build-arg STORYBOOK_ION_API_TOKEN='${TWIN_ION_TOKEN}' \
  --build-arg STORYBOOK_GOOGLE_MAP_API_KEY='${TWIN_GMAPS_KEY}' \
  -f Dockerfile ${TAG_FLAGS} .
EOF

echo "→ writing runtime env (image pin + AIS creds) and recreating huma-twin"
# The container reads its runtime config from ${COMPOSE_DIR}/.env (docker compose
# variable substitution). Write it WHOLE each deploy — the image pin plus the
# optional BarentsWatch creds — so the recreate AND any future bare compose-up /
# reboot use the same config; this is what makes the live AIS layer survive
# deploys (the old pin wrote only TWIN_IMAGE and clobbered the creds). The inner
# heredoc is quoted ('ENVEOF') so secret bytes are written literally with no
# shell re-parsing; values are interpolated into the SSH stream (never command
# args), and the file is chmod 600.
ssh "${SSH_USER}@${SSH_HOST}" sudo bash <<EOF
set -euo pipefail
# Sync the compose file from the shipped archive so the VPS copy can't drift from
# the repo. A stale copy (missing the BARENTSWATCH env entries) silently dropped
# the live AIS layer regardless of .env — the deploy never re-synced it before.
cp ${BUILD_DIR}/ops/docker-compose.twin.yml ${COMPOSE_DIR}/docker-compose.twin.yml
cd ${COMPOSE_DIR}
cat > .env <<'ENVEOF'
TWIN_IMAGE=${IMAGE_BASE}:sha-${SHORT_SHA}
BARENTSWATCH_CLIENT_ID=${BARENTSWATCH_CLIENT_ID}
BARENTSWATCH_CLIENT_SECRET=${BARENTSWATCH_CLIENT_SECRET}
ENVEOF
chmod 600 .env
docker compose -f docker-compose.twin.yml up -d --force-recreate
EOF

echo "→ waiting for health on :${HEALTH_PORT}"
for i in $(seq 1 20); do
  if ssh "${SSH_USER}@${SSH_HOST}" curl -sf "http://127.0.0.1:${HEALTH_PORT}/health" >/dev/null; then
    echo "✓ deployed ${IMAGE_BASE}:sha-${SHORT_SHA} — healthy; runtime env pinned in ${COMPOSE_DIR}/.env"
    exit 0
  fi
  sleep 3
done
echo "✗ health check timed out after 60s" >&2
exit 1
