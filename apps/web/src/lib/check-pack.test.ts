import { describe, expect, test } from "bun:test";
import { emptyPack, recommendedPack } from "@corbits/triage-contracts";
import type { Transport } from "@intx/hub-client";
import { loadCheckPack, repoNeedsCheckSetup, saveCheckPack } from "./check-pack.ts";

function transport(store: {
  artifacts: Array<{ id: string; title: string; content: string }>;
  config: Record<string, unknown>;
  posted: unknown[];
}): Transport {
  return {
    fetch: async (method, path, body) => {
      store.posted.push({ method, path, body });
      if (method === "GET" && path === "/api/tenants/tenant") {
        return { id: "tenant", name: "Tenant", slug: "tenant", config: store.config } as never;
      }
      if (method === "PATCH" && path === "/api/tenants/tenant") {
        store.config = (body as { config: Record<string, unknown> }).config;
        return undefined as never;
      }
      if (method === "GET" && path.startsWith("/api/tenants/tenant/artifacts?")) {
        return { artifacts: store.artifacts.map(({ id, title }) => ({ id, title })), nextCursor: null } as never;
      }
      if (method === "GET" && path.startsWith("/api/tenants/tenant/artifacts/")) {
        const id = decodeURIComponent(path.split("/").at(-1) ?? "");
        const row = store.artifacts.find((item) => item.id === id);
        return { artifact: row } as never;
      }
      if (method === "POST" && path === "/api/tenants/tenant/artifacts") {
        const created = { id: "art_1", title: (body as { title: string }).title, content: (body as { content: string }).content };
        store.artifacts.push(created);
        return { artifact: created } as never;
      }
      if (method === "POST" && path.endsWith("/versions")) {
        const id = path.split("/").at(-2) ?? "";
        const row = store.artifacts.find((item) => item.id === id);
        if (row) row.content = (body as { content: string }).content;
        return { artifactId: id, version: 2 } as never;
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
    subscribe: () => () => {},
  };
}

describe("check-pack client", () => {
  test("empty default load is null when no artifact exists", async () => {
    const store = { artifacts: [], config: { corbitsTriage: { repos: [{ name: "acme/widgets", connected: true }] } }, posted: [] as unknown[] };
    expect(await loadCheckPack(transport(store), "tenant", "acme/widgets")).toBeNull();
  });

  test("save writes the artifact and empty draft is checks {} custom []", async () => {
    const store = {
      artifacts: [] as Array<{ id: string; title: string; content: string }>,
      config: { corbitsTriage: { repos: [{ name: "acme/widgets", connected: true }] } },
      posted: [] as unknown[],
    };
    const pack = emptyPack("acme/widgets");
    await saveCheckPack(transport(store), "tenant", "acme/widgets", pack);
    expect(store.posted).toContainEqual({
      method: "POST",
      path: "/api/tenants/tenant/artifacts",
      body: {
        mode: "text",
        title: "check-pack/acme/widgets",
        content: JSON.stringify(pack),
        metadata: { checkPack: "check-pack/acme/widgets" },
      },
    });
    expect(JSON.parse(store.artifacts[0]!.content)).toEqual(pack);
    expect(await loadCheckPack(transport(store), "tenant", "acme/widgets")).toEqual(pack);
  });

  test("Use recommended writes the recommended pack", async () => {
    const store = {
      artifacts: [] as Array<{ id: string; title: string; content: string }>,
      config: { corbitsTriage: { repos: [{ name: "acme/widgets", connected: true }] } },
      posted: [] as unknown[],
    };
    const pack = recommendedPack("acme/widgets");
    await saveCheckPack(transport(store), "tenant", "acme/widgets", pack, { cleanupMode: "human-approved" });
    expect(JSON.parse(store.artifacts[0]!.content).checks.size).toEqual({ enabled: true, maxFiles: 40, maxLines: 500 });
    const ns = store.config.corbitsTriage as { repos: Array<Record<string, unknown>> };
    expect(ns.repos[0]).toMatchObject({
      name: "acme/widgets",
      checkPack: { name: "check-pack/acme/widgets" },
      cleanupMode: "human-approved",
    });
  });

  test("repoNeedsCheckSetup is true until a pack pointer exists", () => {
    expect(repoNeedsCheckSetup({ name: "acme/widgets" })).toBe(true);
    expect(repoNeedsCheckSetup({ checkPack: { name: "check-pack/acme/widgets" } })).toBe(false);
  });
});
