import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { connectDocker, isLocalDockerHost, type DockerTls } from "./engine.js";

test("plain tcp:// reaches only this machine; another machine needs TLS", () => {
  for (const host of ["tcp://LOCALHOST:2375", "tcp://localhost.:2375", "tcp://127.1:2375", "tcp://0x7f.0.0.1:2375", "tcp://127.9.9.9:2375", "tcp://0.0.0.0:2375", "tcp://[::1]:2375", "tcp://[::ffff:127.0.0.1]:2375"]) {
    expect({ host, local: isLocalDockerHost(host) }).toEqual({ host, local: true });
    expect(connectDocker(host).host).toBe(host);
  }
  for (const host of ["tcp://203.0.113.10:2375", "tcp://foo.localhost:2375", "tcp://127.0.0.1.nip.io:2375", "tcp://[::ffff:203.0.113.10]:2375", "tcp://docker.example.com:2375"]) {
    expect({ host, local: isLocalDockerHost(host) }).toEqual({ host, local: false });
    expect(() => connectDocker(host)).toThrow("another machine");
  }
});

test("a response of one JSON value per line, as a pull's progress is, is read line by line", async () => {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response('{"status":"Pulling"}\n{"error":"denied"}\n') });
  try {
    const engine = connectDocker(`tcp://127.0.0.1:${String(server.port)}`);
    expect(await engine.request("POST", "/images/create", { lines: true })).toEqual([{ status: "Pulling" }, { error: "denied" }]);
  } finally {
    server.stop(true);
  }
});

/** Absent openssl fails the run rather than skipping the only proof that TLS is verified. */
function requireOpenssl(): string {
  const found = Bun.which("openssl");
  if (found === null) throw new Error("The mutual TLS tests generate certificates with openssl, which is not on PATH");
  return found;
}

describe("Docker over mutual TLS", () => {
  let dir: string;
  let openssl: string;
  let server: ReturnType<typeof Bun.serve> | undefined;

  async function issue(name: string, ca: string, subject: string, extensions: string): Promise<void> {
    const at = (suffix: string) => path.join(dir, `${name}${suffix}`);
    await fs.writeFile(at(".cnf"), extensions);
    await Bun.$`${openssl} req -newkey rsa:2048 -nodes -keyout ${at("-key.pem")} -out ${at(".csr")} -subj ${subject}`.quiet();
    await Bun.$`${openssl} x509 -req -days 1 -in ${at(".csr")} -CA ${path.join(dir, `${ca}.pem`)} -CAkey ${path.join(dir, `${ca}-key.pem`)} -CAcreateserial -out ${at("-cert.pem")} -extfile ${at(".cnf")}`.quiet();
  }

  async function read(file: string): Promise<string> {
    return fs.readFile(path.join(dir, file), "utf8");
  }

  async function serve(name: string): Promise<string> {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      tls: { cert: await read(`${name}-cert.pem`), key: await read(`${name}-key.pem`), ca: await read("ca.pem"), requestCert: true, rejectUnauthorized: true },
      fetch: () => Response.json({ ok: 1 }),
    });
    return String(server.port);
  }

  async function clientTls(client = "client"): Promise<DockerTls> {
    return { ca: await read("ca.pem"), cert: await read(`${client}-cert.pem`), key: await read(`${client}-key.pem`) };
  }

  beforeAll(async () => {
    openssl = requireOpenssl();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "docker-tls-"));
    for (const ca of ["ca", "other-ca"]) {
      await Bun.$`${openssl} req -x509 -newkey rsa:2048 -nodes -days 1 -keyout ${path.join(dir, `${ca}-key.pem`)} -out ${path.join(dir, `${ca}.pem`)} -subj /CN=${ca}`.quiet();
    }
    const serverUse = "extendedKeyUsage = serverAuth\nsubjectAltName = IP:127.0.0.1,DNS:localhost\n";
    await issue("good", "ca", "/CN=localhost", serverUse);
    await issue("othersigned", "other-ca", "/CN=localhost", serverUse);
    await issue("wrongname", "ca", "/CN=docker.example.com", "extendedKeyUsage = serverAuth\nsubjectAltName = DNS:docker.example.com\n");
    await issue("client", "ca", "/CN=hub", "extendedKeyUsage = clientAuth\n");
    await issue("rogue", "other-ca", "/CN=hub", "extendedKeyUsage = clientAuth\n");
  });

  afterEach(() => server?.stop(true));
  afterAll(() => fs.rm(dir, { recursive: true, force: true }));

  test("reaches a daemon whose certificate our CA signed for the name dialled, with our client certificate", async () => {
    const port = await serve("good");
    const tls = await clientTls();
    expect(await connectDocker(`tcp://127.0.0.1:${port}`, tls).request("GET", "/info")).toEqual({ ok: 1 });
    expect(await connectDocker(`tcp://localhost:${port}`, tls).request("GET", "/info")).toEqual({ ok: 1 });
  });

  test("refuses a daemon certificate for another name or from another CA", async () => {
    const wrongName = await serve("wrongname");
    await expect(connectDocker(`tcp://127.0.0.1:${wrongName}`, await clientTls()).request("GET", "/info")).rejects.toThrow();
    server?.stop(true);
    const otherCa = await serve("othersigned");
    await expect(connectDocker(`tcp://127.0.0.1:${otherCa}`, await clientTls()).request("GET", "/info")).rejects.toThrow();
  });

  test("the daemon refuses a client certificate our CA did not sign", async () => {
    const port = await serve("good");
    await expect(connectDocker(`tcp://127.0.0.1:${port}`, await clientTls("rogue")).request("GET", "/info")).rejects.toThrow();
  });
});
