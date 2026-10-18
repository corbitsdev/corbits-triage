import { expect, test } from "bun:test";
import { connectDockerSidecars } from "./docker.js";

const REMOTE = "tcp://203.0.113.10:2376";

function connect(dockerHost: string, publicHubWebSocketUrl: string) {
  return connectDockerSidecars({
    docker: { dockerHost, home: "/nonexistent", certPath: "/nonexistent", publicHubWebSocketUrl },
    database: { host: "127.0.0.1", port: 1, user: "unused", password: "unused", database: "unused" },
    root: "/nonexistent",
    adapterManifest: [],
  });
}

test("Docker on another machine is not registered unless its sidecars dial the hub over wss:// at a public address", async () => {
  expect(await connect(REMOTE, "ws://triage.example.com/api/sidecars/ws")).toContain("without TLS");
  expect(await connect(REMOTE, "wss://localhost/api/sidecars/ws")).toContain("at its own address");
  expect(await connect(REMOTE, "wss://127.1/api/sidecars/ws")).toContain("at its own address");
  expect(await connect(REMOTE, "wss://triage.example.com/api/sidecars/ws")).toContain("TLS files cannot be read");
  expect(await connect("tcp://127.0.0.1:2376", "ws://127.0.0.1:3000/api/sidecars/ws")).toContain("TLS files cannot be read");
});
