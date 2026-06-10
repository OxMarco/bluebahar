ARG NODE_IMAGE=node:lts-bookworm-slim

FROM ${NODE_IMAGE} AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
COPY views ./views
COPY public ./public
RUN npm run build

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Deploy identifier baked into the image so the running app self-reports the
# exact commit it was built from. MUST match the release passed to
# `npm run sentry:sourcemaps` (both are $(git rev-parse HEAD) in CI) or Sentry
# can't resolve uploaded source maps. Empty for plain `docker build` — Sentry
# then groups events under "no release", which is harmless in dev.
ARG SENTRY_RELEASE=""
ENV SENTRY_RELEASE=${SENTRY_RELEASE}
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/views ./views
COPY --from=builder --chown=node:node /app/public ./public
COPY --chown=node:node data ./data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://localhost:3000/v1/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
