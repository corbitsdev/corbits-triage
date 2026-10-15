import { describe, expect, test } from "bun:test";
import { MAX_BODY_BYTES } from "../read-json.js";
import { patchCorbitsTriage, prepareCorbitsTriagePatch, tenantManagerRefusal, type CorbitsTriageNs } from "./tenant-config.js";

const TENANT_ID = "tnt_test";

function stubDb(config: unknown) {
  const box = { config };
  const tx = {
    select() {
      return { from() { return { where() { return { async for() { return [{ id: TENANT_ID, config: box.config }]; } }; } }; } };
    },
    update() {
      return {
        set(values: { config?: unknown }) {
          return {
            async where() {
              if (values.config !== undefined) box.config = values.config;
            },
          };
        },
      };
    },
  };
  return {
    async transaction(fn: (value: typeof tx) => unknown) {
      return fn(tx);
    },
  } as never;
}

function patchRequest(body: unknown): Request {
  return new Request("https://hub.example/api/tenants/tnt_test", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function noGrant(): Promise<void> {}

function unchanged(ns: CorbitsTriageNs): CorbitsTriageNs {
  return ns;
}

describe("corbitsTriage rev CAS", () => {
  test("install-style patches bump rev from missing to 1 then 2", async () => {
    const db = stubDb({ corbitsTriage: { repos: [] } });
    expect((await patchCorbitsTriage(db, TENANT_ID, unchanged))?.rev).toBe(1);
    expect((await patchCorbitsTriage(db, TENANT_ID, unchanged))?.rev).toBe(2);
  });

  test("a stale portal rev is rejected with 409 config_conflict", async () => {
    const db = stubDb({ corbitsTriage: { rev: 2, repos: [] } });
    const res = await prepareCorbitsTriagePatch(db, TENANT_ID, patchRequest({ config: { corbitsTriage: { rev: 1, repos: [] } } }), noGrant);
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(409);
    expect(await (res as Response).json()).toEqual({ error: "config_conflict" });
  });

  test("a matching portal rev grants the GitHub repositories it switches on, then is rewritten to current+1 and passed through", async () => {
    const stored = [
      { name: "acme/off", connected: true, enabled: false },
      { name: "acme/on", connected: true, enabled: true },
      { name: "PROJ/repo", connected: true, source: "bitbucket-datacenter", enabled: false },
    ];
    const db = stubDb({ other: true, corbitsTriage: { rev: 3, repos: stored } });
    const repos = stored.map((record) => ({ ...record, enabled: true }));
    const granted: string[] = [];
    const prepared = await prepareCorbitsTriagePatch(db, TENANT_ID, patchRequest({
      name: "Acme",
      config: { other: true, corbitsTriage: { rev: 3, repos } },
    }), async function grant(_tx, repo) {
      granted.push(repo);
    });
    expect(granted).toEqual(["acme/off"]);
    expect(await (prepared as Request).json()).toEqual({
      name: "Acme",
      config: { other: true, corbitsTriage: { rev: 4, repos } },
    });
  });
});

const untouchable = new Proxy({}, {
  get() {
    throw new Error("database touched");
  },
}) as never;

function memberDb(principalId: string | undefined) {
  return { query: { principal: { async findFirst() { return principalId && { id: principalId }; } } } } as never;
}

async function signedIn(headers: Headers) {
  const id = headers.get("x-user");
  return id === null ? null : { user: { id } };
}

async function managesOnly(principalId: string, tenantId: string, resource: string, action: string) {
  return principalId === "prn_admin" && resource === `tenant:${tenantId}` && action === "manage";
}

describe("tenant PATCH guard", () => {
  test("an anonymous caller is refused 401 before the database is read", async () => {
    const res = await tenantManagerRefusal({ db: untouchable, getSession: signedIn, authorize: managesOnly }, TENANT_ID, new Headers());
    expect(res?.status).toBe(401);
  });

  test("a non-member and a member without manage are refused 403; a manager passes", async () => {
    const headers = new Headers({ "x-user": "usr" });
    expect((await tenantManagerRefusal({ db: memberDb(undefined), getSession: signedIn, authorize: managesOnly }, TENANT_ID, headers))?.status).toBe(403);
    expect((await tenantManagerRefusal({ db: memberDb("prn_member"), getSession: signedIn, authorize: managesOnly }, TENANT_ID, headers))?.status).toBe(403);
    expect(await tenantManagerRefusal({ db: memberDb("prn_admin"), getSession: signedIn, authorize: managesOnly }, TENANT_ID, headers)).toBeUndefined();
  });

  test("a body over the cap is refused 413 before the database is read", async () => {
    const res = await prepareCorbitsTriagePatch(untouchable, TENANT_ID, new Request("https://hub.example/api/tenants/tnt_test", { method: "PATCH", body: "x".repeat(MAX_BODY_BYTES + 1) }), noGrant);
    expect(res instanceof Response && res.status).toBe(413);
  });
});
