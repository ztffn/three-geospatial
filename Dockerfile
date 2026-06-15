# Multi-stage build for the self-hosted "Humatopia World Twin" (twin.humatopia.ai).
# Stage 1 (Node + pnpm 9, matching netlify.toml): install the workspace, build
# the standalone Vite SPA (examples/ocean-globe-waterpro-demo) with NETLIFY=true
# so browser tokens come only from build-args, and esbuild-bundle the production
# server. Stage 2 ships just the static bundle + a tiny Node server.

# Debian-slim (glibc), NOT alpine: matches the validated Netlify build
# environment and avoids musl prebuilt-binary gaps for native deps in the
# workspace install (sharp, @swc/core, esbuild). Image size is irrelevant for a
# single static-serving container.

# -----------------------------------------------------------------------------
# Stage 1: build
# -----------------------------------------------------------------------------
# Build natively on the host arch; the dist/ output and the bundled server.cjs
# are arch-neutral JS, so the cross-arch copy into the amd64 runtime is safe.
FROM --platform=$BUILDPLATFORM node:22-slim AS build
WORKDIR /app

# pnpm 9 to match the validated Netlify build (netlify.toml PNPM_VERSION=9).
RUN npm install -g pnpm@9

# Browser tokens (Cesium Ion / Google Maps). PUBLIC by design — Vite inlines
# them into the client bundle at build time; the ONLY safety is provider-side
# domain + asset restriction to https://twin.humatopia.ai/*. NETLIFY=true reuses
# the validated Netlify code path: vite.config envDir ignores any stray root
# .env (tokens come only from these ENVs) and the secret-guard permits the
# expected baked browser token instead of aborting the build.
ARG STORYBOOK_ION_API_TOKEN
ARG STORYBOOK_GOOGLE_MAP_API_KEY
ENV NETLIFY=true \
    STORYBOOK_ION_API_TOKEN=${STORYBOOK_ION_API_TOKEN} \
    STORYBOOK_GOOGLE_MAP_API_KEY=${STORYBOOK_GOOGLE_MAP_API_KEY}

# Full workspace copy (matches Netlify's "install from root" reality). .env and
# node_modules are excluded via .dockerignore so no dev token leaks into the image.
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build:globe-waterpro \
 && pnpm build:twin-server

# -----------------------------------------------------------------------------
# Stage 2: runtime
# -----------------------------------------------------------------------------
# Pinned to linux/amd64 to match the mediaserver host. Ships only the static
# SPA bundle and the single-file server — no node_modules (sirv + _met-core are
# inlined into server.cjs by esbuild).
FROM --platform=linux/amd64 node:22-slim AS runtime
WORKDIR /app
RUN groupadd -r app && useradd -r -g app app

COPY --from=build --chown=app:app /app/examples/ocean-globe-waterpro-demo/dist ./dist
COPY --from=build --chown=app:app /app/examples/ocean-globe-waterpro-demo/server/dist/server.cjs ./server.cjs

USER app
EXPOSE 3000
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    STATIC_DIR=/app/dist
CMD ["node", "server.cjs"]
