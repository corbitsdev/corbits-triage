FROM oven/bun:1.4
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
