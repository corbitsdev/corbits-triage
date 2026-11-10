// Targeted verifier A/B replay; fixed candidates isolate reconciliation from finder recall.
// bun --conditions=intx-src packages/pr-code-review-anthropic/evals/history.eval.ts fixtures.json baseline.txt results.json
import { readFileSync, writeFileSync } from "node:fs";
import { type } from "arktype";
import { PreviousReview } from "@corbits/triage-contracts";
import { candidates, checks, review, reviewInputFor, Verdict } from "@corbits/pr-code-review/actions/review";
import { firstObject } from "@corbits/pr-code-review/findings";
import { costOf, priceKey, priceOf } from "../../triage-workflows/evals/prices.js";
import { ANTHROPIC } from "../src/profile.js";

const Fixture = type({ id: "string", repeat: "number.integer > 0", expected: "'duplicate' | 'new' | 'regression' | 'not_real'", finding: { path: "string", start: "number", end: "number", title: "string", why: "string", trigger: "string", priority: "number" }, diff: "string", changes: "string", previous: PreviousReview, files: { "[string]": "string" } });
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
const MAX_OUTPUT = 4096;
const tools = [{ name: "read_file", description: "Read numbered lines from a pinned repository file.", input_schema: { type: "object", properties: { path: { type: "string" }, start: { type: "integer" }, end: { type: "integer" } }, required: ["path"], additionalProperties: false } }];
const Reply = type({ content: type({ type: "string", "text?": "string", "id?": "string", "name?": "string", "input?": { path: "string", "start?": "number", "end?": "number" } }).array(), usage: { input_tokens: "number", output_tokens: "number" } });

function callCost(input: number, output: number): number {
  const cost = costOf({ input, output, cacheRead: 0, cacheWrite: 0, thinking: 0 }, price);
  if (cost === null) throw new Error("eval requires known token prices");
  return cost;
}

function verdictOf(value: unknown): typeof Verdict.infer | undefined {
  const parsed = Verdict(value);
  return parsed instanceof type.errors ? undefined : parsed;
}

async function verify(system: string, text: string, files: Record<string, string>) {
  const messages: { role: string; content: unknown }[] = [{ role: "user", content: text }];
  for (let turn = 0; turn < 5; turn++) {
    const body = { model: ANTHROPIC.models.check, max_tokens: MAX_OUTPUT, output_config: { effort: ANTHROPIC.efforts.check }, system, messages, tools };
    // UTF-8 bytes upper-bound text tokens; reserve the maximum output before each request.
    const reserve = callCost(Buffer.byteLength(JSON.stringify(body)), MAX_OUTPUT);
    if (costUsd + reserve > LIMIT_USD) throw new Error("eval spend ceiling reached");
    const response = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Anthropic returned ${response.status}`);
    const answer = Reply.assert(await response.json());
    costUsd += callCost(answer.usage.input_tokens, answer.usage.output_tokens);
    writeFileSync(`${out}.responses.jsonl`, `${JSON.stringify(answer)}\n`, { flag: "a" });
    const calls = answer.content.filter((block) => block.type === "tool_use");
    if (calls.length === 0) {
      const text = answer.content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
      const verdict = firstObject(text, verdictOf);
      if (!verdict) throw new Error("verifier returned no verdict; see the saved responses");
      return verdict;
    }
    messages.push({ role: "assistant", content: answer.content });
    const replies = calls.map(function read(call) {
      if (call.name !== "read_file" || !call.id || !call.input) throw new Error("verifier requested an invalid read");
      const args = call.input;
      const file = files[args.path];
      const start = Math.max(1, args.start ?? 1);
      const end = Math.min(args.end ?? start + 199, start + 399);
      const content = file === undefined ? "File not supplied in this targeted replay; do not invent its contents." : file.split("\n").slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join("\n");
      return { type: "tool_result", tool_use_id: call.id, content, ...(file === undefined && { is_error: true }) };
    });
    messages.push({ role: "user", content: replies });
  }
  throw new Error("verifier exceeded replay turn limit");
}

for (const fixture of fixtures) {
  for (let repetition = 0; repetition < fixture.repeat; repetition++) {
    for (const mode of ["baseline", "patched"] as const) {
      const started = Date.now();
      const beforeCost = costUsd;
      const input = await reviewInputFor(ANTHROPIC)({ kind: "code-review", number: 1, title: "Review change", description: "", checkout: { source: "github", repo: "corbitsdev/corbits-builder", sha: "a".repeat(40) }, ...(mode === "patched" && { previous: fixture.previous }) });
      const folded = await candidates({ find: { output: [{ reply: JSON.stringify({ findings: [fixture.finding] }) }] } });
      const checked = await checks({ reviewInput: { output: input }, checkout: { output: { path: "", diff: fixture.diff, changes: fixture.changes, ...(mode === "patched" && { previous: fixture.previous }) } }, candidates: { output: folded } });
      const verdict = await verify(mode === "baseline" ? baseline : patched, checked.checks[0]!.text, fixture.files);
      const result = await review({ candidates: { output: folded }, checks: { output: checked }, check: { output: [{ reply: JSON.stringify(verdict) }] } });
      const posted = result.comments.filter((finding) => finding.thread === undefined).length;
      const observed = verdict.verdict === "real" ? verdict.history?.kind ?? "new" : verdict.verdict;
      const correct = observed === fixture.expected || (fixture.expected === "duplicate" && observed === "not_real");
      const postingCorrect = fixture.expected === "new" || fixture.expected === "regression" ? posted === 1 : posted === 0 && observed !== "unsure";
      const row = { id: fixture.id, repetition, mode, expected: fixture.expected, observed, correct, postingCorrect, posted, verdict, costUsd: costUsd - beforeCost, ms: Date.now() - started };
      results.push(row);
      writeFileSync(out, JSON.stringify({ model: ANTHROPIC.models.check, costUsd, scope: "Fixed-candidate verifier replay; supplied files only, not a full finder or host lifecycle eval", results }, null, 2));
      console.log(JSON.stringify({ id: row.id, repetition, mode, observed, correct, postingCorrect, posted, costUsd }));
    }
  }
}
