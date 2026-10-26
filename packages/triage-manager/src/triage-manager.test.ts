import { describe, expect, test } from "bun:test";
import { actionConsumer } from "@intx/authz";
import { createActionCredentialsFactory, createCredentialProviderRegistry, createHttpCredentialProvider } from "@intx/harness";
import type { GrantRule } from "@intx/types/authz";
import { HUB_CREDENTIAL_HANDLE } from "@intx/types/credential-delivery";
import { runLocal, type ActionHandler, type OnTriggerPrimitive, type WorkflowAuthorizeFn, type WorkflowDefinition } from "@intx/workflow";
import { ACTION_KINDS, emptyPack, type CheckPack } from "@corbits/triage-contracts";
import type { Snapshot } from "@corbits/triage-workflows/evals/cases";
import { fixtureGithub, triggerMail } from "@corbits/triage-workflows/evals/serve";
import { delivered, grantsFor, type Bindings, type Fetch } from "@corbits/triage-workflows/local-credentials";
import { recordingGithub, type Write } from "@corbits/triage-workflows/run-local";
import * as actions from "./actions/index.js";
import { workflow as bitbucket } from "./triage-manager-bitbucket-datacenter.js";
import { workflow as github } from "./triage-manager-github.js";
import { triageListener } from "./triage-listener.js";
import { triageManager } from "./triage-manager.js";

const TENANT = "tnt_acme";
const RUN = "run_manager";
const HUB_ORIGIN = "https://hub.test";
const TENANT_PATH = `/api/tenants/${TENANT}`;
const END = { method: "DELETE", path: `${TENANT_PATH}/workflows/runs/${RUN}` };

const PR: Snapshot = {
  repo: "acme/widgets", number: 8, title: "Add the flag", body: "Adds the flag.", bodyHtml: "<p>Adds the flag.</p>", author: "octocat", commits: ["feat: add the flag"],
  files: [{ filename: "src/flag.ts", status: "added", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+export const flag = true;" }], docs: {},
};
const RULES: CheckPack = { ...emptyPack(PR.repo), checks: { "ci-green": { enabled: true } } };
const JUDGED: CheckPack = { ...emptyPack(PR.repo), checks: { focused: { enabled: true } } };
const BB_REPO = "ACME/widgets";
const BB_PULL = "/rest/api/1.0/projects/ACME/repos/widgets/pull-requests/8";
const BB_BUILDS = "/rest/build-status/1.0/commits/abc";

const PASS = { outcome: "pass", pass: { id: "pass_1", head: "e0a1", events: ["evt_1"], takenAt: "2026-10-25T00:00:00.000Z", takes: 1 }, events: [], resumed: false, reviewers: [] };
const RESUMED = { ...PASS, pass: { ...PASS.pass, takes: 2 }, resumed: true };
const IDLE = { outcome: "idle", reviewers: [] };
const RELEASE = { workflow: { assetId: "ast_review", commitSha: "c0ffee", packageName: "@corbits/pr-code-review-anthropic", entry: "./pr-code-review-reviewer-github.mjs" }, offerings: { ids: ["off_a"], defaultId: "off_a" } };
const REVIEW_RUN = "run_review";
/** The eval fixture's head, which a code review is posted on. */
const HEAD = "e0a1".repeat(10);
const DEPLOY = { method: "POST", path: `${TENANT_PATH}/workflows/deployments` };
const REFUSED = 409;

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
    if (method === DEPLOY.method && url.pathname === DEPLOY.path) return Response.json({ id: REVIEW_RUN }, { status: 201 });
    return Response.json({ error: { code: "not_found" } }, { status: 404 });
  }
  return { hub, calls };
}

/** The host's credentials as triage-workflows wires them, plus the hub credential deploy binds to take and done. */
function actionCredentials(bindings: Bindings, host: Fetch, hub: (url: URL, init?: RequestInit) => Promise<Response>) {
  const consumers = ["take", "done", "deployReview", "forward"].map(actionConsumer);
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

async function runMail(definition: WorkflowDefinition, mail: unknown, host: Fetch, hub: ReturnType<typeof fakeHub>["hub"], mailed: unknown[] = []) {
  const body = (definition.steps.events as OnTriggerPrimitive).body;
  if (!("inline" in body)) throw new Error("the manager body is not inline");
  const { terminalStatus, outputs } = await runLocal(body.inline, {
    authorize: allow,
    hasUpstreamSignalResolver: true,
    // The mail agent's director runs its one tool on its input; the mail it would send is recorded.
    invokeStep: async function mailAgent({ agent, input }) {
      if (agent.id !== "triage-mail") throw new Error(`stage 1 runs no agent, not ${agent.id}`);
      mailed.push(input);
      return { output: "{}" };
    },
    actionResolver: (ref) => (actions as Record<string, ActionHandler>)[ref]!,
    actionCredentials: actionCredentials((definition.credentialBindings ?? []) as Bindings, host, hub),
    triggerPayload: mail,
  }).complete;
  return { terminalStatus, ran: Object.keys(outputs).filter((id) => !(outputs[id] as { skipped?: true } | undefined)?.skipped) };
}

/** The hub's pull request mail, as its bridge builds it, as the listener hands it on to the manager's run. */
function hubMail(pack: CheckPack, extra: Record<string, unknown> = {}) {
  const mail = triggerMail(PR, pack, { tenantId: TENANT, ...extra }, [...ACTION_KINDS]);
  return { ...mail, headers: { from: `run_listener@triage.test`, to: [`${RUN}@triage.test`] } };
}

/** The eval fixture's pull request, with the base and head repositories a comment's write compares. */
function githubHost() {
  const writes: Write[] = [];
  const fixture = fixtureGithub(PR, {});
  async function read(url: URL): Promise<Response> {
    const response = await fixture(url);
    if (url.pathname !== `/repos/${PR.repo}/pulls/${PR.number}`) return response;
    const pull = await response.json();
    return Response.json({ ...pull, head: { ...pull.head, repo: { id: 1 } }, base: { ...pull.base, repo: { id: 1 } } });
  }
  return { writes, host: recordingGithub(read, writes) };
}

const TAKE = { method: "POST", path: `${TENANT_PATH}/manager/take`, body: { source: "github", repo: PR.repo, number: PR.number } };
const DONE = { method: "POST", path: `${TENANT_PATH}/manager/done`, body: { ...TAKE.body, reviewers: [] } };
const STAGE_1 = ["take", "taken", "facts", "rules", "route", "evaluateRules", "mirrorRules", "done"];
const REVIEWED = { codeReview: { on: true, for: ["everyone"], triage: ["pass", "fail", "unsure"], rules: "any" }, codeReviewRequest: { kind: "code-review", number: PR.number, title: PR.title, description: PR.body, diff: "diff --git a/src/flag.ts b/src/flag.ts", checkout: { source: "github", repo: PR.repo, sha: "e0a1".repeat(10) } } };
const REVIEW = { summary: "One bug.", comments: [{ path: "src/flag.ts", start: 1, end: 1, title: "Always true", body: "The flag can never be off." }], budgetExhausted: false };

describe("triage-manager", () => {
  test.each([["new", PASS], ["resumed", RESUMED]])("a %s pass runs stage 1, and the run stops itself when done ends its claim", async (_name, pass) => {
    const { writes, host } = githubHost();
    const hub = fakeHub({ takes: [pass], dones: [{ outcome: "ended" }] });
    const { terminalStatus, ran } = await runMail(github, hubMail(RULES), host, hub.hub);
    expect({ terminalStatus, ran: ran.toSorted() }).toEqual({ terminalStatus: "completed", ran: STAGE_1.toSorted() });
    expect(writes).toContainEqual({ method: "POST", path: `/repos/${PR.repo}/issues/${PR.number}/labels`, body: { labels: ["Triage: Ready"] } });
    expect(hub.calls).toEqual([TAKE, DONE, END]);
  });

  test("with more to do the run waits for its next mail, and stops when that one finds nothing pending", async () => {
    const { writes, host } = githubHost();
    const hub = fakeHub({ takes: [PASS, IDLE], dones: [{ outcome: "more" }, { outcome: "ended" }] });
    await runMail(github, hubMail(RULES), host, hub.hub);
    expect(hub.calls).toEqual([TAKE, DONE]);
    const written = writes.length;
    const { terminalStatus, ran } = await runMail(github, hubMail(RULES), host, hub.hub);
    expect({ terminalStatus, ran: ran.toSorted() }).toEqual({ terminalStatus: "completed", ran: ["done", "take", "taken"] });
    expect(writes).toHaveLength(written);
    expect(hub.calls).toEqual([TAKE, DONE, TAKE, DONE, END]);
  });

  test("rules that need the judge post nothing yet", async () => {
    const { writes, host } = githubHost();
    const hub = fakeHub({ takes: [PASS], dones: [{ outcome: "ended" }] });
    const { ran } = await runMail(github, hubMail(JUDGED), host, hub.hub);
    expect(ran.toSorted()).toEqual(["done", "facts", "route", "rules", "take", "taken"]);
    expect(writes).toEqual([]);
    expect(hub.calls).toEqual([TAKE, DONE, END]);
  });

  test("a run the claim does not name stops itself without reading the pull request", async () => {
    const { writes, host } = githubHost();
    const hub = fakeHub({ takes: [REFUSED] });
    const { terminalStatus, ran } = await runMail(github, hubMail(RULES), host, hub.hub);
    expect({ terminalStatus, ran: ran.toSorted() }).toEqual({ terminalStatus: "completed", ran: ["done", "take", "taken"] });
    expect(writes).toEqual([]);
    expect(hub.calls).toEqual([TAKE, END]);
  });

  test("on Bitbucket Data Center it reaches the host through that host's binding only", async () => {
    expect(bitbucket.credentialBindings?.map(({ action, handle }) => `${action}:${handle}`)).toEqual(["facts:bitbucket-datacenter", "mirror:bitbucket-datacenter"]);
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
    const mail = { headers: { from: "github@triage.test", to: [`${RUN}@triage.test`] }, parts: [{ contentType: "text/plain", text: JSON.stringify(request) }] };
    const hub = fakeHub({ takes: [PASS], dones: [{ outcome: "ended" }] });
    const { terminalStatus } = await runMail(bitbucket, mail, host, hub.hub);
    expect(terminalStatus).toBe("completed");
    expect(builds).toEqual([expect.objectContaining({ state: "FAILED" })]);
    expect(hub.calls.map(({ body }) => body)).toEqual([{ ...TAKE.body, source: "bitbucket-datacenter", repo: BB_REPO }, { ...DONE.body, source: "bitbucket-datacenter", repo: BB_REPO }, undefined]);
  });

  test("with code review on, the first pass deploys the review and mails it, posting nothing; the pass that collects its review posts the verdict and the review together", async () => {
    const reviewed = triageManager({ sources: ["github"], review: RELEASE });
    const { writes, host } = githubHost();
    const reviewer = { kind: "code-review", head: HEAD, runId: REVIEW_RUN, deadline: "2999-01-01T00:00:00.000Z" };
    const pass = { ...PASS, pass: { ...PASS.pass, head: HEAD } };
    const collected = { ...pass, events: [{ key: `evt:github:${PR.repo}#8:${REVIEW_RUN}`, event: { type: "reviewer-result", head: HEAD, payload: { kind: "code-review", result: REVIEW } } }], reviewers: [reviewer] };
    const hub = fakeHub({ takes: [pass, collected], dones: [{ outcome: "more" }, { outcome: "ended" }] });
    const mailed: unknown[] = [];

    const first = await runMail(reviewed, hubMail(RULES, REVIEWED), host, hub.hub, mailed);
    expect(first.ran.toSorted()).toEqual(["deployReview", "doneReviewing", "evaluateRules", "facts", "mailReview", "reviewScope", "reviewing", "route", "rules", "take", "taken"]);
    expect(writes).toEqual([]);
    expect(hub.calls[1]).toMatchObject({ ...DEPLOY, body: { source: { kind: "asset", assetId: "ast_review", package: { format: "source", commitSha: "c0ffee", packageName: RELEASE.workflow.packageName } }, entry: RELEASE.workflow.entry, sourceOfferingIds: ["off_a"], defaultSourceOfferingId: "off_a" } });
    expect(hub.calls[2]).toMatchObject({ ...DONE, body: { reviewers: [{ kind: "code-review", head: HEAD, runId: REVIEW_RUN }] } });
    const [mail] = mailed as [{ tenantId: string; to: string; content: string; fresh: boolean }];
    expect({ ...mail, content: JSON.parse(mail.content) }).toMatchObject({ tenantId: TENANT, to: REVIEW_RUN, fresh: true, content: { ...REVIEWED.codeReviewRequest, tenantId: TENANT, reply: { to: RUN } } });

    const second = await runMail(reviewed, hubMail(RULES, REVIEWED), host, hub.hub, mailed);
    expect(second.ran).toContain("postReview");
    expect(second.ran).not.toContain("deployReview");
    expect(writes).toContainEqual({ method: "POST", path: `/repos/${PR.repo}/issues/${PR.number}/labels`, body: { labels: ["Triage: Ready"] } });
    expect(writes).toContainEqual(expect.objectContaining({ method: "POST", path: `/repos/${PR.repo}/pulls/${PR.number}/reviews`, body: expect.objectContaining({ commit_id: HEAD, event: "COMMENT" }) }));
    expect(hub.calls.slice(3)).toEqual([TAKE, { ...DONE, body: { ...DONE.body, reviewers: [] } }, END]);
    expect(mailed).toHaveLength(1);
  });

  test("the listener deploys a manager from its release and hands it the hub's mail; it moves only on the hub's mail", async () => {
    const listener = triageListener({ id: "triage-listener-github", manager: RELEASE });
    const hub = fakeHub({ takes: [] });
    const mailed: unknown[] = [];
    const mail = triggerMail(PR, RULES, { tenantId: TENANT }, [...ACTION_KINDS]);
    const { terminalStatus, ran } = await runMail(listener, mail, githubHost().host, hub.hub, mailed);
    expect({ terminalStatus, ran: ran.toSorted() }).toEqual({ terminalStatus: "completed", ran: ["forward", "mail"] });
    expect(hub.calls).toEqual([expect.objectContaining(DEPLOY)]);
    const [sent] = mailed as [{ to: string; content: string; fresh: boolean }];
    expect({ to: sent.to, fresh: sent.fresh, request: JSON.parse(sent.content) }).toMatchObject({ to: REVIEW_RUN, fresh: true, request: { kind: "pr", repo: PR.repo, prNumber: PR.number, tenantId: TENANT } });

    const forged = await runMail(listener, { ...mail, headers: { from: "someone@triage.test", to: mail.headers.to } }, githubHost().host, hub.hub, mailed);
    expect(forged.terminalStatus).toBe("failed");
    expect(hub.calls).toHaveLength(1);
  });
});
