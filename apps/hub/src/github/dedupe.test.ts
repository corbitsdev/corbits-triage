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

  test("a webhook delivered again after a hub restart is not triaged twice", () => {
    expect(new DeliveryCache({ filePath: file }).check("hook:del-1")).toBe(false);
    expect(new DeliveryCache({ filePath: file }).check("hook:del-1")).toBe(true);
  });
});
