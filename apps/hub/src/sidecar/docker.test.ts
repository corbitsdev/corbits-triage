import { expect, test } from "bun:test";
import { connectDockerSidecars, dockerPlaces } from "./docker.js";

const REMOTE = "tcp://203.0.113.10:2376";

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
