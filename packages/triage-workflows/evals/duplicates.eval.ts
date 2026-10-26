// Duplicates shortlist eval: which other open pull requests duplicates-open-pull-request would ask the judge about, on
// cases a shortlist must get right whatever the judge answers: a true duplicate is on it, and changes that share only a
// lockfile or common title words are not. No model is asked; how the judge rates the shortlist is unmeasured.
//
//   bun run eval:duplicates   (in packages/triage-workflows)
import { evaluate, type Case, type CheckFn } from "@corbits/evals";
import { overlapping, type OpenPull } from "../src/logic/duplicates.js";

type Input = { title: string; paths: string[]; others: OpenPull[] };
type Expect = { includes: number[]; excludes: number[] };

const UNRELATED_HOT = [11, 12, 13, 14, 15, 16, 17].map((number) => ({ number, title: `Tweak export ${number}`, paths: ["src/index.ts", `src/feature-${number}.ts`] }));

const cases: Array<Case<Input, Expect>> = [
  {
    name: "a true duplicate with the same files",
    input: { title: "Add rate limits to the login route", paths: ["src/login.ts", "src/login.test.ts"], others: [{ number: 9, title: "Rate limit login attempts", paths: ["src/login.ts", "src/login.test.ts"] }] },
    expect: { includes: [9], excludes: [] },
  },
  {
    name: "a true duplicate that also bumps the lockfile",
    input: { title: "Retry webhook deliveries", paths: ["src/webhooks.ts", "bun.lock"], others: [{ number: 9, title: "Retry failed webhook deliveries", paths: ["bun.lock", "src/webhooks.ts"] }] },
    expect: { includes: [9], excludes: [] },
  },
  {
    name: "a pull request sharing only the lockfile",
    input: { title: "Bump the parser", paths: ["package.json", "bun.lock"], others: [{ number: 9, title: "Upgrade the linter", paths: ["tooling/lint.json", "bun.lock"] }] },
    expect: { includes: [], excludes: [9] },
  },
  {
    name: "a duplicate among unrelated changes to a hot file",
    input: { title: "Read the auth token once", paths: ["src/index.ts", "src/auth.ts"], others: [...UNRELATED_HOT, { number: 18, title: "Cache the auth token", paths: ["src/auth.ts", "src/index.ts"] }] },
    expect: { includes: [18], excludes: [] },
  },
  {
    name: "a pull request stacked on another that names the same feature",
    input: { title: "Show the rate limit in settings", paths: ["web/settings.tsx"], others: [{ number: 9, title: "Add a rate limit setting", paths: ["src/settings.ts"] }] },
    expect: { includes: [9], excludes: [] },
  },
  {
    name: "a duplicate that moved the files",
    input: { title: "Paginate the audit log", paths: ["src/audit/list.ts"], others: [{ number: 9, title: "Paginate audit log entries", paths: ["src/audit-log.ts"] }] },
    expect: { includes: [9], excludes: [] },
  },
  {
    name: "titles that share only common words",
    input: { title: "Update this pull request template", paths: [".github/pull_request_template.md"], others: [{ number: 9, title: "Fix this with more tests", paths: ["src/a.test.ts"] }] },
    expect: { includes: [], excludes: [9] },
  },
  {
    name: "titles that share one word",
    input: { title: "Retry webhook deliveries", paths: ["src/webhooks.ts"], others: [{ number: 9, title: "Document webhook setup", paths: ["docs/setup.md"] }] },
    expect: { includes: [], excludes: [9] },
  },
];

function shortlist(input: Input): Promise<number[]> {
  return Promise.resolve(overlapping(input.title, input.paths, input.others).map((pull) => pull.number));
}

const includes: CheckFn<Input, number[], Expect> = function includes({ output, expect }) {
  const pass = expect!.includes.every((number) => output.includes(number));
  return { pass, value: pass ? 1 : 0, explanation: output.join(", ") };
};

const excludes: CheckFn<Input, number[], Expect> = function excludes({ output, expect }) {
  const pass = expect!.excludes.every((number) => !output.includes(number));
  return { pass, value: pass ? 1 : 0, explanation: output.join(", ") };
};

await evaluate("duplicates-shortlist", { run: shortlist, cases, checks: { includes, excludes }, concurrency: 1, timeout: "10s" });
