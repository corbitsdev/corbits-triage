// SPDX-License-Identifier: GPL-2.0-only
//
// Requires PostgreSQL at TEST_DATABASE_URL.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../..");
const TEST_DATABASE_URL = "postgres://postgres:postgres@localhost:5432/interchange";
// The hub shells out to `bunx`, which needs bun on PATH and a HOME for its cache.
const CHILD_PATH = `${dirname(process.execPath)}:/usr/bin:/bin`;
const processes: Bun.Subprocess[] = [];
const temporaryDirectories: string[] = [];

const TEST_SECRETS = {
  BETTER_AUTH_SECRET: "a".repeat(64),
  CREDENTIAL_ENCRYPTION_KEY: "b".repeat(64),
  PRINCIPAL_KEY_ENCRYPTION_KEY: "c".repeat(64),
  SIDECAR_CREDENTIAL_ENCRYPTION_KEY: "d".repeat(64),
};

function emptyResponse(): Response {
  return new Response(null);
}

function reservePort(): number {
  const probe = Bun.serve({ port: 0, fetch: emptyResponse });
  const port = probe.port;
  probe.stop(true);
  if (port === undefined) throw new Error("Bun did not assign a test server port");
  return port;
}

async function waitUntilReady(origin: string, child: Bun.Subprocess): Promise<boolean> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      const response = await fetch(`${origin}/api/me`);
      if (response.status === 401) return true;
    } catch {
      // The server is still applying migrations or binding its socket.
    }
    await Bun.sleep(100);
  }
  return false;
}

function openWebSocket(url: string): Promise<void> {
  return new Promise(function upgrade(resolve, reject) {
    const socket = new WebSocket(url);
    const timeout = setTimeout(function onTimeout() {
      socket.close();
      reject(new Error(`Timed out upgrading ${url}`));
    }, 5_000);
    socket.addEventListener("open", function onOpen() {
      clearTimeout(timeout);
      socket.close();
      resolve();
    }, { once: true });
    socket.addEventListener("error", function onError() {
      clearTimeout(timeout);
      reject(new Error(`WebSocket upgrade failed for ${url}`));
    }, { once: true });
  });
}

afterEach(async () => {
  for (const child of processes.splice(0)) {
    if (child.exitCode === null) child.kill("SIGTERM");
    await Promise.race([child.exited, Bun.sleep(2_000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("composed hub upgrades the sidecar websocket", async () => {
  const port = reservePort();
  const dataDir = mkdtempSync(join(tmpdir(), "corbits-hub-websocket-"));
  temporaryDirectories.push(dataDir);

  const child = Bun.spawn(
    [process.execPath, "--conditions=intx-src", "apps/hub/src/server.ts"],
    {
      cwd: ROOT,
      env: {
        PATH: CHILD_PATH,
        HOME: homedir(),
        ...TEST_SECRETS,
        DATABASE_URL: TEST_DATABASE_URL,
        HUB_DATA_DIR: dataDir,
        PORT: String(port),
        BETTER_AUTH_BASE_URL: `http://127.0.0.1:${port}`,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  processes.push(child);
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const origin = `http://127.0.0.1:${port}`;

  if (!(await waitUntilReady(origin, child))) {
    if (child.exitCode === null) child.kill("SIGTERM");
    await child.exited;
    throw new Error(`Composed hub did not become ready:\n${await stdout}\n${await stderr}`);
  }

  const response = await fetch(`${origin}/api/me`);
  expect(response.status).toBe(401);
  await expect(
    openWebSocket(`ws://127.0.0.1:${port}/api/sidecars/ws`),
  ).resolves.toBeUndefined();
}, 40_000);
