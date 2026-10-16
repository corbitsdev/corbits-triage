FROM oven/bun:1.4 AS base
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile

# One container per sidecar allocation; the hub's Docker driver starts it with the sidecar's env.
FROM base AS sidecar
# The driver mounts a volume here and runs the sidecar as `bun`; a new volume takes this owner.
RUN mkdir -p /var/lib/intx-sidecar && chown bun:bun /var/lib/intx-sidecar
WORKDIR /app/vendor/interchange
CMD ["bun", "--conditions=intx-src", "apps/sidecar/src/index.ts"]

FROM base
RUN bun run --cwd apps/web build
ENV PORTAL_DIR=/app/apps/web/dist
EXPOSE 3000
CMD ["bun", "--conditions=intx-src", "apps/hub/src/server.ts"]
