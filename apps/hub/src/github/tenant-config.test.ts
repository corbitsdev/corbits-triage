import { describe, expect, test } from "bun:test";
import { MAX_BODY_BYTES } from "../read-json.js";
import { guardTenantPatch, patchCorbitsTriage, tenantManagerRefusal, type CorbitsTriageNs } from "./tenant-config.js";

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

function unchanged(ns: CorbitsTriageNs): CorbitsTriageNs {
  return ns;
}

describe("corbitsTriage rev CAS", () => {
  test("install-style patches bump rev from missing to 1 then 2", async () => {
    const db = stubDb({ corbitsTriage: { repos: [] } });
    expect((await patchCorbitsTriage(db, TENANT_ID, unchanged))?.rev).toBe(1);
    expect((await patchCorbitsTriage(db, TENANT_ID, unchanged))?.rev).toBe(2);
  });
});

/** Fails the test when anything reads the database. */
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

  test("a body over the cap is refused 413", async () => {
    const res = await guardTenantPatch(new Request("https://hub.example/api/tenants/tnt_test", { method: "PATCH", body: "x".repeat(MAX_BODY_BYTES + 1) }));
    expect(res instanceof Response && res.status).toBe(413);
  });

  test("a body carrying corbitsTriage is refused 400; any other is passed on", async () => {
    const refused = await guardTenantPatch(patchRequest({ config: { corbitsTriage: { rev: 0 } } }));
    expect(refused instanceof Response && refused.status).toBe(400);
    const passed = await guardTenantPatch(patchRequest({ name: "Acme", config: { other: true } }));
    expect(passed instanceof Request && await passed.json()).toEqual({ name: "Acme", config: { other: true } });
  });
});
