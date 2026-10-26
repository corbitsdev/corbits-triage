import { expect, test } from "bun:test";
import { actionConsumer } from "@intx/authz";
import { createActionCredentialsFactory, createCredentialProviderRegistry, createHttpCredentialProvider } from "@intx/harness";
import type { GrantRule } from "@intx/types/authz";
import { HUB_CREDENTIAL_HANDLE } from "@intx/types/credential-delivery";
import type { ToolCall, ToolResult } from "@intx/types/runtime";
import { runLocal, type ActionHandler, type OnTriggerPrimitive, type WorkflowAuthorizeFn } from "@intx/workflow";
import { emptyPack } from "@corbits/triage-contracts";
import { readFacts } from "@corbits/triage-workflows/actions/facts";
import { rules } from "@corbits/triage-workflows/actions/rules";
import type { HostCall } from "@corbits/triage-workflows/logic/host";
import { delivered, type Bindings } from "@corbits/triage-workflows/local-credentials";
import * as actions from "./actions/index.js";
import { workflow } from "./triage-judge-github.js";

const TENANT = "tnt_acme";
const RUN = "run_judge";
const HUB_ORIGIN = "https://hub.test";
const SHA = "abc0000000000000000000000000000000000000";

const allow: WorkflowAuthorizeFn = async function allow() {
  return { effect: "allow", matchingGrants: [], resolvedBy: null };
};

function answering(results: Record<string, unknown>): HostCall {
  return async function host(asked: ToolCall): Promise<ToolResult> {
    return { callId: asked.id, content: results[asked.id] } as ToolResult;
  };
}

function isQuestion(value: unknown): value is { id: string } {
  return !!value && typeof value === "object" && "id" in value && typeof value.id === "string";
}

function answerText(id: string): string {
  if (id === "verdict") return JSON.stringify({ id, type: "choice", choice: "pass", probabilities: { pass: 0.9, fail: 0.05, cant_tell: 0.05 }, confidence: 0.9 });
  if (id === "focused") return JSON.stringify({ id, type: "choice", choice: "one_thing", probabilities: { one_thing: 0.9, more_than_one_thing: 0.05, cant_tell: 0.05 }, confidence: 0.9 });
  if (id.startsWith("focused-slice-")) return JSON.stringify({ id, type: "choice", choice: "serves_purpose", probabilities: { serves_purpose: 0.9, separate_change: 0.05, cant_tell: 0.05 }, confidence: 0.9 });
  if (id === "instructed") return JSON.stringify({ id, type: "noul", noul: 0.1 });
  return JSON.stringify({ id, type: "noul", noul: 0.9 });
}

/** The rules output a manager mails, for one open pull request whose policy asks focused. */
async function ruled() {
  const pack = { ...emptyPack("acme/widgets"), checks: { focused: { enabled: true } } };
  const request = { kind: "pr", repo: "acme/widgets", prNumber: 8, policy: { enabled: true }, checkPack: pack };
  const read = await readFacts(request, () => answering({
    github_list_open_prs: { prs: [{ number: 8, title: "Add the flag" }] },
    "docs:0": { docs: [], rules: [], ref: "tree" },
    "pr:8": { title: "Add the flag", author: "octocat", sha: SHA, state: "open", draft: false, mergeable: true, requestedReviewers: 0 },
    "reviews:8": { reviews: [] },
    "commits:8": { commits: [] },
    "files:8:0": { files: [{ path: "src/flag.ts", status: "added", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+export const flag = true;" }] },
    "stack:8": { includes: [] },
    "comments:8": { comments: [] },
    "checks:8": { checks: [{ name: "ci", status: "completed", conclusion: "success" }] },
  }));
  return rules(read, {} as never, new AbortController().signal);
}

function actionCredentials(hub: (url: URL, init?: RequestInit) => Promise<Response>) {
  const consumers = ["report", "stop"].map(actionConsumer);
  const cell = delivered([] as Bindings, [{ credentialId: "hub", providerKey: "http", origin: HUB_ORIGIN, secret: "run-token" }]);
  cell.current = { ...cell.current, bindings: consumers.map((consumer) => ({ handle: HUB_CREDENTIAL_HANDLE, credentialId: "hub", consumer })) };
  const grants: GrantRule[] = consumers.map((tool, index) => ({ id: `hub-${index}`, resource: "credential:hub", action: "use", effect: "allow", origin: "system", conditions: { tool }, expiresAt: null, roleId: null, principalId: null }));
  const providers = createCredentialProviderRegistry([createHttpCredentialProvider({ fetch: (input, init) => hub(new URL(input instanceof Request ? input.url : input), init) })]);
  return createActionCredentialsFactory({ materialCell: cell, resolveStepGrants: () => grants, providers });
}

/** Runs the judge's body over the rules a manager would mail it. */
async function runJudge(rulesOutput: { chunks: unknown[] }) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const mailed: unknown[] = [];
  async function hub(url: URL, init?: RequestInit): Promise<Response> {
    calls.push({ method: init?.method ?? "GET", path: url.pathname, ...(init?.body !== undefined && { body: JSON.parse(String(init.body)) }) });
    return init?.method === "DELETE" ? new Response(null, { status: 202 }) : Response.json({ recorded: true }, { status: 201 });
  }
  const body = (workflow.steps.events as OnTriggerPrimitive).body;
  if (!("inline" in body)) throw new Error("the body is not inline");
  const mail = {
    headers: { from: "run_manager@triage.test", to: [`${RUN}@triage.test`] },
    parts: [{ contentType: "text/plain", text: JSON.stringify({
      kind: "judge", tenantId: TENANT, number: 8, checkout: { source: "github", repo: "acme/widgets", sha: SHA }, rules: rulesOutput,
      reply: { to: "run_manager", content: JSON.stringify({ kind: "manage", tenantId: TENANT, repo: "acme/widgets", repoSource: "github", prNumber: 8 }) },
    }) }],
  };
  const { terminalStatus } = await runLocal(body.inline, {
    authorize: allow,
    invokeStep: async function invoke({ agent, input }) {
      if (agent.id.startsWith("triage-mail")) {
        mailed.push(input);
        return { output: JSON.stringify({ mailed: true }) };
      }
      if (agent.id !== "triage-judge") throw new Error(`no agent but the judge runs, not ${agent.id}`);
      if (!input || typeof input !== "object" || !("questions" in input) || !Array.isArray(input.questions)) throw new Error("the judge step was not given a chunk");
      const text = input.questions.filter(isQuestion).map((question) => answerText(question.id)).join("");
      return { output: { reply: JSON.stringify({ judge: text }) } };
    },
    actionResolver: (ref) => (actions as Record<string, ActionHandler>)[ref]!,
    actionCredentials: actionCredentials(hub),
    triggerPayload: mail,
  }).complete;
  return { terminalStatus, calls, mailed };
}

test("the judge runs the chunks the manager mailed, reports the verdict and stops, posting nothing", async () => {
  const rulesOutput = await ruled();
  expect(rulesOutput.chunks.length).toBeGreaterThan(0);
  const { terminalStatus, calls, mailed } = await runJudge(rulesOutput);
  expect(terminalStatus).toBe("completed");
  const posted = calls.find((call) => call.method === "POST");
  expect(posted).toMatchObject({ path: `/api/tenants/${TENANT}/manager/reviewer-result`, body: { kind: "judge", head: SHA, source: "github", repo: "acme/widgets", number: 8 } });
  if (posted === undefined) throw new Error("the judge posted nothing");
  const result = (posted.body as { result?: { verdict?: string; judged?: Record<string, string> } }).result;
  expect(result?.verdict).toBe("pass");
  expect(Object.keys(result?.judged ?? {}).length).toBeGreaterThan(0);
  expect(calls.some((call) => call.path.includes("github.com"))).toBe(false);
  expect(mailed).toHaveLength(1);
  expect(calls.at(-1)).toEqual({ method: "DELETE", path: `/api/tenants/${TENANT}/workflows/runs/${RUN}` });
});

