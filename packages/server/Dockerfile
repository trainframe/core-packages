# Build a deployable @trainframe/server bundle.
#
# Multi-stage:
#   1. `build` — install workspace deps with pnpm, compile the server, then use
#      `pnpm deploy` to produce a self-contained runtime tree (workspace
#      dependencies are vendored in, no symlinks).
#   2. final  — a thin node:22-alpine image holding only the deploy output.
#
# Run with: `docker run --rm trainframe/tf-server --discovery --broker mqtt://broker:1883`

FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json biome.json tsconfig.base.json ./
COPY packages packages
RUN pnpm install --frozen-lockfile --filter "@trainframe/server..."
RUN pnpm --filter @trainframe/server build \
 && pnpm --filter @trainframe/core build \
 && pnpm --filter @trainframe/protocol build
RUN pnpm deploy --filter @trainframe/server --prod /deploy

FROM node:22-alpine
WORKDIR /app
COPY --from=build /deploy /app
EXPOSE 3000
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["--discovery", "--broker", "mqtt://mosquitto:1883", "--http-port", "3000"]
