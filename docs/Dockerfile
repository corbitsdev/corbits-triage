FROM oven/bun:1
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile && bun run --cwd apps/web build
ENV PORTAL_DIR=/app/apps/web/dist
EXPOSE 3000
CMD ["bun", "--conditions=intx-src", "apps/hub/src/server.ts"]
