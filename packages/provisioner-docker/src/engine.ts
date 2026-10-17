import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { type } from "arktype";

const REQUEST_TIMEOUT_MS = 30_000;

const DockerConfig = type({ "currentContext?": "string" });
const ContextMeta = type({ Endpoints: { docker: { Host: "string" } } });

export class DockerEngineError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export type DockerRequestOpts = {
  readonly body?: unknown;
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number;
};

export type DockerEngine = {
  /** The daemon address, as `DOCKER_HOST` writes it. */
  readonly host: string;
  request(method: string, path: string, opts?: DockerRequestOpts): Promise<unknown>;
};

/** A client for the Docker Engine API at `unix:///path` or `tcp://host:port`; throws for any other address. */
export function connectDocker(host: string): DockerEngine {
  const address = new URL(host);
  if (address.protocol !== "unix:" && address.protocol !== "tcp:") {
    throw new Error(`Docker host ${host} must be unix:// or tcp://`);
  }
  const base = address.protocol === "unix:" ? "http://docker" : `http://${address.host}`;
  const transport = address.protocol === "unix:" ? { unix: address.pathname } : {};

  return {
    host,
    async request(method, path, { body, signal, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
      const timeout = AbortSignal.timeout(timeoutMs);
      const response = await fetch(`${base}${path}`, {
        method,
        ...transport,
        signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
        ...(body !== undefined && { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      });
      const text = await response.text();
      if (!response.ok) {
        throw new DockerEngineError(response.status, `Docker ${method} ${path.split("?")[0]} failed (${String(response.status)}): ${text}`);
      }
      return text === "" || text === "OK" ? null : JSON.parse(text);
    },
  };
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.stat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** The docker CLI's context, `DOCKER_CONTEXT` first; undefined for its `default` context. */
async function contextName(home: string, dockerContext: string | undefined): Promise<string | undefined> {
  if (dockerContext !== undefined) return dockerContext;
  const config = path.join(home, ".docker/config.json");
  if (!(await exists(config))) return undefined;
  return DockerConfig.assert(JSON.parse(await fs.readFile(config, "utf8"))).currentContext;
}

async function contextHost(home: string, dockerContext: string | undefined): Promise<string | undefined> {
  const name = await contextName(home, dockerContext);
  if (name === undefined || name === "default") return undefined;
  const meta = path.join(home, ".docker/contexts/meta", createHash("sha256").update(name).digest("hex"), "meta.json");
  return ContextMeta.assert(JSON.parse(await fs.readFile(meta, "utf8"))).Endpoints.docker.Host;
}

export type FindDockerHostOpts = {
  readonly dockerHost?: string;
  readonly dockerContext?: string;
  readonly home: string;
};

/**
 * Where the docker CLI would connect: `DOCKER_HOST`, else the context `DOCKER_CONTEXT` or its config names, else the
 * first well-known socket that exists. Throws when the docker CLI's config or a named context cannot be read.
 */
export async function findDockerHost({ dockerHost, dockerContext, home }: FindDockerHostOpts): Promise<string | undefined> {
  if (dockerHost !== undefined) return dockerHost;
  const fromContext = await contextHost(home, dockerContext);
  if (fromContext !== undefined) return fromContext;
  for (const socket of ["/var/run/docker.sock", path.join(home, ".docker/run/docker.sock")]) {
    if (await exists(socket)) return `unix://${socket}`;
  }
  return undefined;
}
