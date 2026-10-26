import { describe, expect, test } from "bun:test";
import { actionConsumer } from "@intx/authz";
import { createActionCredentialsFactory, createCredentialProviderRegistry, createHttpCredentialProvider } from "@intx/harness";
import type { GrantRule } from "@intx/types/authz";
import { HUB_CREDENTIAL_HANDLE } from "@intx/types/credential-delivery";
import { runLocal, type ActionHandler, type LoopFn, type OnTriggerPrimitive, type WorkflowAuthorizeFn, type WorkflowDefinition } from "@intx/workflow";
import { ACTION_KINDS, APPROVE_DO_KIND, emptyPack, WAITING_KIND, WAITING_LABEL, type ActionKind, type CheckPack } from "@corbits/triage-contracts";
import type { Snapshot } from "@corbits/triage-workflows/evals/cases";
import { fixtureGithub, triggerMail } from "@corbits/triage-workflows/evals/serve";
import { delivered, grantsFor, type Bindings, type Fetch } from "@corbits/triage-workflows/local-credentials";
import { recordingGithub, type Write } from "@corbits/triage-workflows/run-local";
import * as actions from "./actions/index.js";
import { manageMail } from "./actions/hub.js";
import * as loops from "./loops.js";
import { workflow as bitbucket } from "./triage-manager-bitbucket-datacenter.js";
import { workflow as github } from "./triage-manager-github.js";
import { triageListener } from "./triage-listener.js";
import { triageManager } from "./triage-manager.js";

const TENANT = "tnt_acme";
const RUN = "run_manager";
const HUB_ORIGIN = "https://hub.test";
const TENANT_PATH = `/api/tenants/${TENANT}`;
const END = { method: "DELETE", path: `${TENANT_PATH}/workflows/runs/${RUN}` };
const DEPLOY = { method: "POST", path: `${TENANT_PATH}/workflows/deployments` };
const DEPLOYED = "run_deployed";
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
const CODE_REVIEW = { codeReview: { on: true, for: ["everyone"], triage: ["pass", "fail", "unsure"], rules: "any" } };
const REVIEW_REQUEST = { codeReviewRequest: { kind: "code-review", number: PR.number, title: PR.title, description: PR.body, diff: "diff --git a/src/flag.ts b/src/flag.ts", checkout: { source: "github", repo: PR.repo, sha: HEAD } } };
const REVIEW = { summary: "One bug.", comments: [{ path: "src/flag.ts", start: 1, end: 1, title: "Always true", body: "The flag can never be off." }], budgetExhausted: false };
const LATER = "2999-01-01T00:00:00.000Z";
const reviewer = (deadline = LATER) => ({ kind: "code-review", head: HEAD, runId: DEPLOYED, deadline });

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
    if (method === END.method && url.pathname === END.path) return new Response(null, { status: 202 });
    if (method === DEPLOY.method && url.pathname === DEPLOY.path) return Response.json({ id: DEPLOYED }, { status: 201 });
    return Response.json({ error: { code: "not_found" } }, { status: 404 });
  }
  return { hub, calls };
}

/** The host's credentials as triage-workflows wires them, plus the hub credential deploy binds to the hub actions. */
function actionCredentials(bindings: Bindings, host: Fetch, hub: (url: URL, init?: RequestInit) => Promise<Response>) {
  const consumers = ["take", "done", "deployReview", "forward", "stop"].map(actionConsumer);
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

/** Runs one mail's body; the mail agent's director runs its one tool, so the mail it would send is recorded and answered `mailed`. */
async function runMail(definition: WorkflowDefinition, mail: unknown, host: Fetch, hub: ReturnType<typeof fakeHub>["hub"], mailed: unknown[] = [], delivers = true) {
  const body = (definition.steps.events as OnTriggerPrimitive).body;
  if (!("inline" in body)) throw new Error("the body is not inline");
  const { terminalStatus, outputs } = await runLocal(body.inline, {
    authorize: allow,
    hasUpstreamSignalResolver: true,
    invokeStep: async function mailAgent({ agent, input }) {
      if (!agent.id.startsWith("triage-mail")) throw new Error(`no agent but the mail agent runs, not ${agent.id}`);
      mailed.push(input);
      return { output: JSON.stringify({ mailed: delivers }) };
    },
    actionResolver: (ref) => (actions as Record<string, ActionHandler>)[ref]!,
    actionCredentials: actionCredentials((definition.credentialBindings ?? []) as Bindings, host, hub),
    loopFns,
    triggerPayload: mail,
  }).complete;
  const passes = outputs["passes"] as { iterations: number; final: Record<string, unknown> } | undefined;
  const last = passes?.final ?? outputs;
  return { terminalStatus, passes: passes?.iterations, outputs: last, ran: Object.keys(last).filter((id) => !(last[id] as { skipped?: true } | undefined)?.skipped).toSorted() };
}

/** The mail that wakes the manager's run, as its listener or one of its reviews sends it. */
function wake(pull: { source: string; repo: string; number: number } = PULL) {
  return { headers: { from: "run_listener@triage.test", to: [`${RUN}@triage.test`] }, parts: [{ contentType: "text/plain", text: manageMail(TENANT, pull) }] };
}

/** The eval fixture's pull request at `head`, with the base and head repositories a comment's write compares. */
function githubHost(head = HEAD) {
  const writes: Write[] = [];
  const fixture = fixtureGithub(PR, {});
  async function read(url: URL): Promise<Response> {
    const response = await fixture(url);
    if (url.pathname !== `/repos/${PR.repo}/pulls/${PR.number}`) return response;
    const pull = await response.json();
    return Response.json({ ...pull, head: { ...pull.head, sha: head, repo: { id: 1 } }, base: { ...pull.base, repo: { id: 1 } } });
  }
  return { writes, host: recordingGithub(read, writes) };
}

const TAKE = { method: "POST", path: `${TENANT_PATH}/manager/take`, body: PULL };
const DONE = { method: "POST", path: `${TENANT_PATH}/manager/done`, body: { ...PULL, reviewers: [] } };
const STAGE_1 = ["approvals", "done", "evaluateRules", "executeRules", "facts", "held", "mirrorRules", "paused", "ran", "route", "rules", "take", "triaged", "unready", "waiting"];
const READY = { method: "POST", path: `/repos/${PR.repo}/issues/${PR.number}/labels`, body: { labels: ["Triage: Ready"] } };
const POSTED_REVIEW = expect.objectContaining({ method: "POST", path: `/repos/${PR.repo}/pulls/${PR.number}/reviews` });

describe("triage-manager", () => {
  test.each([["new", PASS], ["resumed", RESUMED]])("a %s pass runs stage 1 on the mail the hub recorded, and the run stops itself when done ends its claim", async (_name, pass) => {
    const { writes, host } = githubHost();
    const hub = fakeHub({ takes: [pass], dones: [ENDED] });
    expect(await runMail(github, wake(), host, hub.hub)).toMatchObject({ terminalStatus: "completed", passes: 1, ran: STAGE_1 });
    expect(writes).toContainEqual(READY);
    expect(hub.calls).toEqual([TAKE, DONE, END]);
  });

  test("with an event pending after done, the manager runs its next pass at once, and a refused newcomer is harmless", async () => {
    const { writes, host } = githubHost();
    const newcomer = fakeHub({ takes: [REFUSED] });
    expect(await runMail(github, wake(), host, newcomer.hub)).toMatchObject({ terminalStatus: "completed", passes: 1, ran: ["done", "paused", "ran", "take"] });
    expect(newcomer.calls).toEqual([TAKE, END]);
    expect(writes).toEqual([]);

    const live = fakeHub({ takes: [PASS, { ...PASS, pass: { ...PASS.pass, id: "pass_2" } }], dones: [MORE, ENDED] });
    expect(await runMail(github, wake(), host, live.hub)).toMatchObject({ terminalStatus: "completed", passes: 2 });
    expect(live.calls).toEqual([TAKE, DONE, TAKE, DONE, END]);
  });

  test("the verdict's automatic Dos run after its mirror, as pr-triage runs them", async () => {
    const { writes, host } = githubHost();
    const welcome: CheckPack = { ...RULES, actions: { ...RULES.actions, pass: [{ do: "comment", target: { body: "Welcome" } }] } };
    const hub = fakeHub({ takes: [{ ...PASS, request: hubRequest(welcome) }], dones: [ENDED] });
    expect((await runMail(github, wake(), host, hub.hub)).ran).toEqual(STAGE_1);
    const ready = writes.findIndex((write) => write.path.endsWith("/labels"));
    const welcomed = writes.findIndex((write) => JSON.stringify(write.body).includes("Welcome"));
    expect(welcomed).toBeGreaterThan(ready);
  });

  test("rules that need the judge post nothing yet", async () => {
    const { writes, host } = githubHost();
    const hub = fakeHub({ takes: [{ ...PASS, request: hubRequest(JUDGED) }], dones: [ENDED] });
    const { ran } = await runMail(github, wake(), host, hub.hub);
    expect(ran).toEqual(["approvals", "done", "facts", "held", "paused", "ran", "route", "rules", "take", "triaged", "unready", "waiting"]);
    expect(writes).toEqual([]);
  });

  test("a head the hub holds for CI gets the Waiting label and is not triaged", async () => {
    const { writes, host } = githubHost();
    const hub = fakeHub({ takes: [{ ...PASS, events: [mailEvent(HEAD, REQUEST), mailEvent(HEAD, { ...REQUEST, kind: WAITING_KIND }, "evt_2")] }], dones: [ENDED] });
    const { ran } = await runMail(github, wake(), host, hub.hub);
    expect(ran).toContain("markWaiting");
    expect(ran).not.toContain("facts");
    expect(writes).toContainEqual(expect.objectContaining({ method: "POST", path: `/repos/${PR.repo}/issues/${PR.number}/labels`, body: { labels: [WAITING_LABEL] } }));
  });

  test("an old review's reply finds nothing for its head and runs no stage 1", async () => {
    const { writes, host } = githubHost();
    const hub = fakeHub({ takes: [{ ...IDLE, request: { ...REQUEST, headSha: "newer" }, reviewers: [{ ...reviewer(), head: "older" }] }], dones: [ENDED] });
    expect((await runMail(github, wake(), host, hub.hub)).ran).toEqual(["done", "paused", "ran", "take"]);
    expect(writes).toEqual([]);
  });

  test.each([["after"], ["before"]])("an approval for an older head arriving %s a push runs as pr-triage runs a stale one, and triage runs on the push", async (order) => {
    const NEWER = "0e0e".repeat(10);
    const hi = [{ do: "comment" as const, target: { body: "hi" } }];
    const held: CheckPack = { ...RULES, actions: { ...RULES.actions, pass: hi } };
    const automatic = ACTION_KINDS.filter((kind) => kind !== "comment");
    const first = fakeHub({ takes: [{ ...PASS, events: [mailEvent(HEAD, hubRequest(held, {}, automatic))], request: hubRequest(held, {}, automatic) }], dones: [ENDED] });
    const verdict = (await runMail(github, wake(), githubHost().host, first.hub)).outputs["evaluateRules"] as { request: unknown; headSha: string; actions: { list: string; index: number; effectId: string; kind: string; target: unknown }[] };
    const [step] = verdict.actions;
    expect(step).toMatchObject({ kind: "comment" });
    const approval = { kind: APPROVE_DO_KIND, runId: "run_old", principalId: "prn_ann", list: step!.list, index: step!.index, request: verdict.request, step: { effectId: step!.effectId, headSha: verdict.headSha, kind: step!.kind, target: step!.target }, appLogin: REQUEST["appLogin"] };

    const { writes, host } = githubHost(NEWER);
    const pushed = { ...hubRequest(held, {}, automatic), headSha: NEWER };
    const push = mailEvent(NEWER, pushed, "evt_push");
    const approved = mailEvent(HEAD, approval, "evt_approval");
    const hub = fakeHub({ takes: [{ ...PASS, pass: { ...PASS.pass, head: NEWER }, events: order === "after" ? [push, approved] : [approved, push], request: pushed }], dones: [ENDED] });
    const { ran, outputs } = await runMail(github, wake(), host, hub.hub);
    expect(ran).toContain("facts");
    expect(outputs["approvals"]).toEqual({ results: [{ dos: [expect.objectContaining({ effectId: step!.effectId, status: "skipped", error: expect.stringContaining("new commits since this verdict") })] }] });
    expect(writes.filter((write) => JSON.stringify(write.body).includes("\"hi\""))).toEqual([]);
  });

  test("a pass that fails stops the run, so the claim's run is gone for the next manager's take", async () => {
    const { host } = githubHost();
    const hub = fakeHub({ takes: [{ error: "not json" }] });
    const { terminalStatus } = await runMail(github, wake(), host, hub.hub);
    expect(terminalStatus).toBe("failed");
    expect(hub.calls).toEqual([TAKE, END]);
  });

  test("on Bitbucket Data Center it reaches the host through that host's bindings only", async () => {
    expect(bitbucket.credentialBindings?.map(({ action, handle }) => `${action}:${handle}`)).toEqual(["facts:bitbucket-datacenter", "mirror:bitbucket-datacenter", "execute:bitbucket-datacenter", "executeApprovals:bitbucket-datacenter"]);
    const builds: unknown[] = [];
    const ref = { id: "refs/heads/fix", displayId: "fix", latestCommit: "abc", repository: { id: 1 } };
    const pull = { id: 8, version: 0, state: "OPEN", fromRef: ref, toRef: { ...ref, id: "refs/heads/main" }, links: { self: [{ href: "https://bitbucket.acme.test/pr/8" }] }, author: { user: { id: 2, slug: "octocat" } }, reviewers: [], participants: [] };
    async function host(url: URL, init?: RequestInit): Promise<Response> {
      if (url.pathname === BB_PULL) return Response.json(pull);
      if (url.pathname !== BB_BUILDS) return Response.json({ message: "Server Error" }, { status: 500 });
      if (init?.method === "POST") builds.push(JSON.parse(String(init.body)));
      return Response.json({ values: [], isLastPage: true });
    }
    const request = { kind: "pr", repo: BB_REPO, repoSource: "bitbucket-datacenter", prNumber: 8, headSha: "abc", policy: { enabled: true }, policyUnreadable: "The policy file has unknown checks: max-size.", automatic: ACTION_KINDS, tenantId: TENANT };
    const bbPull = { source: "bitbucket-datacenter", repo: BB_REPO, number: 8 };
    const hub = fakeHub({ takes: [{ ...PASS, pass: { ...PASS.pass, head: "abc" }, events: [mailEvent("abc", request)], request }], dones: [ENDED] });
    expect((await runMail(bitbucket, wake(bbPull), host, hub.hub)).terminalStatus).toBe("completed");
    expect(builds).toEqual([expect.objectContaining({ state: "FAILED" })]);
    expect(hub.calls.map(({ body }) => body)).toEqual([bbPull, { ...bbPull, reviewers: [] }, undefined]);
  });
});

describe("triage-manager with code review", () => {
  const reviewed = triageManager({ id: "triage-manager-github", sources: ["github"], review: RELEASE });
  const ON = hubRequest(RULES, { ...CODE_REVIEW, ...REVIEW_REQUEST });

  test("the first pass deploys the review and mails it, posting nothing; the pass that collects its report posts the verdict and the review together", async () => {
    const { writes, host } = githubHost();
    const mailed: unknown[] = [];
    const first = fakeHub({ takes: [{ ...PASS, request: ON }], dones: [ENDED] });
    expect((await runMail(reviewed, wake(), host, first.hub, mailed)).ran).toContain("doneReviewing");
    expect(writes).toEqual([]);
    expect(first.calls[1]).toMatchObject({ ...DEPLOY, body: { source: { kind: "asset", assetId: "ast_review", package: { format: "source", commitSha: "c0ffee", packageName: RELEASE.workflow.packageName } }, entry: RELEASE.workflow.entry, sourceOfferingIds: ["off_a"], defaultSourceOfferingId: "off_a" } });
    expect(first.calls[2]).toMatchObject({ ...DONE, body: { reviewers: [{ kind: "code-review", head: HEAD, runId: DEPLOYED }] } });
    const [mail] = mailed as [{ tenantId: string; to: string; content: string; readyBy: string }];
    expect(Date.parse(mail.readyBy)).toBeGreaterThan(Date.now());
    expect({ ...mail, content: JSON.parse(mail.content) }).toMatchObject({ tenantId: TENANT, to: DEPLOYED, content: { ...REVIEW_REQUEST.codeReviewRequest, tenantId: TENANT, reply: { to: RUN, content: manageMail(TENANT, PULL) } } });

    const second = fakeHub({ takes: [reported({ result: REVIEW }, ON)], dones: [ENDED] });
    const { ran } = await runMail(reviewed, wake(), host, second.hub, mailed);
    expect(ran).toContain("postReview");
    expect(ran).not.toContain("deployReview");
    expect(writes).toContainEqual(READY);
    expect(writes).toContainEqual(POSTED_REVIEW);
    expect(second.calls).toEqual([TAKE, DONE, END]);
    expect(mailed).toHaveLength(1);
  });

  test.each([
    ["the review reported a failure", reported({ failed: "the review did not finish" }, ON)],
    ["the review ran past its deadline", { ...IDLE, request: ON, reviewers: [reviewer("2000-01-01T00:00:00.000Z")] }],
    ["the hub read no review request", { ...PASS, request: hubRequest(RULES, CODE_REVIEW) }],
  ])("when %s, the verdict goes up without code review", async (_name, taken) => {
    const { writes, host } = githubHost();
    const hub = fakeHub({ takes: [taken], dones: [ENDED] });
    const { ran } = await runMail(reviewed, wake(), host, hub.hub);
    expect(ran).not.toContain("deployReview");
    expect(writes).toContainEqual(READY);
    expect(writes).not.toContainEqual(POSTED_REVIEW);
    expect(hub.calls).toEqual([TAKE, DONE, END]);
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

describe("triage-listener", () => {
  const listener = triageListener({ id: "triage-listener-github", manager: RELEASE });

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
