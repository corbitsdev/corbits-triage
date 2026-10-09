import { ApiError, type Transport } from "@intx/hub-client";

export type FakeArtifact = { id: string; title: string; content: string; version: number; updatedAt: number };

export type FakeHub = {
  transport: Transport;
  artifacts: FakeArtifact[];
  config: Record<string, unknown>;
  /** Every request, as `METHOD path`. */
  requests: string[];
};

/**
 * The artifact routes as the hub serves them: listings ordered newest first,
 * `query` matched against title or content, `limit` paging with `nextCursor`,
 * create never refuses a duplicate title, and `expectedVersion` answers 409.
 */
export function fakeHub(artifacts: FakeArtifact[] = [], config: Record<string, unknown> = {}): FakeHub {
  const hub: FakeHub = { artifacts, config, requests: [], transport: { fetch, subscribe: () => () => {} } };
  let clock = Math.max(0, ...artifacts.map((row) => row.updatedAt));
  let created = 0;
  function freshId(): string {
    let id = `art_${++created}`;
    while (hub.artifacts.some((row) => row.id === id)) id = `art_${++created}`;
    return id;
  }
  async function fetch<T>(method: string, path: string, body?: unknown): Promise<T> {
    hub.requests.push(`${method} ${path}`);
    if (method === "GET" && path === "/api/tenants/t") return { id: "t", name: "Tenant", slug: "t", config: hub.config } as T;
    if (method === "PATCH" && path === "/api/tenants/t") {
      hub.config = (body as { config: Record<string, unknown> }).config;
      return undefined as T;
    }
    if (method === "GET" && path.startsWith("/api/tenants/t/artifacts?")) {
      const url = new URL(path, "http://hub");
      const query = (url.searchParams.get("query") ?? "").toLowerCase();
      const hits = [...hub.artifacts]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .filter((row) => row.title.toLowerCase().includes(query) || row.content.toLowerCase().includes(query));
      const at = Number(url.searchParams.get("cursor") ?? 0);
      const limit = Number(url.searchParams.get("limit"));
      return {
        artifacts: hits.slice(at, at + limit).map(({ id, title }) => ({ id, title })),
        nextCursor: at + limit < hits.length ? String(at + limit) : null,
      } as T;
    }
    if (method === "GET" && path.startsWith("/api/tenants/t/artifacts/")) {
      const id = decodeURIComponent(path.split("/").at(-1) ?? "");
      return { artifact: hub.artifacts.find((row) => row.id === id) } as T;
    }
    if (method === "POST" && path === "/api/tenants/t/artifacts") {
      const posted = body as { title: string; content: string };
      const row = { id: freshId(), title: posted.title, content: posted.content, version: 1, updatedAt: ++clock };
      hub.artifacts.push(row);
      return { artifact: row } as T;
    }
    if (method === "POST" && path.endsWith("/versions")) {
      const id = decodeURIComponent(path.split("/").at(-2) ?? "");
      const row = hub.artifacts.find((item) => item.id === id);
      if (!row) throw new ApiError(404, "not_found", "No such artifact.");
      const posted = body as { content: string; expectedVersion?: number };
      if (posted.expectedVersion !== undefined && posted.expectedVersion !== row.version) {
        throw new ApiError(409, "conflict", "expectedVersion did not match the current version");
      }
      row.content = posted.content;
      row.version += 1;
      row.updatedAt = ++clock;
      return { artifactId: id, version: row.version } as T;
    }
    throw new Error(`unexpected ${method} ${path}`);
  }
  return hub;
}
