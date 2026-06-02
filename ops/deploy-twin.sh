#!/usr/bin/env bash
# Manual deploy for twin.humatopia.ai. Ships the current git HEAD to the
# mediaserver build host, builds the amd64 image on the persistent buildx
# builder, pushes to GHCR, then pulls + recreates the huma-twin container.
# Browser tokens are read from the operator's env (never committed) and passed
# as build-args. Mirrors humatopia-frontend/ops (HomeServerTarget), bash port.

set -euo pipefail

SSH_HOST="${TWIN_SSH_HOST:-100.81.225.107}"
SSH_USER="${TWIN_SSH_USER:-steffen}"
DEPLOY_USER="${TWIN_DEPLOY_USER:-huma-deploy}"
IMAGE_BASE="${TWIN_IMAGE_BASE:-ghcr.io/huma-energy/humatopia-twin}"
BUILD_DIR="${TWIN_BUILD_DIR:-/home/${SSH_USER}/twin-build}"
COMPOSE_DIR="${TWIN_COMPOSE_DIR:-/opt/huma-twin}"
HEALTH_PORT="${TWIN_HEALTH_PORT:-13002}"
REF="${1:-HEAD}"

: "${TWIN_ION_TOKEN:?set TWIN_ION_TOKEN to the Cesium Ion token restricted to twin.humatopia.ai/*}"
: "${TWIN_GMAPS_KEY:?set TWIN_GMAPS_KEY to the Google Maps key restricted to twin.humatopia.ai/*}"

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
docker buildx build --builder huma-builder --platform linux/amd64 --push \
  --build-arg STORYBOOK_ION_API_TOKEN='${TWIN_ION_TOKEN}' \
  --build-arg STORYBOOK_GOOGLE_MAP_API_KEY='${TWIN_GMAPS_KEY}' \
  -f Dockerfile ${TAG_FLAGS} .
EOF

echo "→ pulling + recreating huma-twin"
ssh "${SSH_USER}@${SSH_HOST}" sudo -u "${DEPLOY_USER}" bash <<EOF
set -euo pipefail
cd ${COMPOSE_DIR}
TWIN_IMAGE=${IMAGE_BASE}:sha-${SHORT_SHA} docker compose -f docker-compose.twin.yml pull
TWIN_IMAGE=${IMAGE_BASE}:sha-${SHORT_SHA} docker compose -f docker-compose.twin.yml up -d --force-recreate
EOF

echo "→ waiting for health on :${HEALTH_PORT}"
for i in $(seq 1 20); do
  if ssh "${SSH_USER}@${SSH_HOST}" curl -sf "http://127.0.0.1:${HEALTH_PORT}/health" >/dev/null; then
    echo "✓ deployed ${IMAGE_BASE}:sha-${SHORT_SHA} — healthy"
    exit 0
  fi
  sleep 3
done
echo "✗ health check timed out after 60s" >&2
exit 1
