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
# The code review's lint step runs the lockfile's oxlint, never one from the repository it reviews.
RUN printf '#!/bin/sh\nexec bun /app/node_modules/oxlint/bin/oxlint "$@"\n' > /usr/local/bin/oxlint && chmod +x /usr/local/bin/oxlint
# The image's unprivileged user owns /data, so the volume Docker creates there inherits it.
RUN mkdir /data && chown bun:bun /data
USER bun
WORKDIR /app/vendor/interchange
CMD ["bun", "--conditions=intx-src", "apps/sidecar/src/index.ts"]

FROM base
RUN bun run --cwd apps/web build
ENV PORTAL_DIR=/app/apps/web/dist
EXPOSE 3000
CMD ["bun", "--conditions=intx-src", "apps/hub/src/server.ts"]
