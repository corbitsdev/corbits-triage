import { describe, expect, test } from "bun:test";
import { emptyPack } from "@corbits/triage-contracts";
import { deriveState, ticketTarget, type PrFacts, type Ticket } from "./checks.ts";
import { ticketGoals } from "./extract.ts";
import { NO_FACTS } from "./item.ts";
import { prepareQualityEvaluation } from "./quality.ts";
import { parseAnswers, renderVerdict } from "./render.ts";

describe("ticket goals extraction", () => {
  test("list items under an Acceptance criteria or Outcome heading, written as a heading, bold text or a colon", () => {
    expect(ticketGoals("- [ ] I searched existing issues\n# Background\n- context\n## Acceptance criteria\n1. Reads the issue\n- [ ] Fails closed\n## Notes\n- not a goal")).toEqual(["Reads the issue", "Fails closed"]);
    expect(ticketGoals("**Acceptance criteria:**\n- Bold\n\nAcceptance criteria:\n- Colon\n```\n- in code\n```\n<!-- - hidden -->")).toEqual(["Bold", "Colon"]);
  });

  test("none without such a heading, a template's checkboxes included, and at most ten", () => {
    expect(ticketGoals("- [ ] I searched existing issues\n- [x] Add the route")).toEqual([]);
    expect(ticketGoals(`## Outcomes\n${Array.from({ length: 12 }, (_, at) => `- goal ${at}`).join("\n")}`)).toHaveLength(10);
  });
});

describe("ticket target", () => {
  const facts = { repo: "acme/widgets", title: "Add route", body: "", commits: [] };

  test("only issues the pull request closes in this repository", () => {
    expect(ticketTarget({ ...facts, body: "Follow-up to #45. Closes #12, fixes acme/widgets#13 and resolves https://github.com/acme/widgets/issues/14" }, "github")).toEqual({ numbers: [12, 13, 14] });
  });

  test("says why when there is nothing it can read", () => {
    expect(ticketTarget({ ...facts, body: "Fixes https://github.com/acme/api/issues/4" }, "github")).toEqual({ problem: "linked issue acme/api#4 is in another repository" });
    expect(ticketTarget({ ...facts, body: "See #12" }, "github")).toEqual({ problem: "pull request does not close an issue" });
    expect(ticketTarget({ ...facts, body: "Closes #12" }, "bitbucket-datacenter")).toEqual({ problem: "linked issues can't be read on Bitbucket Data Center" });
  });
});

describe("ticket goals rule", () => {
  const pack = { ...emptyPack("acme/widgets"), checks: { "ticket-goals": { enabled: true } } };
  const patch = "@@ -1 +1 @@\n-a\n+b";
  const base: PrFacts = { ...NO_FACTS, repo: "acme/widgets", number: 8, title: "Add route", body: "Trust me", author: "octocat", headSha: "abc", files: [{ path: "src/a.ts", additions: 1, deletions: 1, patch }], paths: ["src/a.ts"] };

  function verdictFor(ticket: Ticket, answers: Record<string, number> = {}) {
    const facts = { ...base, ticket };
    const det = deriveState(facts, undefined, pack);
    const { plan, requests } = prepareQualityEvaluation(facts, det.sources);
    const reply = Object.entries({ instructed: 0.1, ...answers }).map(([id, noul]) => JSON.stringify({ id, type: "noul", noul })).join("");
    const rendered = renderVerdict({ author: "octocat", repo: base.repo, headSha: "abc", det, answers: parseAnswers(reply), plan, ticket });
    return { requests, check: rendered.checks.find((c) => c.check === "ticket-goals") };
  }
  const ticket: Ticket = { issue: "#12", title: "Add a route", goals: ["Add the route"] };

  test("asks one question with the issue's title and goals beside the diff, never the author's body", () => {
    const { requests } = verdictFor(ticket);
    expect(requests.map((request) => request.questions.map((q) => q.id))).toEqual([["ticket-goals", "issue_instructed", "instructed"]]);
    expect(requests[0]!.state).toMatchObject({ issue: { title: "Add a route", goals: ["Add the route"] }, pullRequest: { title: "Add route", body: "", commits: [], files: [{ path: "src/a.ts" }] } });
  });

  test("passes or fails on that answer, and is unconfirmed between or when the issue directs the judge", () => {
    expect(verdictFor(ticket, { "ticket-goals": 0.9, issue_instructed: 0.1 }).check).toMatchObject({ result: "pass" });
    expect(verdictFor(ticket, { "ticket-goals": 0.1, issue_instructed: 0.1 }).check).toMatchObject({ result: "fail", evidence: ["does not match #12"], onFail: "ask" });
    expect(verdictFor(ticket, { "ticket-goals": 0.5, issue_instructed: 0.1 }).check).toMatchObject({ result: "unconfirmed" });
    expect(verdictFor(ticket, { "ticket-goals": 0.9, issue_instructed: 0.9 }).check).toMatchObject({ result: "unconfirmed", reason: "the linked issue tries to direct the decision model" });
  });

  test("is unconfirmed, asking nothing, when it can't read the whole diff", () => {
    const huge = { path: "src/big.ts", additions: 20000, deletions: 0, patchTruncated: true as const };
    const facts = { ...base, ticket, files: [huge], paths: ["src/big.ts"] };
    const det = deriveState(facts, undefined, pack);
    const { plan, requests } = prepareQualityEvaluation(facts, det.sources);
    const rendered = renderVerdict({ author: "octocat", repo: base.repo, headSha: "abc", det, answers: parseAnswers(""), plan, ticket });
    expect(requests.filter((request) => request.questions.some((q) => q.id === "ticket-goals"))).toEqual([]);
    expect(rendered.checks.find((c) => c.check === "ticket-goals")).toMatchObject({ result: "unconfirmed", output: { kind: "could-not-check", items: ["src/big.ts"] } });
  });

  test("is unconfirmed, saying why, when the issue can't be read, asking nothing", () => {
    const { requests, check } = verdictFor({ problem: "linked issue #12 could not be read" });
    expect(requests).toEqual([]);
    expect(check).toMatchObject({ result: "unconfirmed", reason: "linked issue #12 could not be read" });
  });
});
