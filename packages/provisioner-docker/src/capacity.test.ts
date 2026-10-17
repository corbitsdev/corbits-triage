import { expect, test } from "bun:test";
import { createDockerSidecarProvisioner, type DockerEngine } from "./index.js";

const GiB = 1024 ** 3;

type FakeContainer = { Id: string; Labels: Record<string, string> };

function hasLabels(container: FakeContainer, labels: readonly string[]): boolean {
  return labels.every((label) => {
    const [key, value] = label.split("=");
    return key !== undefined && container.Labels[key] === value;
  });
}

/** A daemon with room for one sidecar that answers both ensures' capacity listings in the same tick. */
function sameTickDaemon(containers: FakeContainer[]): DockerEngine {
  let waiting: Array<() => void> = [];
  function releaseTogether(resolve: () => void): void {
    waiting.push(resolve);
    if (waiting.length < 2) return;
    for (const release of waiting) release();
    waiting = [];
  }
  return {
    host: "unix:///fake",
    async request(_method, path, opts) {
      const url = new URL(`http://docker${path}`);
      if (url.pathname === "/info") return { MemTotal: 3 * GiB };
      if (url.pathname === "/containers/json") {
        const labels = (JSON.parse(url.searchParams.get("filters") ?? "{}") as { label: string[] }).label;
        if (labels.length === 1) await new Promise<void>(releaseTogether);
        return containers.filter((container) => hasLabels(container, labels));
      }
      if (url.pathname === "/containers/create") {
        const id = `c${String(containers.length + 1)}`;
        const body = opts?.body as { Labels: Record<string, string> };
        containers.push({ Id: id, Labels: body.Labels });
        return { Id: id };
      }
      return null;
    },
  };
}

function ensureRequest(allocationId: string) {
  return { allocationId, generation: 1, sidecarId: `sc_${allocationId}`, tenantId: "tnt", anchorRunId: "run", token: "token", hubWebSocketUrl: "ws://127.0.0.1:1/sidecar" };
}

test("two ensures whose capacity reads land in the same tick never both take the last room", async () => {
  const containers: FakeContainer[] = [];
  const provisioner = createDockerSidecarProvisioner({ engine: sameTickDaemon(containers), hubId: "hub", daemonId: "daemon", image: "image", adapterManifest: [] });
  const results = await Promise.all([provisioner.ensure(ensureRequest("a")), provisioner.ensure(ensureRequest("b"))]);
  expect(results.map((result) => result.kind).sort()).toEqual(["accepted", "rejected"]);
  expect(containers).toHaveLength(1);
});
