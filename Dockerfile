FROM oven/bun:1.4.2 AS base
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
RUN bun tooling/install-oxlint.ts /usr/local/bin/oxlint

FROM base AS portal
RUN bun run --cwd apps/web build

# Only the dependencies the hub and its sidecars load. Hoisted, because vendored Interchange imports dependencies its
# manifests list as dev-only (arktype in workflow-deploy, @intx/mime in inference) and its db package runs the hub's
# drizzle-kit for migrations; an isolated install leaves those unresolved.
FROM oven/bun:1.4.2 AS runtime
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile --production --linker hoisted --filter @corbits/hub --filter @intx/sidecar-app

# What the hub and its sidecars both run: Interchange, the workspace packages, the hub's adapter modules and the code
# review's linter.
FROM oven/bun:1.4.2 AS app
LABEL org.opencontainers.image.source=https://github.com/corbitsdev/corbits-triage
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=runtime /app/package.json /app/tsconfig.json ./
COPY --from=runtime /app/node_modules node_modules
COPY --from=runtime /app/vendor vendor
COPY --from=runtime /app/packages packages
COPY --from=runtime /app/apps/hub apps/hub
COPY --from=base /usr/local/bin/oxlint /usr/local/bin/oxlint

# One container per sidecar; the hub's Docker provisioner starts it with the sidecar's env.
FROM app AS sidecar
# The image's unprivileged user owns /data, so the volume Docker creates there inherits it.
RUN mkdir /data && chown bun:bun /data
USER bun
WORKDIR /app/vendor/interchange
CMD ["bun", "--conditions=intx-src", "apps/sidecar/src/index.ts"]

# The hub runs local sidecars in this container, so it needs the code review's linter too.
FROM app
COPY --from=portal /app/apps/web/dist apps/web/dist
RUN /usr/local/bin/oxlint --version
# The published sidecar image, pinned by digest, that CI pushed just before; unset, the hub runs a locally built one.
ARG SIDECAR_IMAGE
RUN if [ -n "$SIDECAR_IMAGE" ]; then echo "$SIDECAR_IMAGE" > apps/hub/sidecar-image; fi
ENV PORTAL_DIR=/app/apps/web/dist
EXPOSE 3000
CMD ["bun", "--conditions=intx-src", "apps/hub/src/server.ts"]
