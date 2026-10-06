FROM oven/bun:1 AS base
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile

FROM base AS web-build
ARG VITE_HUB_URL
ENV VITE_HUB_URL=$VITE_HUB_URL
RUN bun run --cwd apps/web build

FROM caddy:2 AS web
COPY docs/Caddyfile /etc/caddy/Caddyfile
COPY --from=web-build /app/apps/web/dist /srv
EXPOSE 8080

FROM base AS hub
EXPOSE 3000
CMD ["bun", "--conditions=intx-src", "apps/hub/src/server.ts"]
