FROM oven/bun:1.4.2 AS base
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile

# One container per sidecar; the hub's Docker provisioner starts it with the sidecar's env.
# It holds what a sidecar loads: Interchange, the workspace packages and the hub's adapter modules.
FROM oven/bun:1.4.2 AS sidecar
WORKDIR /app
COPY --from=base /app/package.json /app/tsconfig.json ./
COPY --from=base /app/node_modules node_modules
COPY --from=base /app/vendor vendor
COPY --from=base /app/packages packages
COPY --from=base /app/apps/hub apps/hub
WORKDIR /app/vendor/interchange
CMD ["bun", "--conditions=intx-src", "apps/sidecar/src/index.ts"]

FROM base
RUN bun run --cwd apps/web build
ENV PORTAL_DIR=/app/apps/web/dist
EXPOSE 3000
CMD ["bun", "--conditions=intx-src", "apps/hub/src/server.ts"]
