import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { type } from "arktype";
import {
  connectDocker,
  createDockerSidecarProvisioner,
  findDockerHost,
  isLocalDockerHost,
  isThisMachine,
  readDockerTls,
  sweepDockerSidecars,
  type DockerEngine,
  type DockerSidecars,
  type DockerTls,
} from "@corbits/provisioner-docker";
import { createDB, createSidecarAllocationStore, createWorkflowProbeStore, type DB } from "@intx/db";
import type { SidecarProvisioner } from "@intx/hub-sessions";
import type { AdapterManifest } from "@intx/types";
import { sql } from "drizzle-orm";
import type { DatabaseConfig, DockerSettings } from "../env.js";

/** Built from the root Dockerfile's `sidecar` stage, which holds IMAGE_PATHS of the repository at IMAGE_ROOT. */
export const SIDECAR_IMAGE = "corbits-triage-sidecar";
const IMAGE_ROOT = "/app";
const IMAGE_PATHS = ["apps/hub/", "packages/", "vendor/"];
const PING_TIMEOUT_MS = 2_000;

const DatabaseIdentity = type({ cluster: "string", database: "string" });
const DaemonInfo = type({ ID: "string" });

export type DockerSidecarProvisioner = DockerSidecars & { readonly provisioner: SidecarProvisioner };

type ConnectOpts = {
  readonly docker: DockerSettings;
  readonly database: DatabaseConfig;
  /** The repository root on the hub. */
  readonly root: string;
  readonly adapterManifest: AdapterManifest;
};

/**
 * The Postgres cluster's system identifier, the database's oid and the schema: the same however DATABASE_URL names
 * the database, and different for every other database.
 */
async function hubIdOf(database: DatabaseConfig): Promise<string> {
  const { db, close } = createDB(database);
  try {
    const [row] = await db.execute(sql`select (select system_identifier from pg_control_system())::text as cluster, (select oid from pg_database where datname = current_database())::text as database`);
    const { cluster, database: oid } = DatabaseIdentity.assert(row);
    return createHash("sha256").update(`${cluster}/${oid}/${database.schema ?? "public"}`).digest("hex").slice(0, 12);
  } finally {
    await close();
  }
}

/** The manifest at the image's paths, or undefined when a module is not in the image, such as the entry a GITHUB_API_ORIGIN override writes under HUB_DATA_DIR. */
function inImage(manifest: AdapterManifest, root: string): AdapterManifest | undefined {
  const hostPrefix = pathToFileURL(`${root}/`).href;
  const relocated = manifest.map(function relocate(entry) {
    if (!entry.specifier.startsWith("file:")) return entry;
    const relative = entry.specifier.startsWith(hostPrefix) ? entry.specifier.slice(hostPrefix.length) : undefined;
    if (relative === undefined || !IMAGE_PATHS.some((prefix) => relative.startsWith(prefix))) return undefined;
    return { ...entry, specifier: `file://${IMAGE_ROOT}/${relative}` };
  });
  return relocated.every((entry) => entry !== undefined) ? relocated : undefined;
}

async function daemonId(engine: DockerEngine): Promise<string> {
  await engine.request("GET", "/_ping", { timeoutMs: PING_TIMEOUT_MS });
  await engine.request("GET", `/images/${SIDECAR_IMAGE}/json`);
  return DaemonInfo.assert(await engine.request("GET", "/info")).ID;
}

/** Why sidecars on another machine cannot dial the hub at `hubUrl`: its token and credentials cross that socket. */
function remoteHubProblem(host: string, hubUrl: string): string | undefined {
  const url = new URL(hubUrl);
  if (url.protocol !== "wss:") {
    return `Docker at ${host} is another machine, and its sidecars would dial the hub at ${hubUrl} without TLS; set BETTER_AUTH_BASE_URL to the hub's https:// address`;
  }
  if (isThisMachine(url.hostname)) {
    return `Docker at ${host} is another machine, and its sidecars would dial the hub at its own address ${hubUrl}; set BETTER_AUTH_BASE_URL to the hub's public address`;
  }
  return undefined;
}

/** The Docker provisioner, or why it is not registered. */
export async function connectDockerSidecars({ docker, database, root, adapterManifest }: ConnectOpts): Promise<DockerSidecarProvisioner | string> {
  const manifest = inImage(adapterManifest, root);
  if (manifest === undefined) return "an adapter module is not in the sidecar image, as with GITHUB_API_ORIGIN set";
  let host: string | undefined;
  try {
    host = await findDockerHost(docker);
  } catch (error) {
    return `the docker CLI's context cannot be read (${String(error)})`;
  }
  if (host === undefined) return "no Docker daemon found";
  let remote: boolean;
  try {
    remote = !isLocalDockerHost(host);
  } catch {
    return `Docker host ${host} is not a URL`;
  }
  const hubProblem = remote ? remoteHubProblem(host, docker.publicHubWebSocketUrl) : undefined;
  if (hubProblem !== undefined) return hubProblem;
  let tls: DockerTls | undefined;
  try {
    tls = docker.certPath === undefined ? undefined : await readDockerTls(docker.certPath);
  } catch (error) {
    return `DOCKER_TLS_VERIFY is set but the TLS files cannot be read (${String(error)})`;
  }
  let engine: DockerEngine;
  try {
    engine = connectDocker(host, tls);
  } catch (error) {
    return `Docker at ${host} is refused (${String(error)})`;
  }
  let id: string;
  try {
    id = await daemonId(engine);
  } catch (error) {
    return `Docker at ${host} has no ${SIDECAR_IMAGE} image or does not answer (${String(error)}); build it with docker build --target sidecar -t ${SIDECAR_IMAGE} .`;
  }
  let hubId: string;
  try {
    hubId = await hubIdOf(database);
  } catch (error) {
    return `the database does not tell this hub apart from others (${String(error)})`;
  }
  return {
    engine,
    hubId,
    provisioner: createDockerSidecarProvisioner({
      engine,
      hubId,
      daemonId: id,
      image: SIDECAR_IMAGE,
      adapterManifest: manifest,
      ...(remote && { hubWebSocketUrl: docker.publicHubWebSocketUrl }),
    }),
  };
}

/** Removes Docker sidecars no active allocation or probe holds. */
export async function sweepDockerSidecarsOf(db: DB["db"], docker: DockerSidecarProvisioner): Promise<number> {
  const [allocations, probes] = await Promise.all([createSidecarAllocationStore(db).listActive(), createWorkflowProbeStore(db).listActive()]);
  const active = new Set([...allocations, ...probes].filter((row) => row.provisionerId === docker.provisioner.id).map((row) => row.id));
  return sweepDockerSidecars(docker, active);
}
