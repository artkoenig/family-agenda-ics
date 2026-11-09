# syntax=docker/dockerfile:1
# The ICS Source as a plugin container (ADR-0001 of Family Agenda).
#   docker build --secret id=github_token,env=GITHUB_TOKEN -t family-agenda-ics .
# The secret is a token that can read artkoenig/family-agenda, from which the plugin kit and the
# plugin contract are installed; it is needed only while that repository is private.
FROM node:26-bookworm-slim

ENV NODE_ENV=production
# Node.js has not shipped Corepack since version 25, so it comes from npm. git fetches the kit.
RUN npm install --global corepack@0.36.0 && corepack enable \
  && apt-get update && apt-get install --yes --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Not --prod: the kit takes the plugin contract as a peer, and tsx runs the TypeScript sources.
RUN --mount=type=secret,id=github_token,required=false \
  if [ -s /run/secrets/github_token ]; then \
    git config --global url."https://x-access-token:$(cat /run/secrets/github_token)@github.com/".insteadOf "https://github.com/"; \
  fi \
  && pnpm install --frozen-lockfile \
  && rm -f /root/.gitconfig
COPY src ./src

USER node
ENV PORT=8080
# Every request leaves through the egress proxy that compose.plugins.yaml sets in HTTPS_PROXY.
ENV NODE_USE_ENV_PROXY=1
EXPOSE 8080
CMD ["node", "--import", "tsx", "src/main.ts"]
