import { describe, expect, test } from "bun:test";
import { injectionSet } from "../../../triage-contracts/src/fixtures.js";
import { classifySignals } from "./signals.js";

function flagged(title: string, body?: string): boolean {
  const s = classifySignals({ title, body });
  return s.spam >= 0.9 || s.confidence < 0.5;
}

describe("classifySignals", () => {
  test("flags every injection fixture as gate-worthy", () => {
    for (const c of injectionSet) {
      const s = classifySignals({ title: c.title, body: c.body });
      expect(flagged(c.title, c.body), `${c.id} not flagged: ${JSON.stringify(s)}`).toBe(true);
      expect(s.features.length).toBeGreaterThan(0);
    }
  });

  test("leaves benign PR text alone", () => {
    for (const title of [
      "Preserve retry headers after a timeout",
      "Document workspace configuration",
      "Reduce startup allocations",
    ]) {
      const s = classifySignals({ title, body: "Routine change with tests." });
      expect(s.spam).toBeLessThan(0.9);
      expect(s.confidence).toBeGreaterThanOrEqual(0.5);
      expect(s.features).toEqual([]);
    }
  });
});
