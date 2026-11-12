# Claude Board for a Linux server (the VPS): the board server, its built UI and the cb CLI.
# Node 24 runs the .ts files as they are; nothing is compiled but the UI. Multi-arch (amd64 and arm64).
# Build and run it with deploy/compose.yml, not by hand: that adds Postgres, the env and the ports. docs/ops/deploy.md.

FROM node:24-slim AS web
WORKDIR /app/web
RUN npm install -g pnpm@10.33.0
COPY web/package.json web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY web/ ./
RUN pnpm build

FROM node:24-slim
# gh: the GitHub watch (#1207) calls `gh api`, authenticated by GH_TOKEN from the environment (no gh login in the image)
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@10.33.0
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY bin ./bin
COPY cli ./cli
COPY db ./db
COPY server ./server
COPY prompts ./prompts
COPY hooks ./hooks
COPY --from=web /app/web/dist ./web/dist
# `cb` inside the container: docker compose exec board cb ... (a wrapper, not a symlink: bin/cb finds the repo from $0)
RUN printf '#!/bin/sh\nexec node /app/cli/cb.ts "$@"\n' > /usr/local/bin/cb && chmod +x /usr/local/bin/cb
# HOST 0.0.0.0 inside the container (compose publishes it on the VPS's loopback only); CB_TRUST_LOCAL=0: everyone signs in
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4747 CB_TRUST_LOCAL=0
EXPOSE 4747
USER node
# The schema is applied on every start (idempotent), then the server runs: an upgrade is build + up.
CMD ["sh", "-c", "node db/setup.ts && exec node server/main.ts"]
