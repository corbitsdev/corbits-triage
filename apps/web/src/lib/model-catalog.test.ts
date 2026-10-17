import { describe, expect, test } from "bun:test";
import type { Transport } from "@intx/hub-client";
import { reconcileModelCatalog } from "./model-catalog.ts";

type Row = Record<string, unknown> & { id: string };

function fakeCatalog(credentials: string[]) {
  const rows: Record<string, Row[]> = { providers: [], models: [], offerings: [] };
  const writes: string[] = [];
  async function fetch<T>(method: string, url: string, body?: unknown): Promise<T> {
    const path = new URL(url, "http://hub").pathname;
    if (path === "/api/tenants/t/credentials") return { data: credentials.map((name) => ({ id: `crd_${name}`, name, status: "active" })), nextCursor: null } as T;
    const kind = path.split("/catalog/")[1]!.split("/")[0]!;
    if (method === "GET") return { data: rows[kind], nextCursor: null } as T;
    writes.push(`${method} ${kind} ${JSON.stringify(body)}`);
    const row = { id: `${kind}_${rows[kind]!.length + 1}`, ...(body as object) };
    rows[kind]!.push(row);
    return row as T;
  }
  const transport: Transport = { fetch, subscribe: () => () => {} } as Transport;
  return { transport, rows, writes };
}

const INFERENCE = { endpoint: "https://inference.example/v1", model: "triage-large" };

describe("reconcileModelCatalog", () => {
  test("offers every declared model through the provider whose key is stored, once", async () => {
    const hub = fakeCatalog(["corbits-system-one", "anthropic"]);
    await reconcileModelCatalog(hub.transport, "t", INFERENCE);

    expect(hub.rows.providers!.map(({ name, plugin, baseURL, credentialId }) => [name, plugin, baseURL, credentialId])).toEqual([
      ["corbits-system-one", "corbits-system-one", "https://inference.example/v1", "crd_corbits-system-one"],
      ["anthropic", "anthropic", "https://api.anthropic.com", "crd_anthropic"],
    ]);
    expect(hub.rows.models!.map((row) => row.canonicalName)).toEqual(["decision", "claude-opus-5-5", "claude-haiku-5-5"]);
    expect(hub.rows.offerings!.map(({ modelId, providerId, quirks }) => [modelId, providerId, quirks])).toEqual([
      ["models_1", "providers_1", { model: "triage-large" }],
      ["models_2", "providers_2", undefined],
      ["models_3", "providers_2", undefined],
    ]);

    hub.writes.length = 0;
    await reconcileModelCatalog(hub.transport, "t", INFERENCE);
    expect(hub.writes).toEqual([]);
  });

  test("adds no offering for a model whose key is not stored", async () => {
    const hub = fakeCatalog(["corbits-system-one"]);
    await reconcileModelCatalog(hub.transport, "t", INFERENCE);
    expect(hub.rows.providers!.map((row) => row.name)).toEqual(["corbits-system-one"]);
    expect(hub.rows.offerings).toHaveLength(1);
  });
});
