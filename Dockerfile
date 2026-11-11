# syntax=docker/dockerfile:1
# Browser reference player: builds the patched dash.js bundle, then runs `npm run serve:browser`.
#
#   docker build -t sfv-browser .
#   docker run --rm -p 8080:8080 sfv-browser
#   docker run --rm -p 8080:8080 -e SFV_BASE_PATH=/sfv sfv-browser

ARG NODE_VERSION=22

# --- Stage 1: patched dash.js bundle -------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS dashjs
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*
ARG DASHJS_COMMIT=b1bde9f45f35e4565eaeb1ea4dfd6a5f8fd44bdb
WORKDIR /build
RUN git init -q dash.js \
  && git -C dash.js remote add origin https://github.com/Dash-Industry-Forum/dash.js.git \
  && git -C dash.js fetch -q --depth 1 origin "${DASHJS_COMMIT}" \
  && git -C dash.js checkout -q --detach FETCH_HEAD
# The SFV patch does not touch dash.js package files, so dependencies stay cached across patch edits.
RUN cd dash.js && npm ci --no-audit --no-fund
COPY scripts/prepare-dashjs.mjs sfv/scripts/
COPY patches/ sfv/patches/
RUN node sfv/scripts/prepare-dashjs.mjs dash.js --apply \
  && node sfv/scripts/prepare-dashjs.mjs dash.js --verify-installed
RUN cd dash.js && npm run webpack-build-modern
# Writes sfv/web/vendor/: bundle, dash.js licenses and dashjs-build.json.
RUN node sfv/scripts/prepare-dashjs.mjs dash.js --install-bundle

# --- Stage 2: web server -------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim
ENV NODE_ENV=production \
  SFV_HOST=0.0.0.0 \
  PORT=8080
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
# Only what web/app.mjs serves or imports.
COPY src/ src/
COPY scripts/network/ scripts/network/
COPY fixtures/dash/ fixtures/dash/
COPY web/ web/
COPY --from=dashjs /build/sfv/web/vendor/ web/vendor/
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["node", "--input-type=module", "-e", "import { normalizeBasePath } from '/app/web/app.mjs'; const r = await fetch(`http://127.0.0.1:${process.env.PORT}${normalizeBasePath(process.env.SFV_BASE_PATH)}/__sfv/clock`); process.exit(r.ok ? 0 : 1);"]
CMD ["npm", "run", "serve:browser"]
