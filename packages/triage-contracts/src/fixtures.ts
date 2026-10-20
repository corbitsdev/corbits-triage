import type { PRRecord } from "./types.js";

const titles = [
  "Preserve retry headers after a timeout",
  "Document workspace configuration",
  "Handle empty batches in the event queue",
  "Change default cache expiration",
  "Normalize Windows paths in the loader",
  "Add a package export for the parser",
  "Reduce startup allocations",
  "Refresh dependency lockfile",
  "Guard reconnect after cancellation",
  "Improve keyboard navigation",
];
const authors = ["maya", "eli", "sam", "jules", "ren", "alex"] as const;

function repoOf(i: number): string {
  if (i < 8) return "toolkit";
  if (i < 18) return "portal";
  return "engine";
}

function tierOf(i: number): PRRecord["tier"] {
  if (i % 3 === 0) return "external";
  if (i % 3 === 1) return "approved";
  return "internal";
}

function makeRecord(i: number): PRRecord {
  return {
    id: 284 + i,
    repo: repoOf(i),
    title: titles[i % titles.length] + (i >= 10 ? ` · ${Math.floor(i / 10) + 1}` : ""),
    body: "Routine change with tests.",
    author: authors[i % 6],
    tier: tierOf(i),
    revision: `seed-${i + 1}`,
    state: "open",
    draft: i % 13 === 0,
    conflicts: i % 11 === 0,
    checks: i % 9 !== 0,
    duplicate: Number(((i * 17 % 100) / 100).toFixed(2)),
    spam: Number(((i * 7 % 100) / 100).toFixed(2)),
    confidence: Number((0.35 + ((i * 13) % 65) / 100).toFixed(2)),
    lines: 20 + i * 31,
    path: i % 3 === 1 ? "docs/setup.md" : "src/runtime.ts",
  };
}

export const fixtures: PRRecord[] = Array.from({ length: 50 }, (_, i) => makeRecord(i));

export const holdbackSet: PRRecord[] = fixtures.slice(0, 50);

/** A run trigger as the stock workflow host stores it: the decoded Mail of the deliverer's signed mail, one text/plain part holding the request JSON. */
export function stockTriggerMail(request: Record<string, unknown>) {
  return {
    headers: { from: "github@acme.test", to: ["pr-triage@acme.test"] },
    rawHeaders: { from: ["github@acme.test"], to: ["pr-triage@acme.test"] },
    parts: [{ contentType: "text/plain", ref: "mail-part:///run_x/m1/0", text: JSON.stringify(request) }],
  };
}
