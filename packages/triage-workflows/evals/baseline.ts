import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type } from "arktype";
import { addCost, priceOf, PRICES_AS_OF } from "./prices.js";

const tokens = { input: "number", output: "number", cacheRead: "number", cacheWrite: "number" } as const;
const rate = "number | 'unknown'";
const rates = type({ "+": "delete", input: rate, output: rate, cacheRead: rate, cacheWrite: rate });
const verdictWord = "'pass' | 'fail' | 'unsure'";

/** A code review case names the bugs it caught and missed and where each finding sat; a triage case, its verdict and each rule's answer. */
const outcome = type({
  "+": "delete",
  id: "string",
  failed: "boolean",
  "caught?": "string[]",
  "missed?": "string[]",
  "findings?": type({ "+": "delete", path: "string", line: "number", "priority?": "number", "bug?": "string" }).array(),
  "verdict?": verdictWord,
  "rules?": `Record<string, ${verdictWord}>`,
});

/** The only fields a baseline holds; anything else a run carries, keys, endpoints and model text included, is dropped. */
const baseline = type({
  "+": "delete",
  workflow: "string",
  eval: "string",
  date: "string",
  commit: "string",
  dirty: "boolean",
  pricesAsOf: "string",
  steps: { "[string]": { "+": "delete", provider: "string", model: "string" } },
  usage: {
    "[string]": {
      "+": "delete",
      ...tokens,
      price: { "+": "delete", source: "string", asOf: "string", price: rates, "long?": { "+": "delete", overPrompt: "number", price: rates } },
      costUsd: "number | null",
    },
  },
  costUsd: "number | null",
  cases: outcome.array(),
  totals: "Record<string, Record<string, number>>",
});

type Baseline = typeof baseline.infer;
type ModelUsage = Omit<Baseline["usage"][string], "price">;
/** What an eval reports: each `<provider>/<model>`'s usage, costed by the caller per call, null when a used rate is unknown. */
export type BaselineRun = Omit<Baseline, "date" | "commit" | "dirty" | "pricesAsOf" | "usage" | "costUsd"> & { usage: Record<string, ModelUsage> };
/** The checkout a baseline is measured at. */
export interface Stamp {
  commit: string;
  dirty: boolean;
}
type Visibility = (repo: string) => string;

function ghVisibility(repo: string): string {
  const { visibility } = JSON.parse(execFileSync("gh", ["api", `repos/${repo}`], { encoding: "utf8" })) as { visibility: string };
  return visibility;
}

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

/** Throws unless every repository is public, so a baseline never names a private repository's code. */
export function assertPublic(repos: Iterable<string>, visibilityOf: Visibility = ghVisibility) {
  const hidden = [...new Set(repos)].filter((repo) => visibilityOf(repo) !== "public");
  if (hidden.length > 0) throw new Error(`no baseline: ${hidden.join(", ")} not public`);
}

/** Before a baseline run: every repository public and the checkout clean, so the commit names the code measured. */
export function startBaseline(repos: Iterable<string>): Stamp {
  if (git("status", "--porcelain") !== "") throw new Error("no baseline: the working tree has uncommitted changes");
  assertPublic(repos);
  return { commit: git("rev-parse", "HEAD"), dirty: false };
}

function sorted<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

/** The baseline of `run`, stamped with its checkout, today and each model's price from the price table. */
export function baselineOf(run: BaselineRun, stamp: Stamp, date = new Date()): Baseline {
  const models = Object.values(run.usage);
  if (run.cases.length > 0 && models.length === 0) throw new Error("no baseline: cases ran but no model usage was recorded");
  const usage = sorted(Object.fromEntries(Object.entries(run.usage).map(([key, u]) => [key, { ...u, price: priceOf(key) }])));
  const cases = run.cases.map((c) => (c.rules ? { ...c, rules: sorted(c.rules) } : c));
  const costUsd = models.reduce<number | null>((total, u) => addCost(total, u.costUsd), 0);
  const out = baseline({ ...run, ...stamp, date: date.toISOString(), pricesAsOf: PRICES_AS_OF, steps: sorted(run.steps), usage, cases, costUsd: costUsd === null ? null : Number(costUsd.toFixed(4)) });
  if (out instanceof type.errors) throw new Error(`baseline: ${out.summary}`);
  return out;
}

export function writeBaseline(path: string, run: BaselineRun, stamp: Stamp) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(baselineOf(run, stamp), null, 2)}\n`);
}
