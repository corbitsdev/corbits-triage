import { describe, expect, test } from "bun:test";
import { MAX_BODY_BYTES } from "../read-json.js";
import { prepareCorbitsTriagePatch, tenantManager } from "./tenant-config.js";

const TENANT_ID = "tnt_test";

async function noGrant(): Promise<void> {}

async function allowAll(): Promise<boolean> {
  return true;
}

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
    const res = await tenantManager({ db: untouchable, getSession: signedIn, authorize: managesOnly }, TENANT_ID, new Headers());
    expect(res instanceof Response && res.status).toBe(401);
  });

  test("a non-member and a member without manage are refused 403; a manager passes as their principal", async () => {
    const headers = new Headers({ "x-user": "usr" });
    async function statusOf(principalId: string | undefined) {
      const res = await tenantManager({ db: memberDb(principalId), getSession: signedIn, authorize: managesOnly }, TENANT_ID, headers);
      return res instanceof Response ? res.status : res;
    }
    expect(await statusOf(undefined)).toBe(403);
    expect(await statusOf("prn_member")).toBe(403);
    expect(await statusOf("prn_admin")).toBe("prn_admin");
  });

  test("a body over the cap is refused 413 before the database is read", async () => {
    const res = await prepareCorbitsTriagePatch({ db: untouchable, authorize: allowAll, grantEnabled: noGrant, now: () => new Date() }, TENANT_ID, "prn_admin", new Request("https://hub.example/api/tenants/tnt_test", { method: "PATCH", body: "x".repeat(MAX_BODY_BYTES + 1) }));
    expect(res instanceof Response && res.status).toBe(413);
  });
});
