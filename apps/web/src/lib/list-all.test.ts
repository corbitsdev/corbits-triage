import { expect, test } from "bun:test";
import type { Transport } from "@intx/hub-client";
import { listPrincipals } from "./hub-api.ts";

test("listAll follows nextCursor across data pages", async () => {
  const seen: string[] = [];
  const transport = {
    fetch: async (_method: string, path: string) => {
      seen.push(path);
      const cursor = new URL(path, "http://hub").searchParams.get("cursor");
      return (cursor ? { data: [{ id: "b" }], nextCursor: null } : { data: [{ id: "a" }], nextCursor: "p2" }) as never;
    },
    subscribe: () => () => {},
  } as Transport;
  const rows = await listPrincipals(transport, "t");
  expect(rows.map((row) => row.id)).toEqual(["a", "b"]);
  expect(seen).toHaveLength(2);
});
