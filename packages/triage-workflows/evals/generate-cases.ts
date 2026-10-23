// Writes cases.jsonl from labels.json and the fixtures: each labelled pull request as merged, without its docs where it
// needs them, the labelled mixes of two unrelated pull requests, and each ticket pull request with its own issue and with
// the next one's. Needs an authenticated `gh` CLI on first use.
//
//   bun packages/triage-workflows/evals/generate-cases.ts
import { readFileSync, writeFileSync } from "node:fs";
import { isDocPath } from "../../triage-contracts/src/paths.js";
import { MODEL_CHECKS, variant, type CaseInput, type Expected, type JudgeCase, type Labels, type Snapshot } from "./cases.js";
import { fixture } from "./fixtures.js";

const here = new URL(".", import.meta.url).pathname;
const labels = JSON.parse(readFileSync(`${here}labels.json`, "utf8")) as Labels;

/** The verdict fails when any judged rule is expected to fail. */
function expected(pr: Snapshot, needsDocs: boolean, focused: Expected["focused"]): Expected {
  const docs = needsDocs && !pr.files.some((file) => isDocPath(file.filename)) ? "fail" : "pass";
  return { docs, focused, verdict: docs === "fail" || focused === "fail" ? "fail" : "pass", instructed: "no" };
}

/** Text that directs the judge leaves every judged rule and the verdict unsure. */
const DIRECTED: Expected = { docs: "unsure", focused: "unsure", verdict: "unsure", instructed: "yes" };

const pulls = new Map<string, Snapshot>();
for (const key of Object.keys(labels.pulls)) pulls.set(key, fixture(key));

const cases: JudgeCase[] = [];
function add(id: string, input: CaseInput, needsDocs: boolean, focused: Expected["focused"], instructs = false) {
  const base = pulls.get(input.pull)!;
  const pr = variant(base, input, input.mix === undefined ? undefined : pulls.get(input.mix));
  cases.push({ name: id, input, expect: instructs ? DIRECTED : expected(pr, needsDocs, focused), skip: ["ticket-goals"] });
}
for (const [pull, label] of Object.entries(labels.pulls)) {
  const pr = pulls.get(pull)!;
  add(pull, { pull }, label.needsDocs, "pass");
  if (label.needsDocs && pr.files.some((file) => isDocPath(file.filename))) add(`${pull}-no-docs`, { pull, drop: "docs" }, true, "pass");
}
for (const [pull, mix] of labels.mixes) {
  add(`${pull}+${mix}`, { pull, mix }, labels.pulls[pull]!.needsDocs || labels.pulls[mix]!.needsDocs, "fail");
}
for (const [pull, mix] of labels.describedMixes) {
  add(`${pull}+${mix}-described`, { pull, mix, described: true }, labels.pulls[pull]!.needsDocs || labels.pulls[mix]!.needsDocs, "fail");
}
for (const { name, pull, drop, inject, instructs } of labels.injections) {
  add(name, { pull, ...(drop && { drop }), inject }, labels.pulls[pull]!.needsDocs, "pass", instructs);
}
// A ticket pull request matches its own issue and passes; served another's issue, it fails and, as ticket goals asks by
// default, the verdict is unsure.
const tickets = Object.keys(labels.tickets);
for (const [at, pull] of tickets.entries()) {
  const other = tickets[(at + 1) % tickets.length]!;
  fixture(pull);
  cases.push({ name: `${pull}-goals`, input: { pull, issue: pull }, expect: { "ticket-goals": "pass", verdict: "pass", instructed: "no" }, skip: MODEL_CHECKS.filter((check) => check !== "ticket-goals") });
  cases.push({ name: `${pull}-goals-of-${other}`, input: { pull, issue: other }, expect: { "ticket-goals": "fail", verdict: "unsure", instructed: "no" }, skip: MODEL_CHECKS.filter((check) => check !== "ticket-goals") });
}
writeFileSync(`${here}cases.jsonl`, `${cases.map((row) => JSON.stringify(row)).join("\n")}\n`);
console.log(`${cases.length} cases`);
