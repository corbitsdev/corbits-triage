import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { connectDocker } from "@corbits/provisioner-docker";
import { dockerSettings, loadHubEnv } from "../env.js";
import { connectDockerSidecars, dockerPlaces, sidecarImageOf } from "./docker.js";

const REMOTE = "tcp://203.0.113.10:2376";
const SECRET = "0".repeat(64);
const HUB_ENV = {
  DATABASE_URL: "postgres://unused@127.0.0.1:1/unused",
  BETTER_AUTH_SECRET: SECRET,
  CREDENTIAL_ENCRYPTION_KEY: SECRET,
  PRINCIPAL_KEY_ENCRYPTION_KEY: SECRET,
  SIDECAR_CREDENTIAL_ENCRYPTION_KEY: SECRET,
  BETTER_AUTH_BASE_URL: "https://triage.example.com",
  PORT: "3000",
  HUB_DATA_DIR: "/nonexistent",
};

async function placesOf(dockerHost: string, publicHubWebSocketUrl: string) {
  const docker = await connectDockerSidecars({
    docker: { dockerHost, home: "/nonexistent", publicHubWebSocketUrl },
    database: { host: "127.0.0.1", port: 1, user: "unused", password: "unused", database: "unused" },
    adapterManifest: [],
  });
  return dockerPlaces(docker).map((place) => ({ id: place.guide.id, found: place.found }));
}

function failingRemote(problem: string) {
  return [{ id: "docker", found: undefined }, { id: "docker-remote", found: expect.stringContaining(problem) }];
}

test("Docker on another machine is not registered unless its sidecars dial the hub over wss:// at a public address, and its failure is the remote place's", async () => {
  expect(await placesOf(REMOTE, "ws://triage.example.com/api/sidecars/ws")).toEqual(failingRemote("only over TLS"));
  expect(await placesOf(REMOTE, "wss://localhost/api/sidecars/ws")).toEqual(failingRemote("at its own address"));
  expect(await placesOf(REMOTE, "wss://127.1/api/sidecars/ws")).toEqual(failingRemote("at its own address"));
  expect(await placesOf(REMOTE, "wss://triage.example.com/api/sidecars/ws")).toEqual(failingRemote("reach it over TLS with DOCKER_TLS_CA"));
  expect(await placesOf("tcp://127.0.0.1:1", "ws://127.0.0.1:3000/api/sidecars/ws")).toEqual([
    { id: "docker", found: expect.stringContaining("does not answer") },
    { id: "docker-remote", found: undefined },
  ]);
});

test("sidecars run the image written into the hub image, or the locally built one when none was", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sidecar-image-"));
  try {
    const file = path.join(dir, "sidecar-image");
    expect(await sidecarImageOf(new URL(`file://${file}`))).toBe("corbits-triage-sidecar");
    await fs.writeFile(file, "ghcr.io/corbitsdev/corbits-triage-sidecar@sha256:abc\n");
    expect(await sidecarImageOf(new URL(`file://${file}`))).toBe("ghcr.io/corbitsdev/corbits-triage-sidecar@sha256:abc");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("the hub reaches Docker over mutual TLS with the base64 PEMs in DOCKER_TLS_CA, DOCKER_TLS_CERT and DOCKER_TLS_KEY", async () => {
  const openssl = Bun.which("openssl");
  if (openssl === null) throw new Error("This test generates certificates with openssl, which is not on PATH");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "docker-tls-env-"));
  const at = (file: string) => path.join(dir, file);
  async function issue(name: string, subject: string, extensions: string): Promise<void> {
    await fs.writeFile(at(`${name}.cnf`), extensions);
    await Bun.$`${openssl} req -newkey rsa:2048 -nodes -keyout ${at(`${name}-key.pem`)} -out ${at(`${name}.csr`)} -subj ${subject}`.quiet();
    await Bun.$`${openssl} x509 -req -days 1 -in ${at(`${name}.csr`)} -CA ${at("ca.pem")} -CAkey ${at("ca-key.pem")} -CAcreateserial -out ${at(`${name}-cert.pem`)} -extfile ${at(`${name}.cnf`)}`.quiet();
  }
  async function base64Of(file: string): Promise<string> {
    return (await fs.readFile(at(file))).toString("base64");
  }
  try {
    await Bun.$`${openssl} req -x509 -newkey rsa:2048 -nodes -days 1 -keyout ${at("ca-key.pem")} -out ${at("ca.pem")} -subj /CN=ca`.quiet();
    await issue("server", "/CN=localhost", "extendedKeyUsage = serverAuth\nsubjectAltName = IP:127.0.0.1\n");
    await issue("client", "/CN=hub", "extendedKeyUsage = clientAuth\n");
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      tls: { cert: Bun.file(at("server-cert.pem")), key: Bun.file(at("server-key.pem")), ca: Bun.file(at("ca.pem")), requestCert: true, rejectUnauthorized: true },
      fetch: () => Response.json({ ok: 1 }),
    });
    try {
      const tlsEnv = { DOCKER_TLS_CA: await base64Of("ca.pem"), DOCKER_TLS_CERT: await base64Of("client-cert.pem"), DOCKER_TLS_KEY: await base64Of("client-key.pem") };
      const { tls } = dockerSettings(loadHubEnv({ ...HUB_ENV, ...tlsEnv }));
      expect(await connectDocker(`tcp://127.0.0.1:${String(server.port)}`, tls).request("GET", "/info")).toEqual({ ok: 1 });

      expect(() => dockerSettings(loadHubEnv({ ...HUB_ENV, DOCKER_TLS_CA: tlsEnv.DOCKER_TLS_CA }))).toThrow("must be set together");
      const unencodedKey = await fs.readFile(at("client-key.pem"), "utf8");
      expect(() => loadHubEnv({ ...HUB_ENV, ...tlsEnv, DOCKER_TLS_KEY: unencodedKey })).toThrow("DOCKER_TLS_KEY must be a PEM private key encoded as base64");
      expect(() => loadHubEnv({ ...HUB_ENV, ...tlsEnv, DOCKER_TLS_CERT: tlsEnv.DOCKER_TLS_KEY })).toThrow("DOCKER_TLS_CERT must be a PEM certificate encoded as base64");
    } finally {
      server.stop(true);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
