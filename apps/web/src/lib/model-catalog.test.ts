import { describe, expect, test } from "bun:test";
import { ApiError, type Transport } from "@intx/hub-client";
import { loadPortal, type MemberAccess } from "./hub-api.ts";
import { reconcileModelCatalog, saveInference } from "./model-catalog.ts";

type Row = Record<string, unknown> & { id: string };

function fakeHub(credentials: string[], placeFailure = new ApiError(403, "forbidden", "forbidden")) {
  const rows: Record<string, Row[]> = { providers: [], models: [], offerings: [] };
  const writes: string[] = [];
  const credentialBodies: unknown[] = [];
  const keys = credentials.map((name) => ({ id: `crd_${name}`, name, status: "active" }));
  async function fetch<T>(method: string, url: string, body?: unknown): Promise<T> {
    const path = new URL(url, "http://hub").pathname;
    if (path === "/api/tenants/t/credentials" && method === "POST") {
      credentialBodies.push(body);
      if (!keys.some((key) => key.id === "crd_saved")) keys.push({ id: "crd_saved", name: (body as { name: string }).name, status: "active" });
      return { id: "crd_saved" } as T;
    }
    if (path === "/api/tenants/t/credentials") return { data: keys, nextCursor: null } as T;
    if (path === "/api/tenants/t") return { id: "t", name: "Acme", slug: "acme", config: {} } as T;
    if (path === "/api/integrations/code-review/t/place") throw placeFailure;
    if (path === "/api/tenants/t/providers") return (method === "GET" ? { data: [], nextCursor: null } : { id: "vault_provider" }) as T;
    if (!path.includes("/catalog/")) throw new Error(`unexpected ${method} ${path}`);
    const kind = path.split("/catalog/")[1]!.split("/")[0]!;
    if (method === "GET") return { data: rows[kind], nextCursor: null } as T;
    writes.push(`${method} ${kind} ${JSON.stringify(body)}`);
    if (method === "PATCH") {
      const existing = rows[kind]!.find((row) => path.endsWith(`/${row.id}`))!;
      Object.assign(existing, body);
      return existing as T;
    }
    const row = { id: `${kind}_${rows[kind]!.length + 1}`, ...(body as object) };
    rows[kind]!.push(row);
    return row as T;
  }
  const transport: Transport = { fetch, subscribe: () => () => {} } as Transport;
  return { transport, rows, writes, credentialBodies, keys };
}

describe("reconcileModelCatalog", () => {
  test("offers every declared model through the provider whose key is stored, once", async () => {
    const hub = fakeHub(["corbits-system-one", "anthropic"]);
    await reconcileModelCatalog(hub.transport, "t");

    expect(hub.rows.providers!.map(({ name, plugin, baseURL, credentialId }) => [name, plugin, baseURL, credentialId])).toEqual([
      ["anthropic", "anthropic", "https://api.anthropic.com", "crd_anthropic"],
    ]);
    expect(hub.rows.models!.map((row) => row.canonicalName)).toEqual(["decision", "claude-opus-5-5", "claude-haiku-5-5"]);
    expect(hub.rows.offerings!.map(({ modelId, providerId }) => [modelId, providerId])).toEqual([
      ["models_2", "providers_1"],
      ["models_3", "providers_1"],
    ]);

    hub.writes.length = 0;
    await reconcileModelCatalog(hub.transport, "t");
    expect(hub.writes).toEqual([]);
  });

  test("adds no offering for a model whose key is not stored", async () => {
    const hub = fakeHub([]);
    await reconcileModelCatalog(hub.transport, "t");
    expect(hub.rows.providers).toHaveLength(0);
    expect(hub.rows.offerings).toHaveLength(0);
  });
});

const ACCESS: MemberAccess = { kind: "member", workspace: { tenantId: "t", principalId: "p", userId: "u" }, workspaces: [], invitations: [] };

async function savedModel(transport: Transport) {
  return (await loadPortal(transport, ACCESS, async () => false)).decisionModel;
}

describe("saveInference", () => {
  test("stores the endpoint and model in the catalog, where the portal reads them back", async () => {
    const hub = fakeHub([]);
    await saveInference(hub.transport, "t", { endpoint: "https://inference.example/v1", model: "triage-large", secret: "sk-test" });

    expect(hub.credentialBodies).toEqual([expect.not.objectContaining({ metadata: expect.anything() })]);
    expect(hub.rows.providers!.map(({ name, baseURL, credentialId }) => [name, baseURL, credentialId])).toEqual([
      ["corbits-system-one", "https://inference.example/v1", "crd_saved"],
    ]);
    expect(hub.rows.offerings!.map(({ quirks }) => quirks)).toEqual([{ model: "triage-large" }]);
    expect(await savedModel(hub.transport)).toEqual({ endpoint: "https://inference.example/v1", model: "triage-large" });

    await saveInference(hub.transport, "t", { endpoint: "https://other.example/v1", model: "triage-small", secret: "sk-test" });
    expect(await savedModel(hub.transport)).toEqual({ endpoint: "https://other.example/v1", model: "triage-small" });
  });

  test("a saved model whose key is no longer active counts as no decision model", async () => {
    const hub = fakeHub([]);
    await saveInference(hub.transport, "t", { endpoint: "https://inference.example/v1", model: "triage-large", secret: "sk-test" });
    hub.keys[0]!.status = "expired";
    expect(await savedModel(hub.transport)).toBeUndefined();
  });
});

describe("loadPortal", () => {
  test("a failed code review place read leaves the other sections loaded", async () => {
    const hub = fakeHub(["anthropic"], new ApiError(500, "internal", "The hub could not list the places."));
    const snapshot = await loadPortal(hub.transport, ACCESS, async () => false);

    expect(snapshot).toMatchObject({ tenantName: "Acme", credentials: [{ name: "anthropic" }], codeReviewPlaceError: "The hub could not list the places." });
    expect(snapshot.codeReviewPlace).toBeUndefined();
  });
});
