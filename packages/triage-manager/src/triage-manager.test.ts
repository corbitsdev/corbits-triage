import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { actionConsumer } from "@intx/authz";
import { createActionCredentialsFactory, createCredentialProviderRegistry, createHttpCredentialProvider } from "@intx/harness";
import type { GrantRule } from "@intx/types/authz";
import { HUB_CREDENTIAL_HANDLE } from "@intx/types/credential-delivery";
import { runLocal, type ActionHandler, type LoopFn, type OnTriggerPrimitive, type WorkflowAuthorizeFn, type WorkflowDefinition } from "@intx/workflow";
import { ACTION_KINDS, APPROVE_DO_KIND, emptyPack, JUDGE_RULES_ATTACHMENT, VERDICT_LABELS, WAITING_LABELS, type ActionKind, type CheckPack } from "@corbits/triage-contracts";
import type { Snapshot } from "@corbits/triage-workflows/evals/cases";
import { fixtureGithub, triggerMail } from "@corbits/triage-workflows/evals/serve";
import { evaluate } from "@corbits/triage-workflows/actions/evaluate";
import { parts } from "@corbits/triage-workflows/actions/parts";
import { delivered, grantsFor, type Bindings, type Fetch } from "@corbits/triage-workflows/local-credentials";
import { recordingGithub, type Write } from "@corbits/triage-workflows/run-local";
import * as actions from "./actions/index.js";
import { manageMail } from "./actions/hub.js";
import * as loops from "./loops.js";
import { workflow as bitbucket } from "./triage-manager-bitbucket-datacenter.js";
import { workflow as github } from "./triage-manager-github.js";
import { workflow as listener } from "./triage-listener-github.js";

const TENANT = "tnt_acme";
const RUN = "run_manager";
const HUB_ORIGIN = "https://hub.test";
const TENANT_PATH = `/api/tenants/${TENANT}`;
const END = { method: "DELETE", path: `${TENANT_PATH}/workflows/runs/${RUN}` };
const DEPLOY = { method: "POST", path: `${TENANT_PATH}/workflows/deployments` };
const NOTE = { method: "POST", path: `${TENANT_PATH}/manager/deployed` };
const DEPLOYED = "run_deployed";
const STOP_REVIEW = { method: "DELETE", path: `${TENANT_PATH}/workflows/runs/${DEPLOYED}` };
/** The eval fixture's head. */
const HEAD = "e0a1".repeat(10);

const PR: Snapshot = {
  repo: "acme/widgets", number: 8, title: "Add the flag", body: "Adds the flag.", bodyHtml: "<p>Adds the flag.</p>", author: "octocat", commits: ["feat: add the flag"],
  files: [{ filename: "src/flag.ts", status: "added", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+export const flag = true;" }], docs: {},
};
const PULL = { source: "github", repo: PR.repo, number: PR.number };
const RULES: CheckPack = { ...emptyPack(PR.repo), checks: { "ci-green": { enabled: true } } };
const JUDGED: CheckPack = { ...emptyPack(PR.repo), checks: { focused: { enabled: true } } };
const BB_REPO = "ACME/widgets";
const BB_PULL = "/rest/api/1.0/projects/ACME/repos/widgets/pull-requests/8";
const BB_BUILDS = "/rest/build-status/1.0/commits/abc";

const RELEASE = { name: "pr-code-review-reviewer-github", workflow: { assetId: "ast_review", commitSha: "c0ffee", packageName: "@corbits/pr-code-review-anthropic", entry: "./pr-code-review-reviewer-github.mjs" }, offerings: { ids: ["off_a"], defaultId: "off_a" } };
const JUDGE_RELEASE = { workflow: { assetId: "ast_judge", commitSha: "c0ffee", packageName: "@corbits/triage-judge-github-workflow", entry: "./triage-judge-github.mjs" }, offerings: { ids: ["off_d"], defaultId: "off_d" } };
const CODE_REVIEW = { codeReview: { on: true, for: ["everyone"], triage: ["pass", "fail", "unsure"], rules: "any" }, blocks: ["code-review"] };
const REVIEW_REQUEST = { codeReviewRequest: { kind: "code-review", number: PR.number, title: PR.title, description: PR.body, checkout: { source: "github", repo: PR.repo, sha: HEAD } } };
const REVIEW = { summary: "One bug.", comments: [{ path: "src/flag.ts", start: 1, end: 1, title: "Always true", body: "The flag can never be off.", priority: 2 }], budgetExhausted: false, complete: true };
const LATER = "2999-01-01T00:00:00.000Z";
const reviewer = (deadline = LATER) => ({ kind: "code-review", head: HEAD, runId: DEPLOYED, deployedBy: RUN, deadline });

/** The pull request mail the hub records, as its bridge builds it; a manager reads it back through take. */
function hubRequest(pack: CheckPack, extra: Record<string, unknown> = {}, automatic: ActionKind[] = [...ACTION_KINDS]): Record<string, unknown> {
  return JSON.parse(triggerMail(PR, pack, { tenantId: TENANT, ...extra }, automatic).parts[0]!.text);
}

/** A mail the hub recorded for the pull request, as take answers it among a pass's events. */
function mailEvent(head: string, payload: Record<string, unknown>, key = "evt_1") {
  return { key, event: { type: "webhook", head, payload } };
}

const REQUEST = hubRequest(RULES);
/** The run claimed its pull request as the tests start, well inside its lifetime. */
const CLAIMED = new Date().toISOString();
const PASS = { outcome: "pass", pass: { id: "pass_1", head: HEAD, events: ["evt_1"], takenAt: "2026-10-25T00:00:00.000Z", takes: 1 }, events: [mailEvent(HEAD, REQUEST)], resumed: false, threads: [], request: REQUEST, reviewers: [], headSince: "2026-10-25T00:00:00.000Z", claimedAt: CLAIMED };
/** The one in-progress comment, posted or edited in place, naming what the head waits for. */
function inProgress(awaits: string) {
  return expect.objectContaining({ body: { body: expect.stringContaining(`Triage is waiting for ${awaits} before it decides.`) } });
}

const IDLE = { outcome: "idle", request: REQUEST, reviewers: [], headSince: "2026-10-25T00:00:00.000Z", claimedAt: CLAIMED };
const ENDED = { outcome: "ended" };
const REFUSED = 409;

/** A pass on which one of the manager's code reviews reported `reported`. */
function reported(reported: Record<string, unknown>, request = REQUEST) {
  return { ...PASS, request, events: [{ key: `evt:github:${PR.repo}#8:${DEPLOYED}`, event: { type: "reviewer-result", head: HEAD, payload: { kind: "code-review", ...reported } } }], reviewers: [reviewer()] };
}

const allow: WorkflowAuthorizeFn = async function allow() {
  return { effect: "allow", matchingGrants: [], resolvedBy: null };
};

type HubCall = { method: string; path: string; body?: unknown };
type HubAnswer = Record<string, unknown> | typeof REFUSED;

/** The hub's manager routes, answering each take and done in turn, its deploy route and its stop-run route. */
function fakeHub({ takes, dones = [] }: { takes: HubAnswer[]; dones?: HubAnswer[] }) {
  const calls: HubCall[] = [];
  function answer(next: HubAnswer | undefined): Response {
    if (next === undefined) throw new Error("the hub was asked more than the test expects");
    return next === REFUSED ? Response.json({ error: { code: "not_manager" } }, { status: 409 }) : Response.json(next);
  }
  async function hub(url: URL, init?: RequestInit): Promise<Response> {
    const method = init?.method ?? "GET";
    calls.push({ method, path: url.pathname, ...(init?.body !== undefined && { body: JSON.parse(String(init.body)) }) });
    if (url.pathname === `${TENANT_PATH}/manager/take`) return answer(takes.shift());
    if (url.pathname === `${TENANT_PATH}/manager/done`) return answer(dones.shift());
    if (method === "DELETE" && url.pathname.startsWith(`${TENANT_PATH}/workflows/runs/`)) return new Response(null, { status: 202 });
    if (method === DEPLOY.method && url.pathname === DEPLOY.path) return Response.json({ id: DEPLOYED }, { status: 201 });
    if (method === NOTE.method && url.pathname === NOTE.path) return Response.json({ noted: true });
    return Response.json({ error: { code: "not_found" } }, { status: 404 });
  }
  return { hub, calls };
}

/** The host's credentials as triage-workflows wires them, plus the hub credential deploy binds to the hub actions. */
function actionCredentials(bindings: Bindings, host: Fetch, hub: (url: URL, init?: RequestInit) => Promise<Response>) {
  const consumers = ["runsEnded", "take", "done", "deployReview", "deployJudge", "forward", "stop"].map(actionConsumer);
  const cell = delivered(bindings, [{ credentialId: "hub", providerKey: "http", origin: HUB_ORIGIN, secret: "run-token" }]);
  cell.current = { ...cell.current, bindings: [...cell.current.bindings, ...consumers.map((consumer) => ({ handle: HUB_CREDENTIAL_HANDLE, credentialId: "hub", consumer }))] };
  const hubGrants: GrantRule[] = consumers.map((tool, index) => ({ id: `hub-${index}`, resource: "credential:hub", action: "use", effect: "allow", origin: "system", conditions: { tool }, expiresAt: null, roleId: null, principalId: null }));
  async function routed(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(input instanceof Request ? input.url : input);
    return url.origin === HUB_ORIGIN ? hub(url, init) : host(url, init);
  }
  const providers = createCredentialProviderRegistry([createHttpCredentialProvider({ fetch: routed })]);
  return createActionCredentialsFactory({ materialCell: cell, resolveStepGrants: () => [...grantsFor(bindings), ...hubGrants], providers });
}

const loopFns = (ref: string) => (loops as Record<string, LoopFn>)[ref]!;

/** A clock a minute further on at every reading, so a pass's wait has passed by the time it is timed. */
function hurried() {
  let readings = 0;
  return function clock() {
    return new Date(Date.now() + ++readings * 60_000);
  };
}

/**
 * Runs one mail's body; the mail agent's director runs its one tool, so the mail it would send is recorded and answered
 * `mailed` in the `{ reply, turn }` a live agent step outputs. `delivers`, whether every mail goes, or whether each in
 * turn does; one that does not fails its step unless the agent tolerates it.
 */
async function runMail(definition: WorkflowDefinition, mail: unknown, host: Fetch, hub: ReturnType<typeof fakeHub>["hub"], mailed: unknown[] = [], delivers: boolean | readonly boolean[] = true, clock?: () => Date) {
  const body = (definition.steps.events as OnTriggerPrimitive).body;
  if (!("inline" in body)) throw new Error("the body is not inline");
  const { terminalStatus, outputs } = await runLocal(body.inline, {
    authorize: allow,
    hasUpstreamSignalResolver: true,
    invokeStep: async function mailAgent({ agent, input }) {
      if (!agent.id.startsWith("triage-mail")) throw new Error(`no agent but the mail agent runs, not ${agent.id}`);
      mailed.push(input);
      const goes = typeof delivers === "boolean" ? delivers : delivers[mailed.length - 1];
      if (!goes && agent.id !== "triage-mail-tolerant") throw new Error("mail: public key was not published by its readyBy");
      const reply = JSON.stringify(goes ? { mailed: true } : { mailed: false, error: "public key was not published by its readyBy" });
      return { output: { reply, turn: { role: "assistant", content: [{ type: "text", text: reply }] } } };
    },
    actionResolver: (ref) => (actions as Record<string, ActionHandler>)[ref]!,
    actionCredentials: actionCredentials((definition.credentialBindings ?? []) as Bindings, host, hub),
    loopFns,
    triggerPayload: mail,
    ...(clock && { clock }),
  }).complete;
  const passes = outputs["passes"] as { iterations: number; final: Record<string, unknown> } | undefined;
  const last = passes?.final ?? outputs;
  return { terminalStatus, stop: outputs["stop"], passes: passes?.iterations, outputs: last, ran: Object.keys(last).filter((id) => !(last[id] as { skipped?: true } | undefined)?.skipped).toSorted() };
}

/** The mail that wakes the manager's run, as its listener or one of its reviews sends it. */
function wake(pull: { source: string; repo: string; number: number } = PULL) {
  return { headers: { from: "run_listener@triage.test", to: [`${RUN}@triage.test`] }, parts: [{ contentType: "text/plain", text: manageMail(TENANT, pull) }] };
}

/**
 * The eval fixture's pull request, or `pr`, at `head`, with the base and head repositories a comment's write compares,
 * `pull`'s fields over the host's own, and `checkRuns` as the head's CI.
 */
function githubHost(head = HEAD, { pr = PR, pull = {}, checkRuns }: { pr?: Snapshot; pull?: Record<string, unknown>; checkRuns?: object[] } = {}) {
  const writes: Write[] = [];
  const fixture = fixtureGithub(pr, {});
  async function read(url: URL): Promise<Response> {
    if (checkRuns && url.pathname.endsWith("/check-runs")) return Response.json({ check_runs: checkRuns });
    if (/\/pulls\/\d+\/comments$/.test(url.pathname)) return Response.json([]);
    const response = await fixture(url);
    if (url.pathname !== `/repos/${PR.repo}/pulls/${PR.number}`) return response;
    const read = await response.json();
    return Response.json({ ...read, ...pull, head: { ...read.head, sha: head, repo: { id: 1 } }, base: { ...read.base, repo: { id: 1 } } });
  }
  return { writes, host: recordingGithub(read, writes) };
}

const TAKE = { method: "POST", path: `${TENANT_PATH}/manager/take`, body: PULL };
const DONE = { method: "POST", path: `${TENANT_PATH}/manager/done`, body: expect.objectContaining({ ...PULL, reviewers: [] }) };

/** What the pass reported to the hub as done. */
function doneBody(calls: readonly HubCall[]): Record<string, unknown> {
  return calls.find((call) => call.path === DONE.path)?.body as Record<string, unknown>;
}

/** A Bitbucket Data Center pull request at head `abc`, recording the build statuses posted on it. */
function bitbucketHost() {
  const builds: unknown[] = [];
  const ref = { id: "refs/heads/fix", displayId: "fix", latestCommit: "abc", repository: { id: 1 } };
  const pull = { id: 8, version: 0, state: "OPEN", fromRef: ref, toRef: { ...ref, id: "refs/heads/main" }, links: { self: [{ href: "https://bitbucket.acme.test/pr/8" }] }, author: { user: { id: 2, slug: "octocat" } }, reviewers: [], participants: [] };
  async function host(url: URL, init?: RequestInit): Promise<Response> {
    if (url.pathname === BB_PULL) return Response.json(pull);
    if (url.pathname !== BB_BUILDS) return Response.json({ message: "Server Error" }, { status: 500 });
    if (init?.method === "POST") builds.push(JSON.parse(String(init.body)));
    return Response.json({ values: [], isLastPage: true });
  }
  return { builds, host };
}

/** Publishes `release` as the release.json the hub writes beside the workflows; the repository's own holds none. */
function publish(release: Record<string, unknown>): void {
  mock.module(new URL("./release.json", import.meta.url).pathname, () => ({ default: release }));
}

afterEach(() => publish({}));
const READY = { method: "POST", path: `/repos/${PR.repo}/issues/${PR.number}/labels`, body: { labels: ["Triage: Ready"] } };
const POSTED_REVIEW = expect.objectContaining({ method: "POST", path: `/repos/${PR.repo}/pulls/${PR.number}/reviews` });

/** A Do the verdict on the fixture's head holds for approval, and the hub's mail approving it. */
async function heldApproval() {
  const hi = [{ do: "comment" as const, target: { body: "hi" } }];
  const held: CheckPack = { ...RULES, actions: { ...RULES.actions, pass: hi } };
  const automatic = ACTION_KINDS.filter((kind) => kind !== "comment");
  const hub = fakeHub({ takes: [{ ...PASS, events: [mailEvent(HEAD, hubRequest(held, {}, automatic))], request: hubRequest(held, {}, automatic) }], dones: [ENDED] });
  const verdict = (await runMail(github, wake(), githubHost().host, hub.hub)).outputs["evaluateRules"] as { request: unknown; headSha: string; actions: { list: string; index: number; effectId: string; kind: string; target: unknown }[] };
  const [step] = verdict.actions;
  if (step?.kind !== "comment") throw new Error("the verdict holds no comment");
  const approval = { kind: APPROVE_DO_KIND, runId: "run_old", principalId: "prn_ann", list: step.list, index: step.index, request: verdict.request, step: { effectId: step.effectId, headSha: verdict.headSha, kind: step.kind, target: step.target }, appLogin: REQUEST["appLogin"] };
  return { approval, effectId: step.effectId, held, automatic };
}

describe("triage-manager", () => {
  test("a head whose CI still runs, with no reviewer out, gets the Waiting label and the in-progress comment, and its manager ends", async () => {
    const { writes, host } = githubHost(HEAD, { checkRuns: [{ name: "build", status: "in_progress", conclusion: null }] });
    const hub = fakeHub({ takes: [PASS], dones: [ENDED] });
    const { passes } = await runMail(github, wake(), host, hub.hub);
    expect(passes).toBe(1);
    expect(doneBody(hub.calls)).toMatchObject({ wait: false, report: { head: HEAD, verdict: expect.objectContaining({ waiting: true }) } });
    expect(writes).toContainEqual(expect.objectContaining({ method: "POST", path: `/repos/${PR.repo}/issues/${PR.number}/labels`, body: { labels: [WAITING_LABELS.ci] } }));
    expect(writes.filter((write) => write.path.endsWith("/comments"))).toEqual([inProgress("CI to finish")]);
  });

  test("the in-progress comment keeps the header of the verdict it replaces, so the next verdict still says what changed since it", async () => {
    const before = "0ld0".repeat(10);
    const comment = { id: 1, user: { login: REQUEST["appLogin"] }, body: `<!-- corbits-triage ${JSON.stringify({ head: before, policy: null, verdict: "pass" })} -->\n**Triage: Pass**` };
    function commented(checkRuns: object[]) {
      const { writes, host } = githubHost(HEAD, { checkRuns });
      async function withComment(input: string | URL | Request, init?: RequestInit): Promise<Response> {
        const url = new URL(input instanceof Request ? input.url : input);
        if (url.pathname === `/repos/${PR.repo}/issues/${PR.number}/comments` && (init?.method ?? "GET") === "GET") return Response.json([comment]);
        if (url.pathname.startsWith(`/repos/${PR.repo}/compare/`)) return Response.json({ ahead_by: 2, commits: [] });
        if (url.pathname === `/repos/${PR.repo}/pulls` && (init?.method ?? "GET") === "GET") return Response.json([]);
        if (url.pathname === `/repos/${PR.repo}/issues/comments/1` && init?.method === "PATCH") comment.body = (JSON.parse(String(init.body)) as { body: string }).body;
        return host(input, init);
      }
      return { writes, host: withComment };
    }
    const waiting = commented([{ name: "build", status: "in_progress", conclusion: null }]);
    await runMail(github, wake(), waiting.host, fakeHub({ takes: [PASS], dones: [ENDED] }).hub);
    expect(comment.body).toContain("**Triage: In progress**");

    const failed = commented([{ name: "build", status: "completed", conclusion: "failure" }]);
    await runMail(github, wake(), failed.host, fakeHub({ takes: [PASS], dones: [ENDED] }).hub);
    expect(comment.body).toContain("**Triage: Fail**");
    expect(comment.body).toContain(`Changed since the last verdict (Pass at \`${before.slice(0, 7)}\`): 2 new commits.`);
  });

  test("a manager three hours past its claim stops waiting: the pass decides without CI, says so, and runs no action on its own", async () => {
    const { writes, host } = githubHost(HEAD, { checkRuns: [{ name: "build", status: "in_progress", conclusion: null }] });
    const old = new Date(Date.now() - 3 * 60 * 60_000 - 1_000).toISOString();
    const hub = fakeHub({ takes: [{ ...IDLE, waitingSince: old, claimedAt: old }], dones: [ENDED] });
    const { outputs } = await runMail(github, wake(), host, hub.hub);
    expect(doneBody(hub.calls)).toMatchObject({ wait: false, report: { head: HEAD, verdict: expect.objectContaining({ verdict: "unsure" }) } });
    expect(writes).toContainEqual(expect.objectContaining({ path: `/repos/${PR.repo}/issues/${PR.number}/comments`, body: { body: expect.stringContaining("Triage stopped waiting for CI to finish after 3 hours, so no action ran on its own.") } }));
    expect(((outputs["cleared"] as { actions: { held?: true }[] }).actions).every((action) => action.held === true && !("ci" in action))).toBe(true);
  });

  test("a new head with no checks yet waits for its CI to start and its manager ends; one woken past the start grace decides it as having none", async () => {
    const { writes, host } = githubHost();
    const fresh = { ...PASS, headSince: undefined };
    const first = fakeHub({ takes: [fresh], dones: [ENDED] });
    await runMail(github, wake(), host, first.hub);
    expect(doneBody(first.calls)).toMatchObject({ wait: false, report: { head: HEAD, verdict: expect.objectContaining({ waiting: true, reason: expect.stringContaining("checks have not started yet") }) } });
    expect(writes).toContainEqual(expect.objectContaining({ method: "POST", path: `/repos/${PR.repo}/issues/${PR.number}/labels`, body: { labels: [WAITING_LABELS.ci] } }));
    const since = new Date(Date.now() - 2 * 60_000 - 10_000).toISOString();
    const later = fakeHub({ takes: [{ ...PASS, waitingSince: since, headSince: since }], dones: [ENDED] });
    await runMail(github, wake(), host, later.hub);
    expect(doneBody(later.calls)).toMatchObject({ wait: false, report: { head: HEAD, verdict: expect.objectContaining({ verdict: "pass" }) } });
  });

  test.each([["after"], ["before"]])("an approval for an older head arriving %s a push runs as pr-triage runs a stale one, and triage runs on the push", async (order) => {
    const NEWER = "0e0e".repeat(10);
    const { approval, effectId, held, automatic } = await heldApproval();
    const step = { effectId };

    const { writes, host } = githubHost(NEWER);
    const pushed = { ...hubRequest(held, {}, automatic), headSha: NEWER };
    const push = mailEvent(NEWER, pushed, "evt_push");
    const approved = mailEvent(HEAD, approval, "evt_approval");
    const hub = fakeHub({ takes: [{ ...PASS, pass: { ...PASS.pass, head: NEWER }, events: order === "after" ? [push, approved] : [approved, push], request: pushed }], dones: [ENDED] });
    const { ran, outputs } = await runMail(github, wake(), host, hub.hub);
    expect(ran).toContain("facts");
    expect(outputs["approvals"]).toEqual({ results: [{ dos: [expect.objectContaining({ effectId: step.effectId, status: "skipped", error: expect.stringContaining("new commits since this verdict") })] }] });
    expect(writes.filter((write) => JSON.stringify(write.body).includes("\"hi\""))).toEqual([]);
  });

  test("on Bitbucket Data Center the verdict goes up as the head's build status", async () => {
    const { builds, host } = bitbucketHost();
    const request = { kind: "pr", repo: BB_REPO, repoSource: "bitbucket-datacenter", prNumber: 8, headSha: "abc", policy: { enabled: true }, policyUnreadable: "The policy file has unknown checks: max-size.", automatic: ACTION_KINDS, tenantId: TENANT };
    const bbPull = { source: "bitbucket-datacenter", repo: BB_REPO, number: 8 };
    const hub = fakeHub({ takes: [{ ...PASS, pass: { ...PASS.pass, head: "abc" }, events: [mailEvent("abc", request)], request }], dones: [ENDED] });
    expect((await runMail(bitbucket, wake(bbPull), host, hub.hub)).terminalStatus).toBe("completed");
    expect(builds).toEqual([expect.objectContaining({ state: "FAILED" })]);
  });
});

describe("triage-manager with code review", () => {
  const reviewed = github;
  beforeEach(() => publish({ github: { codeReview: RELEASE } }));
  const ON = hubRequest(RULES, { ...CODE_REVIEW, ...REVIEW_REQUEST });

  test("a review that starts while CI runs keeps the CI wait on the pass, and the in-progress comment names both", async () => {
    const { writes, host } = githubHost(HEAD, { checkRuns: [{ name: "build", status: "in_progress", conclusion: null }] });
    const first = fakeHub({ takes: [{ ...PASS, request: ON }], dones: [ENDED] });
    expect((await runMail(reviewed, wake(), host, first.hub)).ran).toContain("doneReviewing");
    expect(doneBody(first.calls)).toMatchObject({ wait: true, report: { head: HEAD, waiting: true } });
    expect(writes.filter((write) => write.path.endsWith("/comments"))).toEqual([inProgress("CI to finish and code review")]);
  });

  test("the first pass deploys the review and mails it, posting nothing; the pass that collects its report posts the verdict and the review together", async () => {
    publish({ github: { codeReviews: { "other-reviewer": { ...RELEASE, name: "other-reviewer", workflow: { ...RELEASE.workflow, assetId: "ast_other" } }, [RELEASE.name]: { ...RELEASE, workflow: { ...RELEASE.workflow, assetId: "ast_selected" } } } } });
    const { writes, host } = githubHost();
    const mailed: unknown[] = [];
    const first = fakeHub({ takes: [{ ...PASS, request: ON }], dones: [ENDED] });
    expect((await runMail(reviewed, wake(), host, first.hub, mailed)).ran).toContain("doneReviewing");
    expect(writes.filter((write) => write.path.endsWith("/comments"))).toEqual([inProgress("code review")]);
    expect(first.calls[1]).toMatchObject({ ...DEPLOY, body: { source: { kind: "asset", assetId: "ast_selected", package: { format: "source", commitSha: "c0ffee", packageName: RELEASE.workflow.packageName } }, entry: RELEASE.workflow.entry, sourceOfferingIds: ["off_a"], defaultSourceOfferingId: "off_a" } });
    const [mail] = mailed as [{ tenantId: string; to: string; content: string; readyBy: string }];
    expect(Date.parse(mail.readyBy)).toBeGreaterThan(Date.now());
    expect({ ...mail, content: JSON.parse(mail.content) }).toEqual({ tenantId: TENANT, to: DEPLOYED, readyBy: mail.readyBy, content: { ...REVIEW_REQUEST.codeReviewRequest, tenantId: TENANT } });
    expect(doneBody(first.calls)["wait"]).toBe(true);

    const second = fakeHub({ takes: [reported({ result: REVIEW }, ON)], dones: [ENDED] });
    const { ran } = await runMail(reviewed, wake(), host, second.hub, mailed);
    expect(ran).toContain("postReview");
    expect(ran).not.toContain("deployReview");
    expect(writes).toContainEqual(READY);
    expect(writes).toContainEqual(POSTED_REVIEW);
    expect(mailed).toHaveLength(1);
  });

  /** GitHub answering the review's inline comments and its review threads as GraphQL gives them. `checkRuns` is the head's CI. */
  function threadedHost(threads?: object[], checkRuns?: object[]) {
    const { writes, host } = githubHost(HEAD, { checkRuns });
    async function threaded(input: string | URL | Request, init?: RequestInit): Promise<Response> {
      const url = new URL(input instanceof Request ? input.url : input);
      if (/\/pulls\/\d+\/comments$/.test(url.pathname)) {
        const review = writes.findLastIndex((write) => write.path.endsWith("/reviews"));
        const { comments } = writes[review]!.body as { comments: Array<{ path: string; body: string; line: number; start_line?: number }> };
        return Response.json(comments.map((comment, index) => ({ id: 501 + index, pull_request_review_id: review + 1, path: comment.path, body: comment.body, original_line: comment.line, original_start_line: comment.start_line ?? null })));
      }
      if (url.pathname === "/graphql" && threads === undefined) return Response.json({ message: "Bad credentials" }, { status: 401 });
      if (url.pathname === "/graphql") return Response.json({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: threads } } } } });
      return host(input, init);
    }
    return { writes, host: threaded };
  }

  function thread(ids: number[], { isResolved = false, isOutdated = false, by = ids.map(() => "corbits") }: { isResolved?: boolean; isOutdated?: boolean; by?: string[] } = {}) {
    const comments = ids.map((databaseId, index) => ({ databaseId, createdAt: `2026-10-2${index}T00:00:00Z`, author: { login: by[index]! } }));
    return { isResolved, isOutdated, opener: { nodes: comments.slice(0, 1) }, comments: { nodes: comments } };
  }

  test("a later event on the same head deploys no second review and posts the stored review with the verdict", async () => {
    const { writes, host } = githubHost();
    const mailed: unknown[] = [];
    const later = { ...PASS, request: ON, events: [mailEvent(HEAD, ON, "evt_2")], reviewers: [{ ...reviewer(), result: REVIEW }] };
    const hub = fakeHub({ takes: [later], dones: [ENDED] });
    const { ran } = await runMail(reviewed, wake(), host, hub.hub, mailed);
    expect(ran).not.toContain("deployReview");
    expect(writes).toContainEqual(READY);
    expect(writes).toContainEqual(POSTED_REVIEW);
    expect(mailed).toEqual([]);
  });

  test("Review again on a head whose review settled deploys one more review for it, and that review's report is posted", async () => {
    const { writes, host } = githubHost();
    const mailed: unknown[] = [];
    const again = hubRequest(RULES, { codeReview: { ...CODE_REVIEW.codeReview, again: "again_1" }, ...REVIEW_REQUEST });
    const settled = { ...reviewer(), runId: "run_earlier", result: REVIEW };
    const first = fakeHub({ takes: [{ ...PASS, request: again, events: [mailEvent(HEAD, again, "evt_2")], reviewers: [settled] }], dones: [ENDED] });
    expect((await runMail(reviewed, wake(), host, first.hub, mailed)).ran).toContain("deployReview");
    expect(writes.filter((write) => write.path.endsWith("/comments"))).toEqual([inProgress("code review")]);
    expect(mailed).toHaveLength(1);

    const second = fakeHub({ takes: [{ ...reported({ result: REVIEW }, again), reviewers: [settled, { ...reviewer(), again: "again_1" }] }], dones: [ENDED] });
    const { ran } = await runMail(reviewed, wake(), host, second.hub, mailed);
    expect(ran).not.toContain("deployReview");
    expect(writes).toContainEqual(POSTED_REVIEW);
    expect(mailed).toHaveLength(1);
  });

  test("a stored review is not posted once this pass's policy no longer asks for code review", async () => {
    const { writes, host } = githubHost();
    const hub = fakeHub({ takes: [{ ...PASS, reviewers: [{ ...reviewer(), result: REVIEW }] }], dones: [ENDED] });
    await runMail(reviewed, wake(), host, hub.hub);
    expect(writes).toContainEqual(READY);
    expect(writes).not.toContainEqual(POSTED_REVIEW);
  });

  const CONTRIBUTOR = { author_association: "CONTRIBUTOR" };
  const FAILED_CI = [{ name: "ci", status: "completed", conclusion: "failure" }];

  test.each([
    ["an author outside `for`", { for: ["maintainers"] }, { pull: CONTRIBUTOR }, "the author is not in the maintainers group"],
    ["an author whose group cannot be told under `for`", { for: ["maintainers"] }, {}, "Triage could not tell whether the author is in the maintainers group"],
    ["a verdict outside `when.triage`", { triage: ["fail"] }, {}, "triage's verdict is Pass, not Fail"],
    ["changed files all left out by `when.paths`", { paths: ["!**/*.ts", "!**/*.md"] }, {}, "every changed file is excluded by the policy's paths"],
    ["a failed rule under `when.rules: pass`", { rules: "pass" }, { checkRuns: FAILED_CI }, "rules failed: CI green"],
  ])("%s is not reviewed, and done says why", async (_name, limit, pull, why) => {
    const { host } = githubHost(HEAD, pull);
    const limited = hubRequest(RULES, { codeReview: { ...CODE_REVIEW.codeReview, ...limit }, ...REVIEW_REQUEST });
    const hub = fakeHub({ takes: [{ ...PASS, request: limited }], dones: [ENDED] });
    const { ran } = await runMail(reviewed, wake(), host, hub.hub);
    expect(ran).not.toContain("deployReview");
    expect(ran).toContain("mirrorRules");
    expect(doneBody(hub.calls)["report"]).toMatchObject({ verdict: { codeReviewSkipped: why } });
  });

  test("a code review naming an unknown provider is never deployed, rather than defaulting", async () => {
    const { host } = githubHost();
    const unknown = hubRequest(RULES, { codeReview: { ...CODE_REVIEW.codeReview, provider: "openai" }, ...REVIEW_REQUEST });
    const hub = fakeHub({ takes: [{ ...PASS, request: unknown }], dones: [ENDED] });
    const { ran } = await runMail(reviewed, wake(), host, hub.hub);
    expect(ran).not.toContain("deployReview");
    expect(ran).toContain("mirrorRules");
  });

  test("a published reviewer for another workflow is never deployed", async () => {
    publish({ github: { codeReview: { ...RELEASE, name: "wrong-reviewer" } } });
    const { host } = githubHost();
    const hub = fakeHub({ takes: [{ ...PASS, request: hubRequest(RULES, { ...CODE_REVIEW, ...REVIEW_REQUEST }) }], dones: [ENDED] });
    const { ran } = await runMail(reviewed, wake(), host, hub.hub);
    expect(ran).not.toContain("deployReview");
  });

  const CLEAN = { result: { ...REVIEW, comments: [] } };

  /** One pass of a policy that approves a Pass, on `head` with CI green, taking what `take` builds from its request. */
  async function approvingPass(take: (request: Record<string, unknown>) => Record<string, unknown>, checks: Record<string, unknown> = CODE_REVIEW, head = HEAD) {
    const approving: CheckPack = { ...RULES, actions: { ...RULES.actions, pass: [{ do: "approve" }] } };
    const { writes, host } = githubHost(head, { checkRuns: [{ name: "ci", status: "completed", conclusion: "success" }] });
    const hub = fakeHub({ takes: [take(hubRequest(approving, { ...checks, ...REVIEW_REQUEST }))], dones: [ENDED] });
    await runMail(reviewed, wake(), host, hub.hub);
    return { writes };
  }

  function approved(writes: readonly Write[]): boolean {
    return writes.some((write) => (write.body as { event?: string } | undefined)?.event === "APPROVE");
  }
  test.each([
    ["a clean review", CLEAN, CODE_REVIEW, true],
    ["a review that failed", { failed: "the review did not finish" }, CODE_REVIEW, false],
    ["a pull request `when.paths` leaves out of code review", undefined, { ...CODE_REVIEW, codeReview: { ...CODE_REVIEW.codeReview, paths: ["!**/*.ts"] } }, true],
  ])("a passing verdict's approve runs on its own only after a clean code review or none the policy asks for: %s", async (_name, report, checks, runs) => {
    const { writes } = await approvingPass((request) => (report ? reported(report, request) : { ...PASS, request }), checks);
    expect(approved(writes)).toBe(runs);
  });

  test("after Review again, a later pass judges the newest review of the head", async () => {
    const p0 = { ...REVIEW, comments: [{ ...REVIEW.comments[0]!, priority: 0 }] };
    const first = { ...reviewer("2998-01-01T00:00:00.000Z"), runId: "run_first", result: p0 };
    const again = { ...reviewer(), again: "again_1", result: CLEAN.result };
    const { writes } = await approvingPass((request) => ({ ...PASS, request, reviewers: [first, again] }));
    expect(approved(writes)).toBe(true);
  });

  const CI_GREEN = [{ name: "ci", status: "completed", conclusion: "success" }];
  /** Approve and merge, woken by the policy's own events, which do not include threads. */
  const RELEASING: CheckPack = { ...RULES, actions: { ...RULES.actions, pass: [{ do: "approve" }, { do: "merge" }] } };
  const SUMMARY = { ...REVIEW.comments[0]!, title: "In the summary", body: "This finding was not posted inline." };

  function inline(state: "untouched" | "resolved") {
    return { ...REVIEW.comments[0]!, thread: { id: 501, state } };
  }

  function wroteMerge(writes: readonly Write[]): boolean {
    return writes.some((write) => write.method === "PUT" && write.path === `/repos/${PR.repo}/pulls/${PR.number}/merge`);
  }

  /**
   * A later pass on the head whose review is already stored, woken by a review-thread webhook. The pack's `on:` does not
   * name threads, so approve and merge are suggested only because that wake releases them. No second review is deployed.
   */
  async function threadsWake(hostThreads: object[] | undefined, comments: readonly object[]) {
    const request = { ...hubRequest(RELEASING, { ...CODE_REVIEW, ...REVIEW_REQUEST }), event: "pull_request_review_thread", action: "resolved", events: ["threads"] };
    const { writes, host } = threadedHost(hostThreads, CI_GREEN);
    const take = { ...PASS, request, events: [mailEvent(HEAD, { kind: "pr", event: "pull_request_review_thread", action: "resolved", headSha: HEAD }, "evt_threads")], threads: [501], reviewers: [{ ...reviewer(), result: { ...REVIEW, comments } }] };
    const hub = fakeHub({ takes: [take], dones: [ENDED] });
    const { terminalStatus } = await runMail(reviewed, wake(), host, hub.hub);
    expect(terminalStatus).toBe("completed");
    return writes;
  }

  test("a resolved host thread on a threads wake writes approve and merge", async () => {
    const writes = await threadsWake([thread([501], { isResolved: true })], [inline("untouched")]);
    expect(approved(writes)).toBe(true);
    expect(wroteMerge(writes)).toBe(true);
  });

  test("an outdated host thread holds approve and merge for the open finding and writes neither", async () => {
    const writes = await threadsWake([thread([501], { isOutdated: true })], [inline("untouched")]);
    expect(approved(writes)).toBe(false);
    expect(wroteMerge(writes)).toBe(false);
  });

  test("a resolved thread does not release a summary finding, so approve is not written", async () => {
    const writes = await threadsWake([thread([501], { isResolved: true })], [inline("untouched"), SUMMARY]);
    expect(approved(writes)).toBe(false);
    expect(wroteMerge(writes)).toBe(false);
  });

  test("a thread read the host refuses holds approve even when the stored thread was resolved", async () => {
    const writes = await threadsWake(undefined, [inline("resolved")]);
    expect(approved(writes)).toBe(false);
    expect(wroteMerge(writes)).toBe(false);
  });

  test("a review that could not be mailed by its deadline leaves the verdict to go up alone, waiting for no reviewer", async () => {
    const { writes, host } = githubHost();
    const hub = fakeHub({ takes: [{ ...PASS, request: ON }], dones: [ENDED] });
    await runMail(reviewed, wake(), host, hub.hub, [], false);
    expect(writes).toContainEqual(READY);
  });

  test("a pass with a code reviewer out and no other event keeps polling, and gives up on the review at its deadline", async () => {
    const { writes, host } = githubHost();
    const out = { ...PASS, request: ON, reviewers: [reviewer()] };
    const late = { ...IDLE, request: ON, reviewers: [reviewer("2000-01-01T00:00:00.000Z")] };
    const hub = fakeHub({ takes: [out, late], dones: [{ outcome: "more", wait: true }, ENDED] });
    const { passes } = await runMail(reviewed, wake(), host, hub.hub, [], true, hurried());
    expect(passes).toBe(2);
    expect(writes).toContainEqual(READY);
  });

  test("a pass while a code reviewer is out on the head keeps a verdict its rules still give, and writes progress over any other", async () => {
    const comment = { id: 1, user: { login: REQUEST["appLogin"] }, body: "" };
    const { host } = githubHost();
    async function withComment(input: string | URL | Request, init?: RequestInit): Promise<Response> {
      const url = new URL(input instanceof Request ? input.url : input);
      const method = init?.method ?? "GET";
      if (url.pathname === `/repos/${PR.repo}/issues/${PR.number}/comments` && method === "GET") return Response.json(comment.body ? [comment] : []);
      if (url.pathname === `/repos/${PR.repo}/issues/${PR.number}/comments` && method === "POST") comment.body = (JSON.parse(String(init!.body)) as { body: string }).body;
      if (url.pathname === `/repos/${PR.repo}/issues/comments/1` && method === "PATCH") comment.body = (JSON.parse(String(init!.body)) as { body: string }).body;
      return host(input, init);
    }
    await runMail(reviewed, wake(), withComment, fakeHub({ takes: [{ ...PASS, request: hubRequest(RULES, CODE_REVIEW) }], dones: [ENDED] }).hub);
    const posted = comment.body;
    expect(posted).toContain("**Triage: Pass**");

    const out = { ...PASS, request: ON, reviewers: [reviewer()] };
    await runMail(reviewed, wake(), withComment, fakeHub({ takes: [out], dones: [ENDED] }).hub);
    expect(comment.body).toBe(posted);

    comment.body = posted.replace('"verdict":"pass"', '"verdict":"fail"');
    await runMail(reviewed, wake(), withComment, fakeHub({ takes: [out], dones: [ENDED] }).hub);
    expect(comment.body).toContain("**Triage: In progress**");
  });
});

/** A decisive answer for one question id. */
function answerFor(id: string): string {
  if (id === "instructed") return JSON.stringify({ id, type: "noul", noul: 0.1 });
  if (id === "verdict") return JSON.stringify({ id, type: "choice", choice: "pass", probabilities: { pass: 0.9, fail: 0.05, cant_tell: 0.05 }, confidence: 0.9 });
  if (id === "focused") return JSON.stringify({ id, type: "choice", choice: "one_thing", probabilities: { one_thing: 0.9, more_than_one_thing: 0.05, cant_tell: 0.05 }, confidence: 0.9 });
  return JSON.stringify({ id, type: "choice", choice: "serves_purpose", probabilities: { serves_purpose: 0.9, separate_change: 0.05, cant_tell: 0.05 }, confidence: 0.9 });
}

type MailedRules = { items: object[]; batch: boolean; chunks: { questions: { id: string }[] }[] };

const JUDGE_COMMENT = "The judge's own words.";

function answered(chunks: { questions: { id: string }[] }[]) {
  return chunks.map((chunk) => ({ reply: JSON.stringify({ judge: chunk.questions.map((question) => answerFor(question.id)).join("") }) }));
}

/** The verdict the judge reports on `rules`, as its steps make it from decisive answers, worded so no verdict the manager makes matches it. */
async function judgeVerdict(rules: MailedRules): Promise<Record<string, unknown>> {
  const signal = new AbortController().signal;
  const judged = { ...rules, judge: { output: answered(rules.chunks) } };
  const { chunks } = await parts(judged, {} as never, signal) as { chunks: MailedRules["chunks"] };
  const made = await evaluate({ ...judged, judgeParts: { output: answered(chunks) } }, {} as never, signal) as { request: Record<string, unknown> };
  return { ...made, feedback: JUDGE_COMMENT, request: { ...made.request, comment: JUDGE_COMMENT } };
}

const JUDGE = { kind: "judge", head: HEAD, runId: DEPLOYED, deployedBy: RUN, deadline: LATER };

/** A pass on which the manager's judge reported `verdict` for this head. */
function judgeReported(verdict: Record<string, unknown>, request = hubRequest(JUDGED)) {
  return { ...PASS, request, events: [{ key: `evt:github:${PR.repo}#8:${DEPLOYED}`, event: { type: "reviewer-result", head: HEAD, payload: { kind: "judge", result: verdict } } }], reviewers: [JUDGE] };
}

const JUDGE_POSTED = expect.objectContaining({ method: "POST", path: `/repos/${PR.repo}/issues/${PR.number}/comments`, body: { body: expect.stringContaining(JUDGE_COMMENT) } });

describe("triage-manager with a judge", () => {
  beforeEach(() => publish({ github: { judge: JUDGE_RELEASE } }));

  test.each([
    ["a judge deployed again on unchanged facts keeps the verdict the rules alone give until it reports", "unsure", false],
    ["a first judge over a Fail its rules no longer give writes progress", "fail", true],
  ])("%s", async (_name, posted, written) => {
    // The policy file the rules read, as the verdict's header names it.
    const policy = { file: { path: ".corbits-triage.yml", sha: "eval-1" } };
    const shown = `<!-- corbits-triage ${JSON.stringify({ head: HEAD, policy, verdict: posted, shows: "verdict" })} -->\n**Triage: ${posted === "fail" ? "Fail" : "Unsure"}**`;
    const comment = { id: 1, user: { login: REQUEST["appLogin"] }, body: shown };
    const { host } = githubHost();
    async function withComment(input: string | URL | Request, init?: RequestInit): Promise<Response> {
      const url = new URL(input instanceof Request ? input.url : input);
      const method = init?.method ?? "GET";
      if (url.pathname === `/repos/${PR.repo}/issues/${PR.number}/comments` && method === "GET") return Response.json([comment]);
      if (url.pathname === `/repos/${PR.repo}/issues/comments/1` && method === "PATCH") comment.body = (JSON.parse(String(init!.body)) as { body: string }).body;
      return host(input, init);
    }
    await runMail(github, wake(), withComment, fakeHub({ takes: [{ ...PASS, request: hubRequest(JUDGED) }], dones: [ENDED] }).hub);
    expect(comment.body.includes("**Triage: In progress**")).toBe(written);
  });

  test("a later event on the same head deploys no second judge and posts the judge's verdict, whatever changed on the pull request since", async () => {
    const verdict = await judgeVerdict(rulesOf(await firstJudgeMail()));
    const { writes, host } = githubHost(HEAD, { pr: { ...PR, title: "Renamed since", body: "", bodyHtml: "" } });
    const later = { ...PASS, request: hubRequest(JUDGED), events: [mailEvent(HEAD, hubRequest(JUDGED), "evt_2")], reviewers: [{ ...JUDGE, result: verdict }] };
    const hub = fakeHub({ takes: [later], dones: [ENDED] });
    const { ran, outputs } = await runMail(github, wake(), host, hub.hub);
    expect(ran).not.toContain("deployJudge");
    expect(outputs["evaluateRules"]).toEqual(verdict);
    expect(writes).toContainEqual(JUDGE_POSTED);
    expect(doneBody(hub.calls)["report"]).toMatchObject({ head: HEAD, verdict });
  });

  test("a stored verdict gives way when this pass's rules no longer need the judge, as on a draft", async () => {
    const verdict = await judgeVerdict(rulesOf(await firstJudgeMail()));
    const { writes, host } = githubHost(HEAD, { pull: { draft: true } });
    const hub = fakeHub({ takes: [{ ...PASS, request: hubRequest(JUDGED), reviewers: [{ ...JUDGE, result: verdict }] }], dones: [ENDED] });
    const { ran, outputs } = await runMail(github, wake(), host, hub.hub);
    expect(ran).not.toContain("judgeScope");
    expect(outputs["evaluateRules"]).not.toEqual(verdict);
    expect(writes).not.toContainEqual(JUDGE_POSTED);
  });

  test("a stored verdict whose approve CI skipped is posted on the pass after CI turned green on the same head with its Dos made again, and the judge is not run again", async () => {
    const pack: CheckPack = { ...JUDGED, actions: { ...JUDGED.actions, pass: [{ do: "approve" }] } };
    const request = hubRequest(pack);
    const red = githubHost(HEAD, { checkRuns: [{ name: "ci", status: "completed", conclusion: "failure" }] });
    const mailed: unknown[] = [];
    expect((await runMail(github, wake(), red.host, fakeHub({ takes: [{ ...PASS, request }], dones: [ENDED] }).hub, mailed)).ran).toContain("deployJudge");
    const verdict = await judgeVerdict(rulesOf(mailed[0]));
    expect(verdict["actions"]).toEqual([expect.objectContaining({ kind: "approve", skipped: true, ci: "failure" })]);

    const green = githubHost(HEAD, { checkRuns: [{ name: "ci", status: "completed", conclusion: "success" }] });
    const hub = fakeHub({ takes: [{ ...PASS, request, reviewers: [{ ...JUDGE, result: verdict }] }], dones: [ENDED] });
    const { ran, outputs } = await runMail(github, wake(), green.host, hub.hub);
    expect(ran).not.toContain("deployJudge");
    expect((outputs["evaluateRules"] as { actions: unknown[] }).actions).toEqual([expect.objectContaining({ kind: "approve", effectId: expect.any(String) })]);
    expect(green.writes).toContainEqual(POSTED_REVIEW);
  });

  test("a judge's report on a head whose CI started running again posts the waiting state and ends, keeping the judgement for the pass after CI", async () => {
    const pack: CheckPack = { ...JUDGED, actions: { ...JUDGED.actions, pass: [{ do: "approve" }] } };
    const request = hubRequest(pack);
    const verdict = await judgeVerdict(rulesOf(await firstJudgeMail(request)));
    const { writes, host } = githubHost(HEAD, { checkRuns: [{ name: "ci", status: "in_progress", conclusion: null }] });
    const hub = fakeHub({ takes: [judgeReported(verdict, request)], dones: [ENDED] });
    const { outputs } = await runMail(github, wake(), host, hub.hub);
    expect(outputs["evaluateRules"]).toMatchObject({ waiting: true });
    expect(writes).toContainEqual(inProgress("CI to finish"));
    expect(writes).not.toContainEqual(JUDGE_POSTED);
    expect(doneBody(hub.calls)).toMatchObject({ wait: false, reviewers: [{ ...JUDGE, result: verdict }] });
  });

  test("a judge's verdict for another pull request fails the pass instead of being posted", async () => {
    const verdict = await judgeVerdict(rulesOf(await firstJudgeMail()));
    const { writes, host } = githubHost();
    const hub = fakeHub({ takes: [judgeReported({ ...verdict, number: 9 })] });
    expect((await runMail(github, wake(), host, hub.hub)).terminalStatus).toBe("failed");
    expect(writes).toEqual([]);
  });

  test.each([
    ["the judge reported a failure", { ...PASS, request: hubRequest(JUDGED), events: [{ key: `evt:github:${PR.repo}#8:${DEPLOYED}`, event: { type: "reviewer-result", head: HEAD, payload: { kind: "judge", failed: "the judge did not finish" } } }], reviewers: [JUDGE] }, [TAKE, DONE, END]],
    ["the judge ran past its deadline, which is stopped,", { ...PASS, request: hubRequest(JUDGED), reviewers: [{ ...JUDGE, deadline: "2000-01-01T00:00:00.000Z" }] }, [TAKE, DONE, STOP_REVIEW, END]],
  ])("when %s the machine verdict goes up, the judge is not deployed again on that pass and the next event deploys it", async (_name, taken, calls) => {
    const { writes, host } = githubHost();
    const hub = fakeHub({ takes: [taken], dones: [ENDED] });
    const { ran } = await runMail(github, wake(), host, hub.hub);
    expect(ran).toContain("mirrorRules");
    expect(ran).not.toContain("deployJudge");
    expect(writes).toContainEqual(expect.objectContaining({ path: `/repos/${PR.repo}/issues/${PR.number}/labels`, body: { labels: [VERDICT_LABELS.unsure] } }));
    expect(writes).not.toContainEqual(JUDGE_POSTED);
    expect(hub.calls).toEqual(calls);
  });
});

/** The rules output a judge's mail attaches. */
function rulesOf(mail: unknown): MailedRules {
  const [attachment] = (mail as { attachments: { name: string; content: string }[] }).attachments;
  expect(attachment!.name).toBe(JUDGE_RULES_ATTACHMENT);
  return JSON.parse(attachment!.content) as MailedRules;
}

/** The mail a first pass sends the judge it deploys. */
async function firstJudgeMail(request = hubRequest(JUDGED)): Promise<unknown> {
  const mailed: unknown[] = [];
  await runMail(github, wake(), githubHost().host, fakeHub({ takes: [{ ...PASS, request }], dones: [ENDED] }).hub, mailed);
  return mailed[0];
}

describe("triage-manager with a judge and code review", () => {
  beforeEach(() => publish({ github: { judge: JUDGE_RELEASE, codeReview: RELEASE } }));

  test("deploys code review with the judge once the rules gate opens, and posts the judge's verdict and the review together once both have reported", async () => {
    const { writes, host } = githubHost();
    const mailed: unknown[] = [];
    const request = hubRequest(JUDGED, { ...CODE_REVIEW, ...REVIEW_REQUEST });
    const first = fakeHub({ takes: [{ ...PASS, request }], dones: [ENDED] });
    const deployed = await runMail(github, wake(), host, first.hub, mailed);
    expect(deployed.ran).toEqual(expect.arrayContaining(["deployJudge", "deployEarlyReview", "doneJudgingReview"]));
    expect(mailed).toHaveLength(2);
    expect(doneBody(first.calls)).toMatchObject({ wait: true, reviewers: [expect.objectContaining({ kind: "judge" }), expect.objectContaining({ kind: "code-review" })] });
    const verdict = await judgeVerdict(rulesOf(mailed[0]));

    const second = fakeHub({ takes: [{ ...judgeReported(verdict, request), reviewers: [JUDGE, reviewer()] }], dones: [ENDED] });
    const again = await runMail(github, wake(), host, second.hub, mailed);
    expect(again.ran).not.toContain("deployReview");
    expect(again.ran).not.toContain("mirrorRules");
    expect(writes.filter((write) => write.path.endsWith("/comments"))).toEqual([inProgress("the decision model's answer and code review"), inProgress("code review")]);
    expect(doneBody(second.calls)).toMatchObject({ wait: true, reviewers: [{ ...JUDGE, result: verdict }, expect.objectContaining({ kind: "code-review", runId: DEPLOYED })] });

    const third = fakeHub({ takes: [{ ...reported({ result: REVIEW }, request), reviewers: [{ ...JUDGE, result: verdict }, reviewer()] }], dones: [ENDED] });
    const { ran } = await runMail(github, wake(), host, third.hub, mailed);
    expect(ran).toContain("postReview");
    expect(ran).not.toContain("deployJudge");
    expect(writes).toContainEqual(JUDGE_POSTED);
    expect(writes).toContainEqual(READY);
    expect(writes).toContainEqual(POSTED_REVIEW);
  });
});

describe("triage-listener", () => {
  beforeEach(() => publish({ github: { manager: RELEASE } }));

  test("a mail that names no pull request, or is not from the hub, fails instead of being dropped", async () => {
    const hub = fakeHub({ takes: [] });
    const mail = triggerMail(PR, RULES, { tenantId: TENANT });
    const unnamed = { ...mail, parts: [{ ...mail.parts[0]!, text: JSON.stringify({ kind: "pr", repo: PR.repo, tenantId: TENANT }) }] };
    expect((await runMail(listener, unnamed, githubHost().host, hub.hub)).terminalStatus).toBe("failed");
    expect((await runMail(listener, { ...mail, headers: { from: "someone@triage.test", to: mail.headers.to } }, githubHost().host, hub.hub)).terminalStatus).toBe("failed");
    expect(hub.calls).toEqual([]);
  });
});
