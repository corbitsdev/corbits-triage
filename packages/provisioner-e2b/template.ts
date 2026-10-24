// Builds the sidecar template through E2B from the repository, as docs/provisioners/e2b.md says, with E2B_API_KEY set.
// E2B builds single-stage Dockerfiles only, so this is the root Dockerfile's base stage, which holds all the sidecar stage
// does, oxlint for the code review's lint step included.
import path from "node:path";
import { Template, defaultBuildLogger } from "e2b";
import { E2B_SIDECAR_TEMPLATE } from "./src/index.js";

const SIDECAR_STAGE = `FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
RUN bun tooling/install-oxlint.ts /usr/local/bin/oxlint
WORKDIR /app/vendor/interchange`;

const template = Template({ fileContextPath: path.resolve(import.meta.dir, "../..") }).fromDockerfile(SIDECAR_STAGE);
await Template.build(template, E2B_SIDECAR_TEMPLATE, { cpuCount: 2, memoryMB: 2048, onBuildLogs: defaultBuildLogger() });
