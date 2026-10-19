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

/** The PEMs of the CA that signed the daemon's certificate, and of the client certificate and its key. */
export type DockerTls = {
  readonly ca: string;
  readonly cert: string;
  readonly key: string;
};

/**
 * Whether a hostname names this machine: `localhost`, 127.0.0.0/8 in any IPv4 spelling, `0.0.0.0`, `::`, `::1` and
 * IPv4-mapped loopback. Any other name, even one that resolves to this machine, counts as another machine.
 */
export function isThisMachine(hostname: string): boolean {
  const name = hostname.toLowerCase().replace(/\.$/, "");
  if (name === "localhost") return true;
  let normalized: string;
  try {
    // http parses IPv4 short and hex forms, which other schemes leave as text.
    normalized = new URL(`http://${name}`).hostname;
  } catch {
    return false;
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(normalized)) return normalized.startsWith("127.") || normalized === "0.0.0.0";
  return normalized === "[::1]" || normalized === "[::]" || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(normalized);
}

/** Whether the daemon runs on this machine: a unix socket, or a `tcp://` address `isThisMachine` accepts. */
export function isLocalDockerHost(host: string): boolean {
  const address = new URL(host);
  return address.protocol === "unix:" || isThisMachine(address.hostname);
}

/**
 * A client for the Docker Engine API at `unix:///path` or `tcp://host:port`, over TLS when `tls` is given. Throws for
 * any other address, and for `tcp://` to another machine without TLS.
 */
export function connectDocker(host: string, tls?: DockerTls): DockerEngine {
  const address = new URL(host);
  if (address.protocol !== "unix:" && address.protocol !== "tcp:") {
    throw new Error(`Docker host ${host} must be unix:// or tcp://`);
  }
  if (tls === undefined && !isLocalDockerHost(host)) {
    throw new Error(`Docker host ${host} is another machine; reach it over TLS with DOCKER_TLS_CA, DOCKER_TLS_CERT and DOCKER_TLS_KEY`);
  }
  const scheme = tls === undefined ? "http" : "https";
  const base = address.protocol === "unix:" ? "http://docker" : `${scheme}://${address.host}`;
  const transport = address.protocol === "unix:" ? { unix: address.pathname } : { ...(tls !== undefined && { tls }) };

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
