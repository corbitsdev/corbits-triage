import { describe, expect, test } from "bun:test";
import { ApiError, type Transport } from "@intx/hub-client";
import { loadPortal, type MemberAccess } from "./hub-api.ts";
import { saveInference } from "./model-catalog.ts";

type Row = Record<string, unknown> & { id: string };

function fakeHub(): Transport {
  const rows: Record<string, Row[]> = { providers: [], models: [], offerings: [] };
  const keys: Array<{ id: string; name: string; status: string }> = [];
  async function fetch<T>(method: string, url: string, body?: unknown): Promise<T> {
    const path = new URL(url, "http://hub").pathname;
    if (path === "/api/tenants/t/credentials" && method === "POST") {
      if (!keys.some((key) => key.id === "crd_saved")) keys.push({ id: "crd_saved", name: (body as { name: string }).name, status: "active" });
      return { id: "crd_saved" } as T;
    }
    if (path === "/api/tenants/t/credentials") return { data: keys, nextCursor: null } as T;
    if (path === "/api/tenants/t") return { id: "t", name: "Acme", slug: "acme", config: {} } as T;
    if (path === "/api/integrations/code-review/t/place") throw new ApiError(403, "forbidden", "forbidden");
    if (path === "/api/tenants/t/providers") return (method === "GET" ? { data: [], nextCursor: null } : { id: "vault_provider" }) as T;
    if (!path.includes("/catalog/")) throw new Error(`unexpected ${method} ${path}`);
    const kind = path.split("/catalog/")[1]!.split("/")[0]!;
    if (method === "GET") return { data: rows[kind], nextCursor: null } as T;
    if (method === "PATCH") {
      const existing = rows[kind]!.find((row) => path.endsWith(`/${row.id}`))!;
      Object.assign(existing, body);
      return existing as T;
    }
    const row = { id: `${kind}_${rows[kind]!.length + 1}`, ...(body as object) };
    rows[kind]!.push(row);
    return row as T;
  }
  return { fetch, subscribe: () => () => {} } as Transport;
}

const ACCESS: MemberAccess = { kind: "member", workspace: { tenantId: "t", principalId: "p", userId: "u" }, tenantName: "Acme", workspaces: [], invitations: [] };

async function savedModel(transport: Transport) {
  return (await loadPortal(transport, ACCESS)).decisionModel;
}

describe("saveInference", () => {
  test("stores the endpoint and model in the catalog, where the portal reads them back", async () => {
    const hub = fakeHub();
    await saveInference(hub, "t", { endpoint: "https://inference.example/v1", model: "triage-large", secret: "sk-test" });
    expect(await savedModel(hub)).toEqual({ endpoint: "https://inference.example/v1", model: "triage-large" });

    await saveInference(hub, "t", { endpoint: "https://other.example/v1", model: "triage-small", secret: "sk-test" });
    expect(await savedModel(hub)).toEqual({ endpoint: "https://other.example/v1", model: "triage-small" });
  });
});
