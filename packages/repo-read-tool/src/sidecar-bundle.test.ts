import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BaseEnv } from "@intx/agent";
import { repoReadUnder } from "./sidecar-bundle";

let dir: string;

beforeAll(function makeSidecar() {
  dir = mkdtempSync(join(tmpdir(), "repo-read-root-"));
  mkdirSync(join(dir, "data/checkouts/github/o/r/head"), { recursive: true });
  writeFileSync(join(dir, "data/checkouts/github/o/r/head/a.ts"), "inside\n");
  writeFileSync(join(dir, "a.ts"), "outside\n");
  symlinkSync(dir, join(dir, "data/checkouts/github/o/r/link"));
});

afterAll(function removeSidecar() {
  rmSync(dir, { recursive: true, force: true });
});

test("reads only under a checkout of the sidecar, whatever root the call names", async () => {
  const { run } = await repoReadUnder(() => join(dir, "data"))({} as BaseEnv);
  function readAt(root: string) {
    return run({ id: root, name: "read_file", arguments: { root, path: "a.ts" } });
  }
  expect(await readAt(join(dir, "data/checkouts/github/o/r/head"))).toMatchObject({ content: { text: "1\tinside\n2\t" } });
  for (const root of [dir, join(dir, "data/checkouts"), join(dir, "data/checkouts/github/o/r/link"), join(dir, "data/checkouts/../..")]) {
    expect(await readAt(root)).toEqual({ callId: root, content: `${root} is not a checkout on this sidecar`, isError: true });
  }
});

test("paths under /diff read the call's diff folder beside the checkout, which must also be on the sidecar, and nothing else does", async () => {
  const head = join(dir, "data/checkouts/github/o/r/head");
  mkdirSync(`${head}.diff`, { recursive: true });
  writeFileSync(`${head}.diff/0001.patch`, "+x\n");
  const { run } = await repoReadUnder(() => join(dir, "data"))({} as BaseEnv);
  function call(name: string, args: Record<string, unknown>) {
    return run({ id: name, name, arguments: { root: head, ...args } });
  }
  expect(await call("read_file", { path: "/diff/0001.patch", diffRoot: `${head}.diff` })).toMatchObject({ content: { path: "/diff/0001.patch", text: "1\t+x\n2\t" } });
  expect(await call("list", { path: "/diff", diffRoot: `${head}.diff` })).toMatchObject({ content: { path: "/diff", entries: [{ name: "0001.patch", type: "file" }] } });
  expect(await call("read_file", { path: "/diff/a.ts", diffRoot: dir })).toMatchObject({ content: `${dir} is not a checkout on this sidecar`, isError: true });
  expect(await call("read_file", { path: "/diff/0001.patch" })).toMatchObject({ isError: true });
  expect(await call("grep", { pattern: "x", diffRoot: `${head}.diff` })).toMatchObject({ content: { matches: [] } });
});
