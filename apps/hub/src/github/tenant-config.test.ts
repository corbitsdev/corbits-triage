// SPDX-License-Identifier: GPL-2.0-only
import { describe, expect, test } from "bun:test";
import { patchCorbitsTriage, prepareCorbitsTriagePatch, type CorbitsTriageNs } from "./tenant-config.js";

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

  test("a stale portal rev is rejected with 409 config_conflict", async () => {
    const db = stubDb({ corbitsTriage: { rev: 2, repos: [] } });
    const res = await prepareCorbitsTriagePatch(db, TENANT_ID, patchRequest({ config: { corbitsTriage: { rev: 1, repos: [] } } }));
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(409);
    expect(await (res as Response).json()).toEqual({ error: "config_conflict" });
  });

  test("a matching portal rev is rewritten to current+1 and passed through", async () => {
    const db = stubDb({ other: true, corbitsTriage: { rev: 3, repos: [{ name: "keep/me", connected: true }] } });
    const prepared = await prepareCorbitsTriagePatch(db, TENANT_ID, patchRequest({
      name: "Acme",
      config: { other: true, corbitsTriage: { rev: 3, repos: [] } },
    }));
    expect(prepared).toBeInstanceOf(Request);
    expect(await (prepared as Request).json()).toEqual({
      name: "Acme",
      config: { other: true, corbitsTriage: { rev: 4, repos: [] } },
    });
  });
});
