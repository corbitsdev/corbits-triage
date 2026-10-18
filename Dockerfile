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

# The sidecar as a QEMU microVM's root disk; packages/provisioner-qemu/host/install.sh turns it into ext4.
FROM sidecar AS sidecar-vm
RUN apt-get update && apt-get install -y --no-install-recommends iproute2 ca-certificates && rm -rf /var/lib/apt/lists/* && mkdir /data
COPY packages/provisioner-qemu/host/init /sbin/corbits-init

FROM base
RUN bun run --cwd apps/web build
ENV PORTAL_DIR=/app/apps/web/dist
EXPOSE 3000
CMD ["bun", "--conditions=intx-src", "apps/hub/src/server.ts"]
