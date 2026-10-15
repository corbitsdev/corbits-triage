// Writes cases.jsonl from labels.json and the fixtures: each labelled pull request as merged, without its docs where it
// needs them, and the labelled mixes of two unrelated pull requests. Needs an authenticated `gh` CLI on first use.
//
//   bun packages/triage-workflows/evals/generate-cases.ts
import { readFileSync, writeFileSync } from "node:fs";
import { isDocPath } from "../../triage-contracts/src/paths.js";
import { variant, type CaseInput, type Expected, type JudgeCase, type Labels, type Snapshot } from "./cases.js";
import { fixture } from "./fixtures.js";

const here = new URL(".", import.meta.url).pathname;
const labels = JSON.parse(readFileSync(`${here}labels.json`, "utf8")) as Labels;

/** The verdict fails when any judged rule is expected to fail. */
function expected(pr: Snapshot, needsDocs: boolean, focused: Expected["focused"]): Expected {
  const docs = needsDocs && !pr.files.some((file) => isDocPath(file.filename)) ? "fail" : "pass";
  return { docs, focused, verdict: docs === "fail" || focused === "fail" ? "fail" : "pass" };
}

const pulls = new Map<number, Snapshot>();
for (const key of Object.keys(labels.pulls)) pulls.set(Number(key), fixture(Number(key)));

const cases: JudgeCase[] = [];
function add(id: string, input: CaseInput, needsDocs: boolean, focused: Expected["focused"]) {
  const base = pulls.get(input.pull)!;
  const pr = variant(base, input, input.mix === undefined ? undefined : pulls.get(input.mix));
  cases.push({ name: id, input, expect: expected(pr, needsDocs, focused) });
}
for (const [key, label] of Object.entries(labels.pulls)) {
  const pull = Number(key);
  const pr = pulls.get(pull)!;
  add(key, { pull }, label.needsDocs, "pass");
  if (label.needsDocs && pr.files.some((file) => isDocPath(file.filename))) add(`${key}-no-docs`, { pull, drop: "docs" }, true, "pass");
}
for (const [pull, mix] of labels.mixes) {
  add(`${pull}+${mix}`, { pull, mix }, labels.pulls[pull]!.needsDocs || labels.pulls[mix]!.needsDocs, "fail");
}
for (const [pull, mix] of labels.describedMixes) {
  add(`${pull}+${mix}-described`, { pull, mix, described: true }, labels.pulls[pull]!.needsDocs || labels.pulls[mix]!.needsDocs, "fail");
}
writeFileSync(`${here}cases.jsonl`, `${cases.map((row) => JSON.stringify(row)).join("\n")}\n`);
console.log(`${cases.length} cases`);
