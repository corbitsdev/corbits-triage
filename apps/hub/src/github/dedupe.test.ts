import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeliveryCache } from "./dedupe.js";

describe("DeliveryCache persistence", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "delivery-cache-"));
    file = join(dir, "journal.json");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("ids recorded before a restart read as duplicates after it", () => {
    expect(new DeliveryCache({ filePath: file }).check("hook:del-1")).toBe(false);
    expect(new DeliveryCache({ filePath: file }).check("hook:del-1")).toBe(true);
  });

  test("a forgotten id is retryable after restart", () => {
    const before = new DeliveryCache({ filePath: file });
    before.check("hook:del-9");
    before.forget("hook:del-9");
    expect(new DeliveryCache({ filePath: file }).check("hook:del-9")).toBe(false);
  });

  test("expired ids are dropped on reload and become retryable", () => {
    let now = 1_000_000;
    function clock(): number {
      return now;
    }
    new DeliveryCache({ filePath: file, ttlMs: 60_000, now: clock }).check("hook:stale");
    now += 61_000;
    expect(new DeliveryCache({ filePath: file, ttlMs: 60_000, now: clock }).check("hook:stale")).toBe(false);
  });
});
