import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { type } from "arktype";
import {
  connectDocker,
  createDockerSidecarProvisioner,
  DOCKER_PLACE,
  DOCKER_REMOTE_PLACE,
  findDockerHost,
  isLocalDockerHost,
  isThisMachine,
  sweepDockerSidecars,
  type DockerEngine,
  type DockerSidecars,
} from "@corbits/provisioner-docker";
import { createDB, createSidecarAllocationStore, createWorkflowProbeStore, type DB } from "@intx/db";
import type { SidecarProvisioner } from "@intx/hub-sessions";
import type { AdapterManifest } from "@intx/types";
import { sql } from "drizzle-orm";
import type { PlaceProbe } from "../code-review.js";
import type { DatabaseConfig, DockerSettings } from "../env.js";

/** The published sidecar image pinned by digest, which CI writes into the hub image. */
const BAKED_SIDECAR_IMAGE = new URL("../../sidecar-image", import.meta.url);
/** Built from the root Dockerfile's `sidecar` stage. */
const LOCAL_SIDECAR_IMAGE = "corbits-triage-sidecar";
const PING_TIMEOUT_MS = 2_000;

const DatabaseIdentity = type({ cluster: "string", database: "string" });
const DaemonInfo = type({ ID: "string" });

export type DockerSidecarProvisioner = DockerSidecars & { readonly remote: boolean; readonly provisioner: SidecarProvisioner };

type ConnectOpts = {
  readonly docker: DockerSettings;
  readonly database: DatabaseConfig;
  readonly adapterManifest: AdapterManifest;
};

/**
 * The Postgres cluster's system identifier, the database's oid and the schema: the same however DATABASE_URL names
 * the database, and different for every other database.
 */
export async function hubIdOf(database: DatabaseConfig): Promise<string> {
  const { db, close } = createDB(database);
  try {
    const [row] = await db.execute(sql`select (select system_identifier from pg_control_system())::text as cluster, (select oid from pg_database where datname = current_database())::text as database`);
    const { cluster, database: oid } = DatabaseIdentity.assert(row);
    return createHash("sha256").update(`${cluster}/${oid}/${database.schema ?? "public"}`).digest("hex").slice(0, 12);
  } finally {
    await close();
  }
}

/** The image sidecars run: the one written into the hub image at `file`, or the locally built one when none was. */
export async function sidecarImageOf(file: URL): Promise<string> {
  try {
    return (await fs.readFile(file, "utf8")).trim();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return LOCAL_SIDECAR_IMAGE;
    throw error;
  }
}

/** Why sidecars on another machine (`where`) cannot dial the hub at `hubUrl`: its token and credentials cross that socket. */
export function remoteHubProblem(where: string, hubUrl: string): string | undefined {
  const url = new URL(hubUrl);
  if (url.protocol !== "wss:") {
    return `${where} is on another machine, which reaches Triage only over TLS; set BETTER_AUTH_BASE_URL to Triage's https:// address`;
  }
  if (isThisMachine(url.hostname)) {
    return `${where} is on another machine, which cannot reach Triage at its own address; set BETTER_AUTH_BASE_URL to Triage's public address`;
  }
  return undefined;
}

/** Why Docker is not registered, and whether the daemon it found is on another machine; `remote` is absent when none was found. */
export type DockerOff = { readonly remote?: boolean; readonly reason: string };

/** The Docker provisioner, or why it is not registered. */
export async function connectDockerSidecars({ docker, database, adapterManifest }: ConnectOpts): Promise<DockerSidecarProvisioner | DockerOff> {
  let host: string | undefined;
  try {
    host = await findDockerHost(docker);
  } catch (error) {
    return { remote: false, reason: `The Docker CLI's settings on this server cannot be read (${String(error)})` };
  }
  if (host === undefined) return { reason: "no Docker daemon found" };
  let remote: boolean;
  try {
    remote = !isLocalDockerHost(host);
  } catch {
    return { remote: true, reason: `The Docker address ${host} is not a URL` };
  }
  function off(reason: string): DockerOff {
    return { remote, reason };
  }
  const hubProblem = remote ? remoteHubProblem(`Docker at ${host}`, docker.publicHubWebSocketUrl) : undefined;
  if (hubProblem !== undefined) return off(hubProblem);
  let engine: DockerEngine;
  try {
    engine = connectDocker(host, docker.tls);
  } catch (error) {
    return off(`Triage cannot connect to Docker at ${host} (${String(error)})`);
  }
  let id: string;
  try {
    await engine.request("GET", "/_ping", { timeoutMs: PING_TIMEOUT_MS });
    id = DaemonInfo.assert(await engine.request("GET", "/info")).ID;
  } catch (error) {
    return off(`Docker at ${host} does not answer (${String(error)})`);
  }
  const image = await sidecarImageOf(BAKED_SIDECAR_IMAGE);
  // A published image is pulled when a review first needs it; a locally built one must already be there.
  if (image === LOCAL_SIDECAR_IMAGE) {
    try {
      await engine.request("GET", `/images/${image}/json`);
    } catch (error) {
      return off(`Docker at ${host} has no ${image} image (${String(error)}); build it with docker build --target sidecar -t ${image} .`);
    }
  }
  let hubId: string;
  try {
    hubId = await hubIdOf(database);
  } catch (error) {
    return off(`Triage cannot read its database's identity, which keeps its containers apart from other servers' (${String(error)})`);
  }
  return {
    engine,
    hubId,
    remote,
    provisioner: createDockerSidecarProvisioner({
      engine,
      hubId,
      daemonId: id,
      image,
      adapterManifest,
      ...(remote && { hubWebSocketUrl: docker.publicHubWebSocketUrl }),
    }),
  };
}

/** Docker on this machine and on another one; the daemon the hub found decides which of the two it is. */
export function dockerPlaces(docker: DockerSidecarProvisioner | DockerOff): PlaceProbe[] {
  return [DOCKER_PLACE, DOCKER_REMOTE_PLACE].map(function probe(guide): PlaceProbe {
    if (docker.remote !== (guide === DOCKER_REMOTE_PLACE)) return { guide, found: undefined };
    return { guide, found: "provisioner" in docker ? docker : docker.reason };
  });
}

/** The ids of the active allocations and probes placed on a provisioner. */
export async function activeSidecarIds(db: DB["db"], provisionerId: string): Promise<Set<string>> {
  const [allocations, probes] = await Promise.all([createSidecarAllocationStore(db).listActive(), createWorkflowProbeStore(db).listActive()]);
  return new Set([...allocations, ...probes].filter((row) => row.provisionerId === provisionerId).map((row) => row.id));
}

/** Removes Docker sidecars no active allocation or probe holds. */
export async function sweepDockerSidecarsOf(db: DB["db"], docker: DockerSidecarProvisioner): Promise<number> {
  return sweepDockerSidecars(docker, await activeSidecarIds(db, docker.provisioner.id));
}
