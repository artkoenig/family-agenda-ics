# syntax=docker/dockerfile:1
# The ICS Source as a plugin container (ADR-0001 of Family Agenda).
#   docker build --secret id=github_token,env=GITHUB_TOKEN -t family-agenda-ics .
# The secret is a token that can read artkoenig/family-agenda, from which the plugin kit and the
# plugin contract are installed; it is needed only while that repository is private. It lives in
# one RUN's environment of the build stage, never in a file, layer or the runtime image.
FROM node:26-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68 AS build

# Node.js has not shipped Corepack since version 25, so it comes from npm. git fetches the kit.
RUN npm install --global corepack@0.36.0 && corepack enable \
  && apt-get update && apt-get install --yes --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Production dependencies only (tsx runs the TypeScript sources): no vitest, no typescript.
RUN --mount=type=secret,id=github_token,required=false \
  if [ -s /run/secrets/github_token ]; then \
    export GIT_CONFIG_COUNT=1 \
      GIT_CONFIG_KEY_0="url.https://x-access-token:$(cat /run/secrets/github_token)@github.com/.insteadOf" \
      GIT_CONFIG_VALUE_0="https://github.com/"; \
  fi \
  && pnpm install --frozen-lockfile --prod --store-dir /tmp/store \
  && rm -rf /tmp/store

FROM node:26-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

USER node
ENV PORT=8080
# Every request leaves through the egress proxy that compose.plugins.yaml sets in HTTPS_PROXY.
ENV NODE_USE_ENV_PROXY=1
EXPOSE 8080
CMD ["node", "--import", "tsx", "src/main.ts"]
