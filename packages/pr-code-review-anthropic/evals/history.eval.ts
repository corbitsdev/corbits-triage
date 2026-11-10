// Targeted verifier A/B replay; fixed candidates isolate reconciliation from finder recall.
// bun --conditions=intx-src packages/pr-code-review-anthropic/evals/history.eval.ts fixtures.json baseline.txt results.json
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { BaseEnv } from "@intx/agent";
import { checkoutsUnder, isBelow, repoReadUnder, REPO_READ_DEFINITIONS, rootedAt } from "@corbits/repo-read-tool";
import { TOOL_PROMPTS } from "@corbits/pr-code-review/prompts";
import { type } from "arktype";
import { PreviousReview } from "@corbits/triage-contracts";
import { candidates, checks, review, reviewInputFor, parseVerdict } from "@corbits/pr-code-review/actions/review";
import { budgetOf, Checkout, diffDirOf, writeDiff } from "@corbits/pr-code-review/actions/checkout";
import { firstObject } from "@corbits/pr-code-review/findings";
import { addRead, citesLineRead, linesShown } from "@corbits/pr-code-review/lines-read";
import { historyEntries } from "@corbits/pr-code-review/history";
import { costOf, priceKey, priceOf } from "../../triage-workflows/evals/prices.js";
import { ANTHROPIC } from "../src/profile.js";

const Fixture = type({
  id: "string",
  repeat: "number.integer > 0",
  expected: "'duplicate' | 'new' | 'regression' | 'not_real'",
  request: { number: "number.integer > 0", title: "string", description: "string", checkout: Checkout },
  finding: { path: "string", start: "number", end: "number", title: "string", why: "string", trigger: "string", priority: "number" },
  diff: "string",
  changes: "string | null",
  previous: PreviousReview,
  files: { "[string]": "string" },
});
const [fixturePath, baselinePath, out] = process.argv.slice(2);
if (!fixturePath || !baselinePath || !out) throw new Error("usage: history.eval.ts fixtures.json baseline.txt results.json");
const fixtures = Fixture.array().assert(JSON.parse(readFileSync(fixturePath, "utf8")));
const baseline = readFileSync(baselinePath, "utf8");
const patched = readFileSync(new URL("../../pr-code-review/prompts/check.system.txt", import.meta.url), "utf8");
const key = process.env.ANTHROPIC_API_KEY;
if (!key) throw new Error("ANTHROPIC_API_KEY is missing");
const headers = { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" };
const price = priceOf(priceKey("anthropic", ANTHROPIC.models.check));
const results: unknown[] = [];
let costUsd = 0;
const LIMIT_USD = 10;
const MAX_OUTPUT = 16_000;
const dataDir = mkdtempSync(join(tmpdir(), "review-history-eval-"));
const root = join(checkoutsUnder(dataDir), "repo");
const diffRoot = diffDirOf(root);
const reader = await repoReadUnder(() => dataDir)({} as BaseEnv);
const tools = REPO_READ_DEFINITIONS.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema }));
const Reply = type({ content: type({ type: "string", "text?": "string", "id?": "string", "name?": "string", "input?": "Record<string, unknown>" }).array(), usage: { input_tokens: "number", output_tokens: "number" } });

function callCost(input: number, output: number): number {
  const cost = costOf({ input, output, cacheRead: 0, cacheWrite: 0, thinking: 0 }, price);
  if (cost === null) throw new Error("eval requires known token prices");
  return cost;
}

async function prepareFiles(files: Record<string, string>, diff: string, changes: string | null, previous?: typeof PreviousReview.infer): Promise<void> {
  rmSync(root, { recursive: true, force: true });
  rmSync(diffRoot, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    if (name.startsWith("/diff/")) continue;
    const path = resolve(root, name);
    if (!isBelow(root, path)) throw new Error(`fixture path leaves the checkout: ${name}`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  await writeDiff(root, diff);
  if (previous) {
    if (changes !== null) writeFileSync(join(diffRoot, "since-review.patch"), changes);
    writeFileSync(join(diffRoot, "review-history.json"), JSON.stringify(historyEntries(previous), null, 2));
  }
}

async function verify(prompt: string, text: string) {
  const messages: { role: string; content: unknown }[] = [{ role: "user", content: text }];
  const system = `${prompt.trimEnd()}\n\n${TOOL_PROMPTS.check}`;
  const budget = budgetOf(text);
  if (budget === undefined) throw new Error("verifier input has no reading budget");
  const linesRead = linesShown(text);
  let spent = 0;
  for (let turn = 0; turn < 20; turn++) {
    const body = { model: ANTHROPIC.models.check, max_tokens: MAX_OUTPUT, output_config: { effort: ANTHROPIC.efforts.check }, system, messages, tools };
    // UTF-8 bytes upper-bound text tokens; reserve the maximum output before each request.
    const reserve = callCost(Buffer.byteLength(JSON.stringify(body)), MAX_OUTPUT);
    if (costUsd + reserve > LIMIT_USD) throw new Error("eval spend ceiling reached");
    const response = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Anthropic returned ${response.status}`);
    const answer = Reply.assert(await response.json());
    costUsd += callCost(answer.usage.input_tokens, answer.usage.output_tokens);
    spent += answer.usage.input_tokens + answer.usage.output_tokens;
    writeFileSync(`${out}.responses.jsonl`, `${JSON.stringify(answer)}\n`, { flag: "a" });
    const calls = answer.content.filter((block) => block.type === "tool_use");
    if (calls.length === 0) {
      const text = answer.content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
      const verdict = firstObject(text, parseVerdict);
      if (!verdict) throw new Error("verifier returned no verdict; see the saved responses");
      if (verdict.verdict !== "unsure" && !citesLineRead(verdict.reason, linesRead)) return { verdict: "unsure" as const, reason: "verifier cited no line it read" };
      return verdict;
    }
    if (spent >= budget) return { verdict: "unsure" as const, reason: "replay stopped at the production reading budget" };
    messages.push({ role: "assistant", content: answer.content });
    const replies = [];
    for (const call of calls) {
      const tool = tools.find((tool) => tool.name === call.name);
      if (!call.id || !call.input || !tool) throw new Error("verifier requested an invalid read");
      const result = await reader.run(rootedAt({ id: call.id, name: tool.name, arguments: call.input }, root, diffRoot), AbortSignal.timeout(30_000));
      addRead(linesRead, result);
      replies.push({ type: "tool_result", tool_use_id: call.id, content: JSON.stringify(result.content), ...(result.isError && { is_error: true }) });
    }
    messages.push({ role: "user", content: replies });
  }
  throw new Error("verifier exceeded replay turn limit");
}

try {
  for (const fixture of fixtures) {
    for (let repetition = 0; repetition < fixture.repeat; repetition++) {
      for (const mode of ["baseline", "patched"] as const) {
        await prepareFiles(fixture.files, fixture.diff, fixture.changes, mode === "patched" ? fixture.previous : undefined);
        const started = Date.now();
        const beforeCost = costUsd;
        const input = await reviewInputFor(ANTHROPIC)({ kind: "code-review", ...fixture.request, ...(mode === "patched" && { previous: fixture.previous }) });
        const folded = await candidates({ find: { output: [{ reply: JSON.stringify({ findings: [fixture.finding] }) }] } });
        const checked = await checks({ reviewInput: { output: input }, checkout: { output: { path: "", diff: fixture.diff, changes: fixture.changes, ...(mode === "patched" && { previous: fixture.previous }) } }, candidates: { output: folded } });
        const verdict = await verify(mode === "baseline" ? baseline : patched, checked.checks[0]!.text);
        const result = await review({ candidates: { output: folded }, checks: { output: checked }, check: { output: [{ reply: JSON.stringify(verdict) }] } });
        const posted = result.comments.filter((finding) => finding.thread === undefined).length;
        let observed: string = verdict.verdict === "real" ? verdict.history?.kind ?? "new" : verdict.verdict;
        if (result.dropped.length > 0) observed = result.dropped[0]!.verdict;
        const correct = observed === fixture.expected || (fixture.expected === "duplicate" && observed === "not_real");
        const postingCorrect = fixture.expected === "new" || fixture.expected === "regression" ? posted === 1 : posted === 0 && observed !== "unsure";
        const row = { id: fixture.id, repetition, mode, expected: fixture.expected, observed, correct, postingCorrect, posted, verdict, costUsd: costUsd - beforeCost, ms: Date.now() - started };
        results.push(row);
        writeFileSync(out, JSON.stringify({ model: ANTHROPIC.models.check, costUsd, scope: "Fixed-candidate verifier replay; supplied files only, not a full finder or host lifecycle eval", results }, null, 2));
        console.log(JSON.stringify({ id: row.id, repetition, mode, observed, correct, postingCorrect, posted, costUsd }));
      }
    }
  }
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
