import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { actionConsumer } from "@intx/authz";
import { createActionCredentialsFactory, createCredentialProviderRegistry, createHttpCredentialProvider } from "@intx/harness";
import type { GrantRule } from "@intx/types/authz";
import { HUB_CREDENTIAL_HANDLE } from "@intx/types/credential-delivery";
import { runLocal, type ActionHandler, type LoopFn, type OnTriggerPrimitive, type WorkflowAuthorizeFn, type WorkflowDefinition } from "@intx/workflow";
import { ACTION_KINDS, APPROVE_DO_KIND, emptyPack, WAITING_KIND, WAITING_LABEL, type ActionKind, type CheckPack } from "@corbits/triage-contracts";
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
import { triageListener } from "./triage-listener.js";
import { triageManager } from "./triage-manager.js";

const TENANT = "tnt_acme";
const RUN = "run_manager";
const HUB_ORIGIN = "https://hub.test";
const TENANT_PATH = `/api/tenants/${TENANT}`;
const END = { method: "DELETE", path: `${TENANT_PATH}/workflows/runs/${RUN}` };
const DEPLOY = { method: "POST", path: `${TENANT_PATH}/workflows/deployments` };
const DEPLOYED = "run_deployed";
const STOP_REVIEW = { method: "DELETE", path: `${TENANT_PATH}/workflows/runs/${DEPLOYED}` };
/** A code review an earlier manager deployed, which only that manager may stop. */
const INHERITED = "run_inherited";
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

const RELEASE = { workflow: { assetId: "ast_review", commitSha: "c0ffee", packageName: "@corbits/pr-code-review-anthropic", entry: "./pr-code-review-reviewer-github.mjs" }, offerings: { ids: ["off_a"], defaultId: "off_a" } };
const JUDGE_RELEASE = { workflow: { assetId: "ast_judge", commitSha: "c0ffee", packageName: "@corbits/triage-judge-github-workflow", entry: "./triage-judge-github.mjs" }, offerings: { ids: ["off_d"], defaultId: "off_d" } };
const CODE_REVIEW = { codeReview: { on: true, for: ["everyone"], triage: ["pass", "fail", "unsure"], rules: "any" }, blocks: ["code-review"] };
const REVIEW_REQUEST = { codeReviewRequest: { kind: "code-review", number: PR.number, title: PR.title, description: PR.body, diff: "diff --git a/src/flag.ts b/src/flag.ts", checkout: { source: "github", repo: PR.repo, sha: HEAD } } };
const REVIEW = { summary: "One bug.", comments: [{ path: "src/flag.ts", start: 1, end: 1, title: "Always true", body: "The flag can never be off." }], budgetExhausted: false };
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
const PASS = { outcome: "pass", pass: { id: "pass_1", head: HEAD, events: ["evt_1"], takenAt: "2026-10-25T00:00:00.000Z", takes: 1 }, events: [mailEvent(HEAD, REQUEST)], resumed: false, request: REQUEST, reviewers: [] };
const RESUMED = { ...PASS, pass: { ...PASS.pass, takes: 2 }, resumed: true };
const IDLE = { outcome: "idle", request: REQUEST, reviewers: [] };
const ENDED = { outcome: "ended" };
const MORE = { outcome: "more", wait: false };
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

/** The hub's manager routes, answering each take and done in turn, its deploy route and its stop-run route, which refuses to stop an inherited review. */
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
    if (method === "DELETE" && url.pathname === `${TENANT_PATH}/workflows/runs/${INHERITED}`) return Response.json({ error: { code: "forbidden" } }, { status: 403 });
    if (method === "DELETE" && url.pathname.startsWith(`${TENANT_PATH}/workflows/runs/`)) return new Response(null, { status: 202 });
    if (method === DEPLOY.method && url.pathname === DEPLOY.path) return Response.json({ id: DEPLOYED }, { status: 201 });
    return Response.json({ error: { code: "not_found" } }, { status: 404 });
  }
  return { hub, calls };
}

/** The host's credentials as triage-workflows wires them, plus the hub credential deploy binds to the hub actions. */
function actionCredentials(bindings: Bindings, host: Fetch, hub: (url: URL, init?: RequestInit) => Promise<Response>) {
  const consumers = ["take", "done", "deployReview", "deployJudge", "forward", "stop"].map(actionConsumer);
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

/**
 * Runs one mail's body; the mail agent's director runs its one tool, so the mail it would send is recorded and answered
 * `mailed` in the `{ reply, turn }` a live agent step outputs.
 */
async function runMail(definition: WorkflowDefinition, mail: unknown, host: Fetch, hub: ReturnType<typeof fakeHub>["hub"], mailed: unknown[] = [], delivers = true) {
  const body = (definition.steps.events as OnTriggerPrimitive).body;
  if (!("inline" in body)) throw new Error("the body is not inline");
  const { terminalStatus, outputs } = await runLocal(body.inline, {
    authorize: allow,
    hasUpstreamSignalResolver: true,
    invokeStep: async function mailAgent({ agent, input }) {
      if (!agent.id.startsWith("triage-mail")) throw new Error(`no agent but the mail agent runs, not ${agent.id}`);
      mailed.push(input);
      const reply = JSON.stringify({ mailed: delivers });
      return { output: { reply, turn: { role: "assistant", content: [{ type: "text", text: reply }] } } };
    },
    actionResolver: (ref) => (actions as Record<string, ActionHandler>)[ref]!,
    actionCredentials: actionCredentials((definition.credentialBindings ?? []) as Bindings, host, hub),
    loopFns,
    triggerPayload: mail,
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
const STAGE_1 = ["approvals", "cleared", "donePosted", "evaluateRules", "executeRules", "facts", "held", "mirrorRules", "paused", "postReview", "posting", "ran", "reviewScope", "reviewing", "route", "rules", "take", "triaged", "unready", "waiting"];

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
const NOT_READY = { ...READY, body: { labels: ["Triage: Not Ready"] } };
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
  test.each([["new", PASS], ["resumed", RESUMED]])("a %s pass runs stage 1 on the mail the hub recorded, and the run's last step stops it once done ends its claim", async (_name, pass) => {
    const { writes, host } = githubHost();
    const hub = fakeHub({ takes: [pass], dones: [ENDED] });
    expect(await runMail(github, wake(), host, hub.hub)).toMatchObject({ terminalStatus: "completed", stop: { stopped: true }, passes: 1, ran: STAGE_1 });
    expect(writes).toContainEqual(READY);
    expect(hub.calls).toEqual([TAKE, DONE, END]);
  });

  test("done reports the verdict the pass posted, as its evaluate, mirror and execute steps output it, with the facts the verdict keeps and not the diff", async () => {
    const { host } = githubHost();
    const hub = fakeHub({ takes: [PASS], dones: [ENDED] });
    const { outputs } = await runMail(github, wake(), host, hub.hub);
    const { report, approvals } = doneBody(hub.calls) as { report: { rules: { items: { facts: Record<string, unknown> }[] } }; approvals: unknown };
    expect(report).toEqual({ head: HEAD, verdict: outputs["cleared"], mirror: outputs["mirrorRules"], executed: outputs["executeRules"], rules: { items: [{ facts: expect.objectContaining({ repo: PR.repo, number: PR.number, title: PR.title }), det: { reason: expect.any(String), findings: expect.any(Array) } }] } });
    expect(Object.keys(report.rules.items[0]!.facts)).not.toContain("files");
    expect(approvals).toEqual({ results: [] });
  });

  test("with an event pending after done, the manager runs its next pass at once, and a refused newcomer is harmless", async () => {
    const { writes, host } = githubHost();
    const newcomer = fakeHub({ takes: [REFUSED] });
    expect(await runMail(github, wake(), host, newcomer.hub)).toMatchObject({ terminalStatus: "completed", stop: { stopped: true }, passes: 1, ran: ["approvals", "done", "paused", "ran", "take"] });
    expect(newcomer.calls).toEqual([TAKE, END]);
    expect(writes).toEqual([]);

    const live = fakeHub({ takes: [PASS, { ...PASS, pass: { ...PASS.pass, id: "pass_2" } }], dones: [MORE, ENDED] });
    expect(await runMail(github, wake(), host, live.hub)).toMatchObject({ terminalStatus: "completed", passes: 2 });
    expect(live.calls).toEqual([TAKE, DONE, TAKE, DONE, END]);
  });

  test("passes that run out are stopped once, by the run's last step", async () => {
    const { host } = githubHost();
    const passes = 280;
    const hub = fakeHub({ takes: Array.from({ length: passes }, () => IDLE), dones: Array.from({ length: passes }, () => MORE) });
    expect(await runMail(github, wake(), host, hub.hub)).toMatchObject({ terminalStatus: "completed", stop: { stopped: true }, passes });
    expect(hub.calls.filter((call) => call.method === "DELETE")).toEqual([END]);
  }, 120_000);

  test("the verdict's automatic Dos run after its mirror, as pr-triage runs them", async () => {
    const { writes, host } = githubHost();
    const welcome: CheckPack = { ...RULES, actions: { ...RULES.actions, pass: [{ do: "comment", target: { body: "Welcome" } }] } };
    const hub = fakeHub({ takes: [{ ...PASS, request: hubRequest(welcome) }], dones: [ENDED] });
    expect((await runMail(github, wake(), host, hub.hub)).ran).toEqual(STAGE_1);
    const ready = writes.findIndex((write) => write.path.endsWith("/labels"));
    const welcomed = writes.findIndex((write) => JSON.stringify(write.body).includes("Welcome"));
    expect(welcomed).toBeGreaterThan(ready);
  });

  test("a head the hub holds for CI gets the Waiting label and is not triaged", async () => {
    const { writes, host } = githubHost();
    const hub = fakeHub({ takes: [{ ...PASS, events: [mailEvent(HEAD, REQUEST), mailEvent(HEAD, { ...REQUEST, kind: WAITING_KIND }, "evt_2")] }], dones: [ENDED] });
    const { ran } = await runMail(github, wake(), host, hub.hub);
    expect(ran).toContain("markWaiting");
    expect(ran).not.toContain("facts");
    expect(doneBody(hub.calls)["report"]).toEqual({ head: HEAD, waiting: true });
    expect(writes).toContainEqual(expect.objectContaining({ method: "POST", path: `/repos/${PR.repo}/issues/${PR.number}/labels`, body: { labels: [WAITING_LABEL] } }));
  });

  test("an old review's reply finds nothing for its head, runs no stage 1 and stops the superseded review", async () => {
    const { writes, host } = githubHost();
    const hub = fakeHub({ takes: [{ ...IDLE, request: { ...REQUEST, headSha: "newer" }, reviewers: [{ ...reviewer(), head: "older" }] }], dones: [ENDED] });
    expect((await runMail(github, wake(), host, hub.hub)).ran).toEqual(["approvals", "done", "paused", "ran", "take"]);
    expect(writes).toEqual([]);
    expect(hub.calls).toEqual([TAKE, DONE, STOP_REVIEW, END]);
  });

  test("a review an earlier manager deployed is left to run out its own deadline", async () => {
    const { host } = githubHost();
    const inherited = { ...reviewer(), head: "older", runId: INHERITED, deployedBy: "run_earlier" };
    const hub = fakeHub({ takes: [{ ...IDLE, request: { ...REQUEST, headSha: "newer" }, reviewers: [inherited] }], dones: [ENDED] });
    expect((await runMail(github, wake(), host, hub.hub)).terminalStatus).toBe("completed");
    expect(hub.calls).toEqual([TAKE, DONE, END]);
  });

  test("a pass of an approval alone, before any pull request mail was recorded, runs it and triages nothing", async () => {
    const { approval, effectId } = await heldApproval();
    const { writes, host } = githubHost();
    const hub = fakeHub({ takes: [{ ...PASS, events: [mailEvent(HEAD, approval, "evt_approval")], request: undefined }], dones: [ENDED] });
    const { ran, outputs } = await runMail(github, wake(), host, hub.hub);
    expect(ran).toEqual(["approvals", "done", "paused", "ran", "take", "triaged"]);
    expect(outputs["approvals"]).toEqual({ results: [{ dos: [expect.objectContaining({ effectId, status: "done" })] }] });
    expect(doneBody(hub.calls)["approvals"]).toEqual(outputs["approvals"]);
    expect(writes).toEqual([expect.objectContaining({ method: "POST", path: `/repos/${PR.repo}/issues/${PR.number}/comments`, body: { body: expect.stringMatching(/\nhi$/) } })]);
    expect(hub.calls).toEqual([TAKE, DONE, END]);
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

  test("a pass that fails stops the run, so the claim's run is gone for the next manager's take", async () => {
    const { host } = githubHost();
    const hub = fakeHub({ takes: [{ error: "not json" }] });
    const { terminalStatus } = await runMail(github, wake(), host, hub.hub);
    expect(terminalStatus).toBe("failed");
    expect(hub.calls).toEqual([TAKE, END]);
  });

  test("a new pull request whose first mail is the hub holding it for CI gets the Waiting label", async () => {
    const { writes, host } = githubHost();
    const hub = fakeHub({ takes: [{ ...PASS, events: [mailEvent(HEAD, { ...REQUEST, kind: WAITING_KIND })], request: undefined }], dones: [ENDED] });
    const { ran } = await runMail(github, wake(), host, hub.hub);
    expect(ran).toContain("markWaiting");
    expect(ran).not.toContain("facts");
    expect(writes).toEqual([expect.objectContaining({ method: "POST", path: `/repos/${PR.repo}/issues/${PR.number}/labels`, body: { labels: [WAITING_LABEL] } })]);
  });

  test("on Bitbucket Data Center a new pull request held for CI gets an in-progress build status", async () => {
    const { builds, host } = bitbucketHost();
    const held = { ...REQUEST, kind: WAITING_KIND, repo: BB_REPO, repoSource: "bitbucket-datacenter", headSha: "abc" };
    const bbPull = { source: "bitbucket-datacenter", repo: BB_REPO, number: 8 };
    const hub = fakeHub({ takes: [{ ...PASS, pass: { ...PASS.pass, head: "abc" }, events: [mailEvent("abc", held)], request: undefined }], dones: [ENDED] });
    const { ran } = await runMail(bitbucket, wake(bbPull), host, hub.hub);
    expect(ran).toContain("markWaiting");
    expect(builds).toEqual([expect.objectContaining({ state: "INPROGRESS" })]);
  });

  test("on Bitbucket Data Center it reaches the host through that host's bindings only", async () => {
    expect(bitbucket.credentialBindings?.map(({ action, handle }) => `${action}:${handle}`)).toEqual(["facts:bitbucket-datacenter", "mirror:bitbucket-datacenter", "execute:bitbucket-datacenter", "executeApprovals:bitbucket-datacenter", "postReview:bitbucket-datacenter"]);
    const { builds, host } = bitbucketHost();
    const request = { kind: "pr", repo: BB_REPO, repoSource: "bitbucket-datacenter", prNumber: 8, headSha: "abc", policy: { enabled: true }, policyUnreadable: "The policy file has unknown checks: max-size.", automatic: ACTION_KINDS, tenantId: TENANT };
    const bbPull = { source: "bitbucket-datacenter", repo: BB_REPO, number: 8 };
    const hub = fakeHub({ takes: [{ ...PASS, pass: { ...PASS.pass, head: "abc" }, events: [mailEvent("abc", request)], request }], dones: [ENDED] });
    expect((await runMail(bitbucket, wake(bbPull), host, hub.hub)).terminalStatus).toBe("completed");
    expect(builds).toEqual([expect.objectContaining({ state: "FAILED" })]);
    expect(hub.calls.map(({ body }) => body)).toEqual([bbPull, expect.objectContaining({ ...bbPull, reviewers: [] }), undefined]);
  });
});

describe("triage-manager with code review", () => {
  const reviewed = github;
  beforeEach(() => publish({ github: { codeReview: RELEASE } }));
  const ON = hubRequest(RULES, { ...CODE_REVIEW, ...REVIEW_REQUEST });

  test("the first pass deploys the review and mails it, posting nothing; the pass that collects its report posts the verdict and the review together", async () => {
    const { writes, host } = githubHost();
    const mailed: unknown[] = [];
    const first = fakeHub({ takes: [{ ...PASS, request: ON }], dones: [ENDED] });
    expect((await runMail(reviewed, wake(), host, first.hub, mailed)).ran).toContain("doneReviewing");
    expect(writes).toEqual([]);
    expect(first.calls[1]).toMatchObject({ ...DEPLOY, body: { source: { kind: "asset", assetId: "ast_review", package: { format: "source", commitSha: "c0ffee", packageName: RELEASE.workflow.packageName } }, entry: RELEASE.workflow.entry, sourceOfferingIds: ["off_a"], defaultSourceOfferingId: "off_a" } });
    expect(first.calls[2]).toMatchObject({ ...DONE, body: { reviewers: [{ kind: "code-review", head: HEAD, runId: DEPLOYED, deployedBy: RUN }] } });
    const [mail] = mailed as [{ tenantId: string; to: string; content: string; readyBy: string }];
    expect(Date.parse(mail.readyBy)).toBeGreaterThan(Date.now());
    expect({ ...mail, content: JSON.parse(mail.content) }).toMatchObject({ tenantId: TENANT, to: DEPLOYED, content: { ...REVIEW_REQUEST.codeReviewRequest, tenantId: TENANT, reply: { to: RUN, content: manageMail(TENANT, PULL) } } });

    const second = fakeHub({ takes: [reported({ result: REVIEW }, ON)], dones: [ENDED] });
    const { ran } = await runMail(reviewed, wake(), host, second.hub, mailed);
    expect(ran).toContain("postReview");
    expect(ran).not.toContain("deployReview");
    expect(writes).toContainEqual(NOT_READY);
    expect(writes).toContainEqual(POSTED_REVIEW);
    expect(second.calls).toEqual([TAKE, { ...DONE, body: expect.objectContaining({ ...PULL, reviewers: [{ ...reviewer(), result: REVIEW }] }) }, END]);
    expect(mailed).toHaveLength(1);
  });

  test("a later event on the same head deploys no second review and posts the stored review with the verdict", async () => {
    const { writes, host } = githubHost();
    const mailed: unknown[] = [];
    const later = { ...PASS, request: ON, events: [mailEvent(HEAD, ON, "evt_2")], reviewers: [{ ...reviewer(), result: REVIEW }] };
    const hub = fakeHub({ takes: [later], dones: [ENDED] });
    const { ran } = await runMail(reviewed, wake(), host, hub.hub, mailed);
    expect(ran).not.toContain("deployReview");
    expect(writes).toContainEqual(NOT_READY);
    expect(writes).toContainEqual(POSTED_REVIEW);
    expect(mailed).toEqual([]);
    expect(hub.calls).toEqual([TAKE, { ...DONE, body: expect.objectContaining({ ...PULL, reviewers: [{ ...reviewer(), result: REVIEW }] }) }, END]);
  });

  test("Review again on a head whose review settled deploys one more review for it, and that review's report is posted", async () => {
    const { writes, host } = githubHost();
    const mailed: unknown[] = [];
    const again = hubRequest(RULES, { codeReview: { ...CODE_REVIEW.codeReview, again: "again_1" }, ...REVIEW_REQUEST });
    const settled = { ...reviewer(), runId: "run_earlier", result: REVIEW };
    const first = fakeHub({ takes: [{ ...PASS, request: again, events: [mailEvent(HEAD, again, "evt_2")], reviewers: [settled] }], dones: [ENDED] });
    expect((await runMail(reviewed, wake(), host, first.hub, mailed)).ran).toContain("deployReview");
    expect(writes).toEqual([]);
    expect(mailed).toHaveLength(1);
    expect(first.calls.at(-2)).toMatchObject({ ...DONE, body: { reviewers: [settled, { kind: "code-review", head: HEAD, runId: DEPLOYED, again: "again_1" }] } });

    const second = fakeHub({ takes: [{ ...reported({ result: REVIEW }, again), reviewers: [settled, { ...reviewer(), again: "again_1" }] }], dones: [ENDED] });
    const { ran } = await runMail(reviewed, wake(), host, second.hub, mailed);
    expect(ran).not.toContain("deployReview");
    expect(writes).toContainEqual(POSTED_REVIEW);
    expect(mailed).toHaveLength(1);
  });

  test("a stored review is not posted once this pass's policy no longer asks for code review", async () => {
    const { writes, host } = githubHost();
    const hub = fakeHub({ takes: [{ ...PASS, reviewers: [{ ...reviewer(), result: REVIEW }] }], dones: [ENDED] });
    const { ran } = await runMail(reviewed, wake(), host, hub.hub);
    expect(ran).toContain("postReview");
    expect(writes).toContainEqual(READY);
    expect(writes).not.toContainEqual(POSTED_REVIEW);
  });

  test.each([
    ["the review reported a failure", reported({ failed: "the review did not finish" }, ON), [TAKE, DONE, END]],
    ["the review ran past its deadline, which is stopped,", { ...IDLE, request: ON, reviewers: [reviewer("2000-01-01T00:00:00.000Z")] }, [TAKE, DONE, STOP_REVIEW, END]],
    ["the hub read no review request", { ...PASS, request: hubRequest(RULES, CODE_REVIEW) }, [TAKE, DONE, END]],
  ])("when %s the verdict goes up without code review", async (_name, taken, calls) => {
    const { writes, host } = githubHost();
    const hub = fakeHub({ takes: [taken], dones: [ENDED] });
    const { ran } = await runMail(reviewed, wake(), host, hub.hub);
    expect(ran).not.toContain("deployReview");
    expect(writes).toContainEqual(READY);
    expect(writes).not.toContainEqual(POSTED_REVIEW);
    expect(hub.calls).toEqual(calls);
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

  test.each([
    ["a changed file `when.paths` keeps is reviewed", { paths: ["!**/*.md"] }, {}, true],
    ["fewer files read than changed are never left out by `when.paths`", { paths: ["!**/*.ts"] }, { pull: { changed_files: 2 } }, true],
    ["a pull request triage could not read waits for its review while `for` could leave it out", { for: ["maintainers"] }, { pull: { changed_files: 2 }, unread: true }, false],
  ])("%s, with no skip recorded", async (_name, limit, { pull, unread }: { pull?: Record<string, unknown>; unread?: true }, deployed) => {
    const { host } = githubHost(HEAD, { pull });
    async function files(url: URL, init?: RequestInit): Promise<Response> {
      return unread && url.pathname.endsWith("/files") ? Response.json({ message: "Server Error" }, { status: 500 }) : host(url, init);
    }
    const hub = fakeHub({ takes: [{ ...PASS, request: hubRequest(RULES, { codeReview: { ...CODE_REVIEW.codeReview, ...limit }, ...REVIEW_REQUEST }) }], dones: [ENDED] });
    const { ran } = await runMail(reviewed, wake(), files, hub.hub);
    expect(ran.includes("deployReview")).toBe(deployed);
    expect(JSON.stringify(doneBody(hub.calls) ?? {})).not.toContain("codeReviewSkipped");
  });

  const CLEAN = { result: { ...REVIEW, comments: [] } };

  /** One pass of a policy that approves a Pass, on `head` with CI green, taking what `take` builds from its request. */
  async function approvingPass(take: (request: Record<string, unknown>) => Record<string, unknown>, checks: Record<string, unknown> = CODE_REVIEW, head = HEAD) {
    const approving: CheckPack = { ...RULES, actions: { ...RULES.actions, pass: [{ do: "approve" }] } };
    const { writes, host } = githubHost(head, { checkRuns: [{ name: "ci", status: "completed", conclusion: "success" }] });
    const hub = fakeHub({ takes: [take(hubRequest(approving, { ...checks, ...REVIEW_REQUEST }))], dones: [ENDED] });
    return { writes, outputs: (await runMail(reviewed, wake(), host, hub.hub)).outputs };
  }

  function approved(writes: readonly Write[]): boolean {
    return writes.some((write) => (write.body as { event?: string } | undefined)?.event === "APPROVE");
  }
  test.each([
    ["a clean review", CLEAN, CODE_REVIEW, undefined],
    ["a review that failed", { failed: "the review did not finish" }, CODE_REVIEW, "Code review did not report on this head."],
    ["a pull request `when.paths` leaves out of code review", undefined, { ...CODE_REVIEW, codeReview: { ...CODE_REVIEW.codeReview, paths: ["!**/*.ts"] } }, undefined],
    ["only a check that can't run yet", undefined, { codeReview: { ...CODE_REVIEW.codeReview, on: false }, blocks: ["security"] }, "The policy's security check can't run yet."],
    ["a check that can't run yet beside a clean review", CLEAN, { ...CODE_REVIEW, blocks: ["code-review", "security"] }, "The policy's security check can't run yet."],
  ])("a passing verdict's approve runs on its own only after a clean code review or none the policy asks for: %s", async (_name, report, checks, reason) => {
    const { writes, outputs } = await approvingPass((request) => (report ? reported(report, request) : { ...PASS, request }), checks);
    const [approve] = (outputs["cleared"] as { actions: Record<string, unknown>[] }).actions;
    expect(approve).toMatchObject({ kind: "approve", ...(reason && { held: true, reason }) });
    expect(approved(writes)).toBe(reason === undefined);
  });

  test("a head whose review has a P0 finding fails and is not approvable, so the approval of the clean head before it is taken back", async () => {
    const clean = await approvingPass((request) => reported(CLEAN, request));
    expect(approved(clean.writes)).toBe(true);
    const NEWER = "0e0e".repeat(10);
    const p0 = { result: { ...REVIEW, comments: [{ ...REVIEW.comments[0]!, priority: 0 }] } };
    function newer(request: Record<string, unknown>) {
      const pushed = { ...request, headSha: NEWER };
      const report = reported(p0, pushed);
      return { ...report, pass: { ...report.pass, head: NEWER }, events: report.events.map(({ key, event }) => ({ key, event: { ...event, head: NEWER } })), reviewers: [{ ...reviewer(), head: NEWER }] };
    }
    const { writes, outputs } = await approvingPass(newer, CODE_REVIEW, NEWER);
    expect(outputs["cleared"]).toMatchObject({ headSha: NEWER, verdict: "fail", approvable: false, actions: [] });
    expect(approved(writes)).toBe(false);
  });

  test("after Review again, a later pass judges the newest review of the head", async () => {
    const p0 = { ...REVIEW, comments: [{ ...REVIEW.comments[0]!, priority: 0 }] };
    const first = { ...reviewer("2998-01-01T00:00:00.000Z"), runId: "run_first", result: p0 };
    const again = { ...reviewer(), again: "again_1", result: CLEAN.result };
    const { writes, outputs } = await approvingPass((request) => ({ ...PASS, request, reviewers: [first, again] }));
    expect((outputs["cleared"] as { actions: Record<string, unknown>[] }).actions[0]).not.toHaveProperty("held");
    expect(approved(writes)).toBe(true);
  });

  const APPROVE_DO = { list: "pass", index: 0, kind: "approve", effectId: "do:approve", target: {}, reason: "every rule passed" };
  const CI_FAILED = [{ check: "ci-green", kind: "machine", result: "fail" }];
  const finding = (priority?: number) => ({ ...REVIEW, comments: [{ ...REVIEW.comments[0]!, ...(priority !== undefined && { priority }) }] });
  const FAILED = { verdict: "fail", reason: "Code review found 1 problem on this head.", approvable: false, actions: [{ list: "fail", kind: "request-changes" }] };
  const FAILING: CheckPack = { ...RULES, actions: { ...RULES.actions, pass: [{ do: "approve" }], fail: [{ do: "request-changes" }] } };
  test.each([
    ["a review with one P2 finding fails the verdict, runs the policy's fail Dos and is not approvable", finding(2), {}, FAILED],
    ["a finding at `clean.below` fails the verdict", finding(1), { clean: { below: "high" } }, FAILED],
    ["a finding with no priority counts at any `clean.below`", finding(), { clean: { below: "critical" } }, FAILED],
    ["a clean review leaves the verdict as the rules made it", CLEAN.result, {}, { verdict: "pass", approvable: true, actions: [{ list: "pass", kind: "approve" }] }],
  ])("%s", async (_name, review, codeReview, cleared) => {
    const { writes, host } = githubHost(HEAD, { checkRuns: [{ name: "ci", status: "completed", conclusion: "success" }] });
    const request = hubRequest(FAILING, { ...CODE_REVIEW, codeReview: { ...CODE_REVIEW.codeReview, ...codeReview }, ...REVIEW_REQUEST });
    const hub = fakeHub({ takes: [reported({ result: review }, request)], dones: [ENDED] });
    const { outputs } = await runMail(reviewed, wake(), host, hub.hub);
    if (cleared.verdict === "fail") expect(outputs["evaluateRules"]).toMatchObject({ verdict: "pass", approvable: true });
    expect(outputs["cleared"]).toMatchObject(cleared);
    expect(approved(writes)).toBe(cleared.verdict === "pass");
    expect(writes.some((write) => (write.body as { event?: string } | undefined)?.event === "REQUEST_CHANGES")).toBe(cleared.verdict === "fail");
  });

  const REVIEW_REASON = "Code review found 1 problem on this head.";
  const CI_REASON = "required checks are failing: ci";
  test.each([
    ["a Fail its rules made keeps its verdict and adds the review's reason and check", FAILING, "fail", `required checks are failing; ${REVIEW_REASON}`, true],
    ["an Unsure stays Unsure with the review's problems added, approve and merge held for a maintainer", { ...FAILING, checks: { "ci-green": { enabled: true, onFail: "ask" } } } as CheckPack, "unsure", `${CI_REASON}; ${REVIEW_REASON}`, false],
  ])("%s", async (_name, pack, verdict, reason, changes) => {
    const { writes, host } = githubHost(HEAD, { checkRuns: [{ name: "ci", status: "completed", conclusion: "failure" }] });
    const hub = fakeHub({ takes: [reported({ result: finding(2) }, hubRequest(pack, { ...CODE_REVIEW, ...REVIEW_REQUEST }))], dones: [ENDED] });
    const { outputs } = await runMail(reviewed, wake(), host, hub.hub);
    const cleared = outputs["cleared"] as { verdict: string; reason: string; reasons: string[]; feedback: string; checks: Record<string, unknown>[] };
    expect(cleared.verdict).toBe(verdict);
    expect(cleared.reasons).toEqual([CI_REASON, REVIEW_REASON]);
    expect(cleared.checks.at(-1)).toEqual({ check: "code-review", kind: "machine", result: "fail", reason: REVIEW_REASON, evidence: [], output: { kind: "values", values: { findings: 1 } } });
    expect(cleared.reason).toBe(reason);
    expect(cleared.feedback).toContain(`- ${REVIEW_REASON}`);
    expect(cleared.feedback).toContain("- required checks are failing: `ci`");
    expect(writes.some((write) => (write.body as { event?: string } | undefined)?.event === "REQUEST_CHANGES")).toBe(changes);
    expect(approved(writes)).toBe(false);
  });

  /** The rules output and the verdict of a pass whose review was clean, for `cleared` to be run on by hand. */
  async function cleanPass(pack = FAILING) {
    const { host } = githubHost(HEAD, { checkRuns: [{ name: "ci", status: "completed", conclusion: "success" }] });
    const hub = fakeHub({ takes: [reported(CLEAN, hubRequest(pack, { ...CODE_REVIEW, ...REVIEW_REQUEST }))], dones: [ENDED] });
    const { outputs } = await runMail(reviewed, wake(), host, hub.hub);
    return { rules: outputs["rules"] as { items: Record<string, unknown>[] }, verdict: outputs["evaluateRules"] as Record<string, unknown> };
  }

  function takenWith(blocks: string[]) {
    return { run: true, approvals: [], triage: true, overdue: false, reviewers: [], head: HEAD, review: finding(2), taken: { blocks, ...CODE_REVIEW } };
  }

  test.each([
    ["an Unsure waiting on CI", { verdict: "unsure", waiting: true, reason: "CI is still running", feedback: "", actor: "system", nextAction: "Wait for checks to finish" }],
    ["an Unsure the decision model could not make", { verdict: "unsure", degraded: "inference-outage", reason: "decision model unavailable", feedback: "", actor: "maintainer", nextAction: "Review" }],
  ])("%s keeps its state and gains the review's check, reason, next step and comment, approve and merge held", async (_name, unsure) => {
    const { rules, verdict } = await cleanPass();
    const made = await actions.cleared({ take: { output: takenWith(["code-review"]) }, rules: { output: rules }, evaluateRules: { output: { ...verdict, ...unsure } }, reviewScope: { output: { reviewed: true } } }) as Record<string, unknown> & { reasons: string[]; checks: Record<string, unknown>[] };
    expect(made).toMatchObject({ ...unsure, reason: `${unsure.reason}; ${REVIEW_REASON}`, nextAction: `${unsure.nextAction}; the author fixes: ${REVIEW_REASON}`, approvable: false, feedback: `**Triage: Unsure**\n\n@octocat, please address the following:\n- ${REVIEW_REASON}` });
    expect(made.reasons.at(-1)).toBe(REVIEW_REASON);
    expect(made.checks.at(-1)).toMatchObject({ check: "code-review", result: "fail", output: { kind: "values", values: { findings: 1 } } });
    expect(made).toMatchObject({ mirror: true, request: { comment: expect.stringContaining(`- ${REVIEW_REASON}`) } });
  });

  test("a degraded verdict that names no head gains the review's problems and is still not posted", async () => {
    const { rules, verdict } = await cleanPass();
    const degraded = { ...verdict, verdict: "unsure", headSha: null, degraded: "error", mirror: false, reason: "render failed", feedback: "" };
    const made = await actions.cleared({ take: { output: takenWith(["code-review"]) }, rules: { output: rules }, evaluateRules: { output: degraded }, reviewScope: { output: { reviewed: true } } }) as Record<string, unknown> & { reasons: string[] };
    expect(made).toMatchObject({ verdict: "unsure", headSha: null, degraded: "error", mirror: false, reason: `render failed; ${REVIEW_REASON}` });
    expect(made.reasons.at(-1)).toBe(REVIEW_REASON);
  });

  test("a Pass a policy that never approves turns to Fail stays without an approvable", async () => {
    const { rules, verdict } = await cleanPass({ ...FAILING, actions: { ...FAILING.actions, pass: [] } });
    expect(verdict).not.toHaveProperty("approvable");
    const made = await actions.cleared({ take: { output: takenWith(["code-review"]) }, rules: { output: rules }, evaluateRules: { output: verdict }, reviewScope: { output: { reviewed: true } } });
    expect(made).toMatchObject({ verdict: "fail", reason: REVIEW_REASON });
    expect(made).not.toHaveProperty("approvable");
  });

  test("a review's problems on a take that names no head hold approve and merge on the verdict as the rules made it", async () => {
    const { rules, verdict } = await cleanPass();
    const { head: _head, ...headless } = takenWith(["code-review"]);
    const made = await actions.cleared({ take: { output: headless }, rules: { output: rules }, evaluateRules: { output: verdict }, reviewScope: { output: { reviewed: true } } });
    expect(made).toEqual({ ...verdict, approvable: false, actions: [{ ...(verdict["actions"] as object[])[0], held: true, reason: REVIEW_REASON }] });
  });

  test("a degraded verdict that names no head, with no rules item for its pull request, is held rather than failing the step", async () => {
    const { verdict } = await cleanPass();
    const degraded = { ...verdict, verdict: "unsure", headSha: null, degraded: "error", mirror: false, reason: "render failed", feedback: "" };
    const elsewhere = { items: [{ facts: { number: PR.number + 1, headSha: HEAD } }] };
    const made = await actions.cleared({ take: { output: takenWith(["code-review"]) }, rules: { output: elsewhere }, evaluateRules: { output: degraded }, reviewScope: { output: { reviewed: true } } });
    expect(made).toMatchObject({ verdict: "unsure", headSha: null, reason: "render failed", approvable: false });
  });

  test("a review's problems fail a Pass while another check the policy turns on can't run yet", async () => {
    const { rules, verdict } = await cleanPass();
    const made = await actions.cleared({ take: { output: takenWith(["code-review", "security"]) }, rules: { output: rules }, evaluateRules: { output: verdict }, reviewScope: { output: { reviewed: true } } });
    expect(made).toMatchObject(FAILED);
  });

  const PASSED = { number: PR.number, headSha: HEAD, verdict: "pass", reason: "every rule passed", reasons: [], feedback: "", degraded: null, checks: [], actions: [APPROVE_DO] };
  const NEWER = "0e0e".repeat(10);
  test.each([
    ["a rules item the verdict cannot be made from", PASSED, [{ facts: { number: PR.number, headSha: HEAD } }]],
    ["no rules item at the verdict's head, such as a judge's verdict on a head the rules read past", PASSED, [{ facts: { number: PR.number, headSha: NEWER } }]],
  ])("a review's problems with %s leave the verdict as the rules made it, approve held", async (_name, verdict, items) => {
    const made = await actions.cleared({ take: { output: takenWith(["code-review"]) }, rules: { output: { items } }, evaluateRules: { output: verdict }, reviewScope: { output: { reviewed: true } } });
    expect(made).toEqual({ ...verdict, actions: [{ ...APPROVE_DO, held: true, reason: REVIEW_REASON }] });
  });

  test("a review's problems on a verdict the rules made for a newer head than the review's hold approve and merge, the verdict as the rules made it", async () => {
    const { rules, verdict } = await cleanPass();
    const items = rules.items.map((item) => ({ ...item, facts: { ...(item["facts"] as object), headSha: NEWER } }));
    const newer = { ...verdict, headSha: NEWER };
    const made = await actions.cleared({ take: { output: takenWith(["code-review"]) }, rules: { output: { items } }, evaluateRules: { output: newer }, reviewScope: { output: { reviewed: true } } });
    expect(made).toMatchObject({ verdict: "pass", headSha: NEWER, approvable: false, actions: [{ kind: "approve", held: true, reason: REVIEW_REASON }] });
  });

  test.each([
    ["a finding below `clean.below` does not", finding(2), { clean: { below: "high" } }, { reviewed: true }, undefined],
    ["a review cut for size holds", { ...CLEAN.result, cut: { lines: 1, of: 2 } }, {}, { reviewed: true }, "Code review did not read the whole change on this head."],
    ["a review that stopped early holds", { ...CLEAN.result, budgetExhausted: true }, {}, { reviewed: true }, "Code review did not read the whole change on this head."],
    ["a review skipped for failed rules holds", undefined, { rules: "pass" }, { reviewed: false, skipped: "rules failed: CI green" }, "Code review did not run on this head."],
    ["a review `for` leaves out does not", undefined, { rules: "pass", for: ["maintainers"] }, { reviewed: false, skipped: "the author is not in the maintainers group" }, undefined],
  ])("cleared: %s", async (_name, review, codeReview, scope, reason) => {
    const checks = scope.skipped?.startsWith("rules failed") ? CI_FAILED : [];
    const take = { run: true, approvals: [], triage: true, overdue: false, reviewers: [], head: HEAD, ...(review && { review }), taken: { blocks: ["code-review"], codeReview: { ...CODE_REVIEW.codeReview, ...codeReview } } };
    const { actions: [approve] } = await actions.cleared({ take: { output: take }, rules: { output: { items: [] } }, evaluateRules: { output: { ...PASSED, checks } }, reviewScope: { output: scope } }) as { actions: Record<string, unknown>[] };
    expect(approve).toEqual(reason === undefined ? APPROVE_DO : { ...APPROVE_DO, held: true, reason });
  });

  test("cleared keeps the reason of a Do already held, such as for CI", async () => {
    const waiting = { ...APPROVE_DO, kind: "merge", held: true, reason: "Waiting for checks to finish." };
    const take = { run: true, approvals: [], triage: true, overdue: false, reviewers: [], head: HEAD, review: { ...REVIEW, cut: { lines: 1, of: 2 } }, taken: { blocks: ["code-review"], ...CODE_REVIEW } };
    const { actions: [merge] } = await actions.cleared({ take: { output: take }, rules: { output: { items: [] } }, evaluateRules: { output: { ...PASSED, actions: [waiting] } }, reviewScope: { output: { reviewed: true } } }) as { actions: Record<string, unknown>[] };
    expect(merge).toEqual(waiting);
  });

  test("a review that could not be mailed by its deadline leaves the verdict to go up alone, waiting for no reviewer", async () => {
    const { writes, host } = githubHost();
    const hub = fakeHub({ takes: [{ ...PASS, request: ON }], dones: [ENDED] });
    const { ran } = await runMail(reviewed, wake(), host, hub.hub, [], false);
    expect(ran).toContain("deployReview");
    expect(ran).not.toContain("doneReviewing");
    expect(writes).toContainEqual(READY);
    expect(hub.calls.at(-2)).toEqual(DONE);
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

  test("the first pass deploys the judge and mails it the rules, posting nothing; the pass that collects its report posts its verdict as reported and keeps it on the head", async () => {
    const { writes, host } = githubHost();
    const mailed: unknown[] = [];
    const first = fakeHub({ takes: [{ ...PASS, request: hubRequest(JUDGED) }], dones: [ENDED] });
    expect((await runMail(github, wake(), host, first.hub, mailed)).ran).toContain("doneJudging");
    expect(writes).toEqual([]);
    expect(first.calls[1]).toMatchObject({ ...DEPLOY, body: { source: { kind: "asset", assetId: "ast_judge", package: { format: "source", commitSha: "c0ffee", packageName: JUDGE_RELEASE.workflow.packageName } }, entry: JUDGE_RELEASE.workflow.entry, sourceOfferingIds: ["off_d"], defaultSourceOfferingId: "off_d" } });
    expect(first.calls[2]).toMatchObject({ ...DONE, body: { reviewers: [{ kind: "judge", head: HEAD, runId: DEPLOYED, deployedBy: RUN }] } });
    const [mail] = mailed as [{ tenantId: string; to: string; content: string; readyBy: string }];
    const content = JSON.parse(mail.content) as { kind: string; rules: MailedRules; reply: { to: string } };
    expect(content.kind).toBe("judge");
    expect(content.rules.chunks.length).toBeGreaterThan(0);
    expect(content.reply.to).toBe(RUN);
    expect(Date.parse(mail.readyBy)).toBeGreaterThan(Date.now());

    const verdict = await judgeVerdict(content.rules);
    const second = fakeHub({ takes: [judgeReported(verdict)], dones: [ENDED] });
    const { ran, outputs } = await runMail(github, wake(), host, second.hub, mailed);
    expect(ran).not.toContain("deployJudge");
    expect(outputs["evaluateRules"]).toEqual(verdict);
    expect(writes).toContainEqual(JUDGE_POSTED);
    expect(second.calls[1]).toEqual({ ...DONE, body: expect.objectContaining({ ...PULL, reviewers: [{ ...JUDGE, result: verdict }] }) });
    expect(doneBody(second.calls)["report"]).toMatchObject({ head: HEAD, verdict });
    expect(mailed).toHaveLength(1);
  });

  test("a pass that mailed its judge and answers more runs the next pass, which ends", async () => {
    const { host } = githubHost();
    const hub = fakeHub({ takes: [{ ...PASS, request: hubRequest(JUDGED) }, IDLE], dones: [MORE, ENDED] });
    expect(await runMail(github, wake(), host, hub.hub)).toMatchObject({ terminalStatus: "completed", passes: 2 });
    expect(hub.calls.filter((call) => call.path === DONE.path)).toHaveLength(2);
  });

  test("a later event on the same head deploys no second judge and posts the judge's verdict, whatever changed on the pull request since", async () => {
    const verdict = await judgeVerdict(JSON.parse((await firstJudgeMail()).content).rules);
    const { writes, host } = githubHost(HEAD, { pr: { ...PR, title: "Renamed since", body: "", bodyHtml: "" } });
    const later = { ...PASS, request: hubRequest(JUDGED), events: [mailEvent(HEAD, hubRequest(JUDGED), "evt_2")], reviewers: [{ ...JUDGE, result: verdict }] };
    const hub = fakeHub({ takes: [later], dones: [ENDED] });
    const { ran, outputs } = await runMail(github, wake(), host, hub.hub);
    expect(ran).not.toContain("deployJudge");
    expect(outputs["evaluateRules"]).toEqual(verdict);
    expect(writes).toContainEqual(JUDGE_POSTED);
    expect(hub.calls).toEqual([TAKE, { ...DONE, body: expect.objectContaining({ ...PULL, reviewers: [{ ...JUDGE, result: verdict }] }) }, END]);
    expect(doneBody(hub.calls)["report"]).toMatchObject({ head: HEAD, verdict });
  });

  test("a stored verdict gives way when this pass's rules no longer need the judge, as on a draft", async () => {
    const verdict = await judgeVerdict(JSON.parse((await firstJudgeMail()).content).rules);
    const { writes, host } = githubHost(HEAD, { pull: { draft: true } });
    const hub = fakeHub({ takes: [{ ...PASS, request: hubRequest(JUDGED), reviewers: [{ ...JUDGE, result: verdict }] }], dones: [ENDED] });
    const { ran, outputs } = await runMail(github, wake(), host, hub.hub);
    expect(ran).not.toContain("judgeScope");
    expect(outputs["evaluateRules"]).not.toEqual(verdict);
    expect(writes).not.toContainEqual(JUDGE_POSTED);
  });

  test("a judge's verdict that names no head goes up as a failed judge, and the pass still ends", async () => {
    const verdict = await judgeVerdict(JSON.parse((await firstJudgeMail()).content).rules);
    const { writes, host } = githubHost();
    const hub = fakeHub({ takes: [judgeReported({ ...verdict, headSha: null })], dones: [ENDED] });
    const { terminalStatus, ran } = await runMail(github, wake(), host, hub.hub);
    expect(terminalStatus).toBe("completed");
    expect(ran).toContain("mirrorRules");
    expect(writes).not.toContainEqual(JUDGE_POSTED);
    expect(hub.calls).toEqual([TAKE, DONE, END]);
  });

  test.each([
    ["an approve skipped until CI passes", { kind: "approve", list: "pass", index: 0, skipped: true, reason: "CI has not passed on this head." }],
    ["a merge held for failing CI", { kind: "merge", list: "pass", index: 0, effectId: "do:merge", target: {}, held: true, reason: "CI has failed on this head." }],
  ])("a stored verdict with %s is judged again, since CI on the same head can still change it", async (_name, action) => {
    const verdict = await judgeVerdict(JSON.parse((await firstJudgeMail()).content).rules);
    const { host } = githubHost();
    const hub = fakeHub({ takes: [{ ...PASS, request: hubRequest(JUDGED), reviewers: [{ ...JUDGE, result: { ...verdict, actions: [action] } }] }], dones: [ENDED] });
    expect((await runMail(github, wake(), host, hub.hub)).ran).toContain("deployJudge");
  });

  test("a judge's verdict for another pull request fails the pass instead of being posted", async () => {
    const verdict = await judgeVerdict(JSON.parse((await firstJudgeMail()).content).rules);
    const { writes, host } = githubHost();
    const hub = fakeHub({ takes: [judgeReported({ ...verdict, number: 9 })] });
    expect((await runMail(github, wake(), host, hub.hub)).terminalStatus).toBe("failed");
    expect(writes).toEqual([]);
  });

  test("a verdict too large to store is posted and dropped from the claim", async () => {
    const verdict = { ...await judgeVerdict(JSON.parse((await firstJudgeMail()).content).rules), padding: "x".repeat(300 * 1024) };
    const { writes, host } = githubHost();
    const hub = fakeHub({ takes: [judgeReported(verdict)], dones: [ENDED] });
    await runMail(github, wake(), host, hub.hub);
    expect(writes).toContainEqual(JUDGE_POSTED);
    expect(hub.calls[1]).toEqual(DONE);
  });

  test("while CI runs the judge waits and the head is marked waiting; a verdict CI could still change is judged again once CI finished, and its Dos run", async () => {
    const pack: CheckPack = { ...JUDGED, checks: { ...JUDGED.checks, "ci-green": { enabled: true } }, actions: { ...JUDGED.actions, pass: [{ do: "comment", target: { body: "Welcome" } }] } };
    const request = hubRequest(pack);
    const running = githubHost(HEAD, { checkRuns: [{ name: "ci", status: "in_progress", conclusion: null }] });
    const waiting = fakeHub({ takes: [{ ...PASS, request }], dones: [ENDED] });
    expect((await runMail(github, wake(), running.host, waiting.hub)).ran).not.toContain("deployJudge");
    expect(running.writes).toContainEqual(expect.objectContaining({ path: `/repos/${PR.repo}/issues/${PR.number}/labels`, body: { labels: [WAITING_LABEL] } }));

    const passed = [{ name: "ci", status: "completed", conclusion: "success" }];
    const mailed: unknown[] = [];
    const { writes, host } = githubHost(HEAD, { checkRuns: passed });
    const undecided = { ...await judgeVerdict(JSON.parse((await firstJudgeMail(request)).content).rules), waiting: true };
    const again = fakeHub({ takes: [{ ...PASS, request, reviewers: [{ ...JUDGE, result: undecided }] }], dones: [ENDED] });
    expect((await runMail(github, wake(), host, again.hub, mailed)).ran).toContain("deployJudge");
    expect(writes).toEqual([]);

    const verdict = await judgeVerdict(JSON.parse((mailed[0] as { content: string }).content).rules);
    const judged = fakeHub({ takes: [judgeReported(verdict, request)], dones: [ENDED] });
    await runMail(github, wake(), host, judged.hub);
    expect(writes).toContainEqual(JUDGE_POSTED);
    expect(writes).toContainEqual(expect.objectContaining({ path: `/repos/${PR.repo}/issues/${PR.number}/comments`, body: { body: expect.stringContaining("Welcome") } }));
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
    expect(writes.length).toBeGreaterThan(0);
    expect(writes).not.toContainEqual(JUDGE_POSTED);
    expect(hub.calls).toEqual(calls);
  });
});

/** The mail a first pass sends the judge it deploys. */
async function firstJudgeMail(request = hubRequest(JUDGED)): Promise<{ content: string }> {
  const mailed: unknown[] = [];
  await runMail(github, wake(), githubHost().host, fakeHub({ takes: [{ ...PASS, request }], dones: [ENDED] }).hub, mailed);
  return mailed[0] as { content: string };
}

describe("triage-manager with a judge and code review", () => {
  beforeEach(() => publish({ github: { judge: JUDGE_RELEASE, codeReview: RELEASE } }));

  test("posts the judge's verdict and the review together once both have reported, a finding failing the verdict and keeping the judge's words", async () => {
    const { writes, host } = githubHost();
    const mailed: unknown[] = [];
    const request = hubRequest(JUDGED, { ...CODE_REVIEW, ...REVIEW_REQUEST });
    const first = fakeHub({ takes: [{ ...PASS, request }], dones: [ENDED] });
    expect((await runMail(github, wake(), host, first.hub, mailed)).ran).toContain("doneJudging");
    expect(writes).toEqual([]);
    const verdict = await judgeVerdict(JSON.parse((mailed[0] as { content: string }).content).rules);

    const second = fakeHub({ takes: [judgeReported(verdict, request)], dones: [ENDED] });
    const again = await runMail(github, wake(), host, second.hub, mailed);
    expect(again.ran).toContain("deployReview");
    expect(again.ran).not.toContain("mirrorRules");
    expect(writes).toEqual([]);
    expect(second.calls[2]).toMatchObject({ body: { reviewers: [{ ...JUDGE, result: verdict }, expect.objectContaining({ kind: "code-review", runId: DEPLOYED })] } });

    const third = fakeHub({ takes: [{ ...reported({ result: REVIEW }, request), reviewers: [{ ...JUDGE, result: verdict }, reviewer()] }], dones: [ENDED] });
    const { ran } = await runMail(github, wake(), host, third.hub, mailed);
    expect(ran).toContain("postReview");
    expect(ran).not.toContain("deployJudge");
    expect(writes).toContainEqual(JUDGE_POSTED);
    expect(writes).toContainEqual(expect.objectContaining({ path: `/repos/${PR.repo}/issues/${PR.number}/comments`, body: { body: expect.stringContaining("**Triage: Fail**\n\n@octocat, please address the following:\n- Code review found 1 problem on this head.") } }));
    expect(writes).toContainEqual(NOT_READY);
    expect(writes).toContainEqual(POSTED_REVIEW);
    expect(third.calls[1]).toEqual({ ...DONE, body: expect.objectContaining({ ...PULL, reviewers: [{ ...JUDGE, result: verdict }, { ...reviewer(), result: REVIEW }] }) });
  });
});

describe("triage-listener", () => {
  beforeEach(() => publish({ github: { manager: RELEASE } }));

  test("a listener whose release publishes no manager fails the body with what is missing", async () => {
    publish({});
    const hub = fakeHub({ takes: [] });
    const mail = triggerMail(PR, RULES, { tenantId: TENANT });
    expect((await runMail(listener, mail, githubHost().host, hub.hub)).terminalStatus).toBe("failed");
    expect(hub.calls).toEqual([]);
  });

  test("it deploys a manager for each pull request a reconciler's mail names and wakes each with its pull request only", async () => {
    const hub = fakeHub({ takes: [] });
    const mailed: unknown[] = [];
    const mail = triggerMail(PR, RULES, { tenantId: TENANT, items: [{ prNumber: 8, headSha: HEAD }, { prNumber: 9, headSha: "h9" }] });
    const { terminalStatus } = await runMail(listener, mail, githubHost().host, hub.hub, mailed);
    expect(terminalStatus).toBe("completed");
    expect(hub.calls.map(({ method, path }) => ({ method, path }))).toEqual([DEPLOY, DEPLOY]);
    expect((mailed as { to: string; content: string }[]).map((sent) => [sent.to, JSON.parse(sent.content)])).toEqual([
      [DEPLOYED, JSON.parse(manageMail(TENANT, PULL))],
      [DEPLOYED, JSON.parse(manageMail(TENANT, { ...PULL, number: 9 }))],
    ]);
  });

  test("a mail that names no pull request, or is not from the hub, fails instead of being dropped", async () => {
    const hub = fakeHub({ takes: [] });
    const mail = triggerMail(PR, RULES, { tenantId: TENANT });
    const unnamed = { ...mail, parts: [{ ...mail.parts[0]!, text: JSON.stringify({ kind: "pr", repo: PR.repo, tenantId: TENANT }) }] };
    expect((await runMail(listener, unnamed, githubHost().host, hub.hub)).terminalStatus).toBe("failed");
    expect((await runMail(listener, { ...mail, headers: { from: "someone@triage.test", to: mail.headers.to } }, githubHost().host, hub.hub)).terminalStatus).toBe("failed");
    expect(hub.calls).toEqual([]);
  });
});

describe("grants", () => {
  const DEPLOY_GRANTS = [{ resource: "workflow:*", action: "create", source: "creator" }, { resource: "asset:ast_review", action: "read", source: "creator" }, { resource: "workflow-run:*", action: "read", source: "creator" }];
  const MANAGER_GRANTS = [{ resource: "triage-manager:state", action: "write", source: "creator" }, { resource: "workflow-run:self", action: "manage", source: "creator" }];

  test("a listener built with the release's manager declares the grants to deploy exactly that asset, and one built without declares none", () => {
    expect(triageListener({ id: "triage-listener-github", manager: RELEASE }).grantRequirements).toEqual(DEPLOY_GRANTS);
    expect(triageListener({ id: "triage-listener-github", manager: undefined }).grantRequirements).toEqual([]);
  });

  test("a manager built with the release's code review declares the grants to deploy exactly that asset, and one built without declares no asset read", () => {
    expect(triageManager({ id: "triage-manager-github", sources: ["github"], codeReview: RELEASE }).grantRequirements).toEqual([...MANAGER_GRANTS, ...DEPLOY_GRANTS]);
    expect(triageManager({ id: "triage-manager-github", sources: ["github"], codeReview: undefined }).grantRequirements).toEqual(MANAGER_GRANTS);
  });

  test("a manager built with the release's judge declares the grants to deploy exactly that asset", () => {
    const judgeGrants = [{ resource: "workflow:*", action: "create", source: "creator" }, { resource: "asset:ast_judge", action: "read", source: "creator" }, { resource: "workflow-run:*", action: "read", source: "creator" }];
    expect(triageManager({ id: "triage-manager-github", sources: ["github"], codeReview: undefined, judge: JUDGE_RELEASE }).grantRequirements).toEqual([...MANAGER_GRANTS, ...judgeGrants]);
  });
});
