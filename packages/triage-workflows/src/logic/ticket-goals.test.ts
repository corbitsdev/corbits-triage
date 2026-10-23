import { describe, expect, test } from "bun:test";
import { emptyPack } from "@corbits/triage-contracts";
import { deriveState, ticketTarget, type PrFacts, type Ticket } from "./checks.ts";
import { goalKind, ticketGoals } from "./extract.ts";
import { NO_FACTS } from "./item.ts";
import { prepareQualityEvaluation } from "./quality.ts";
import { parseAnswers, renderVerdict } from "./render.ts";

describe("ticket goals extraction", () => {
  test("list items under an Acceptance criteria or Outcome heading win over a template's checkboxes", () => {
    expect(ticketGoals("- [ ] I searched existing issues\n# Background\n- context\n## Acceptance criteria\n1. Reads the issue\n- [ ] Fails closed\n## Notes\n- not a goal")).toEqual(["Reads the issue", "Fails closed"]);
  });

  test("without such a heading, checkbox items outside code blocks and comments", () => {
    expect(ticketGoals("- Not a box\n- [ ] Add the route\n* [x] Update docs.\n```\n- [ ] in code\n```\n<!-- - [ ] hidden -->")).toEqual(["Add the route", "Update docs."]);
  });

  test("none, and at most ten", () => {
    expect(ticketGoals("Just prose.\n- a list item")).toEqual([]);
    expect(ticketGoals(Array.from({ length: 12 }, (_, at) => `- [ ] goal ${at}`).join("\n"))).toHaveLength(10);
  });
});

describe("goal kind", () => {
  test("leaves passing checks to CI, live or manual steps to a person, and the rest to code review", () => {
    expect(["`bun run check` passes.", "`apps/web/src/deck-templates.test.ts` still passes, and covers the surviving parser."].map(goalKind)).toEqual(["ci", "ci"]);
    expect(["Verified live on a throwaway hub:", "No visual change in the running app.", "The old deployment is ended, not left live beside it."].map(goalKind)).toEqual(["outside", "outside", "outside"]);
    expect(["The ended run is revived on the first decision after delivery", "A test in `contracts.test.ts` covers it", "On a difference, it deploys the new code"].map(goalKind)).toEqual(["code", "code", "code"]);
  });
});

describe("ticket target", () => {
  const facts = { repo: "acme/widgets", title: "Add route", body: "", commits: [], branch: "main" };

  test("closing references first, then the rest, only in this repository", () => {
    expect(ticketTarget({ ...facts, body: "Follow-up to #45. Closes #12" }, "github")).toEqual({ numbers: [12, 45] });
    expect(ticketTarget({ ...facts, body: "See https://github.com/acme/widgets/issues/4", branch: "7-route" }, "github")).toEqual({ numbers: [4, 7] });
  });

  test("says why when there is nothing it can read", () => {
    expect(ticketTarget({ ...facts, body: "See https://github.com/acme/api/issues/4" }, "github")).toEqual({ problem: "linked issue acme/api#4 is in another repository" });
    expect(ticketTarget(facts, "github")).toEqual({ problem: "pull request does not reference an issue" });
    expect(ticketTarget({ ...facts, body: "Closes ENG-12" }, "github")).toEqual({ problem: "ENG-12 is a Linear issue, which can't be read" });
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
  const ticket: Ticket = { issue: "#12", title: "Add a route", goals: ["Add the route", "`bun run check` passes", "Verified live on a throwaway hub"] };

  test("asks one question with the issue's title and code goals beside the diff, never the author's body", () => {
    const { requests } = verdictFor(ticket);
    expect(requests.map((request) => request.questions.map((q) => q.id))).toEqual([["ticket-goals", "instructed"]]);
    expect(requests[0]!.state).toMatchObject({ issue: { title: "Add a route", goals: ["Add the route"] }, pullRequest: { title: "Add route", body: "", commits: [], files: [{ path: "src/a.ts" }] } });
  });

  test("passes or fails on that answer, listing each goal with where it is checked", () => {
    const goals = ["for code review: Add the route", "covered by CI: `bun run check` passes", "a person checks: Verified live on a throwaway hub"];
    expect(verdictFor(ticket, { "ticket-goals": 0.9 }).check).toMatchObject({ result: "pass", evidence: goals });
    expect(verdictFor(ticket, { "ticket-goals": 0.1 }).check).toMatchObject({ result: "fail", evidence: ["does not match #12", ...goals] });
    expect(verdictFor(ticket, { "ticket-goals": 0.5 }).check).toMatchObject({ result: "unconfirmed" });
  });

  test("is unconfirmed, saying why, when the issue can't be read, asking nothing", () => {
    const { requests, check } = verdictFor({ problem: "linked issue #12 could not be read" });
    expect(requests).toEqual([]);
    expect(check).toMatchObject({ result: "unconfirmed", reason: "linked issue #12 could not be read" });
  });
});
