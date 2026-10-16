import { expect, test } from "bun:test";
import { cachedLoads, checkTarget } from "./host-reads";

const SHA = "0123456789abcdef0123456789abcdef01234567";

test("refuses targets that leave the host API path", () => {
  expect(() => checkTarget("o/r", SHA, "src/a.ts")).not.toThrow();
  for (const path of ["../../user/installations", "src/../../x", "/etc/passwd", "src//a.ts"]) {
    expect(() => checkTarget("o/r", SHA, path)).toThrow("not a path relative");
  }
  for (const repo of ["../../user", "o/%2e%2e", "o\\..", "o"]) expect(() => checkTarget(repo, SHA)).toThrow("not an owner/name");
  expect(() => checkTarget("o/r", "main&x=1")).toThrow("40 hex");
});

test("a failed load is tried again", async () => {
  const load = cachedLoads<string>();
  let calls = 0;
  async function flaky() {
    calls++;
    if (calls === 1) throw new Error("502");
    return "text";
  }
  await expect(load("k", flaky)).rejects.toThrow("502");
  expect(await load("k", flaky)).toBe("text");
  expect(await load("k", flaky)).toBe("text");
  expect(calls).toBe(2);
});
