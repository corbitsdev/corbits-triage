import { expect, test } from "bun:test";
import { actionConsumer } from "@intx/authz";
import { createActionCredentialsFactory, createCredentialProviderRegistry, createHttpCredentialProvider } from "@intx/harness";
import type { GrantRule } from "@intx/types/authz";
import { HUB_CREDENTIAL_HANDLE } from "@intx/types/credential-delivery";
import type { MessageAttachment, ToolCall, ToolResult } from "@intx/types/runtime";
import { runLocal, type ActionHandler, type WorkflowAuthorizeFn } from "@intx/workflow";
import { emptyPack, JUDGE_RULES_ATTACHMENT } from "@corbits/triage-contracts";
import { readFacts } from "@corbits/triage-workflows/actions/facts";
import { rules } from "@corbits/triage-workflows/actions/rules";
import type { HostCall } from "@corbits/triage-workflows/logic/host";
import { delivered, type Bindings } from "@corbits/triage-workflows/local-credentials";
import * as actions from "./actions/index.js";
import { rulesMailDirector } from "./rules-mail.js";
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

/** The trigger a manager's judge mail becomes once stock stored it: the rules attachment is over 1 MiB, so its part carries only a ref. */
const MAIL = {
  headers: { from: "run_manager@triage.test", to: [`${RUN}@triage.test`] },
  parts: [
    { contentType: "text/plain", ref: "mail-part:///run_judge/m1/0-part.plain", text: JSON.stringify({ kind: "judge", tenantId: TENANT, number: 8, checkout: { source: "github", repo: "acme/widgets", sha: SHA } }) },
    { contentType: "application/json", filename: JUDGE_RULES_ATTACHMENT, disposition: "attachment", ref: `mail-part:///run_judge/m1/1-${JUDGE_RULES_ATTACHMENT}` },
  ],
};

/** The rules step as stock runs it: the attachment's bytes, read through the ref, reach the rules director. */
async function readRules(attachments: MessageAttachment[]): Promise<unknown> {
  const director = rulesMailDirector.factory({}, {} as never, {} as never);
  const caps = { reply: (content: string) => ({ type: "reply", content }) };
  const decided = await director.decide({ type: "message.received", message: { attachments } } as never, {} as never, caps as never) as { content: string };
  return { reply: decided.content };
}

/** Runs the judge over its trigger mail, `attachments` standing for the parts stock resolves. */
async function runJudge(attachments: MessageAttachment[]) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  async function hub(url: URL, init?: RequestInit): Promise<Response> {
    calls.push({ method: init?.method ?? "GET", path: url.pathname, ...(init?.body !== undefined && { body: JSON.parse(String(init.body)) }) });
    return init?.method === "DELETE" ? new Response(null, { status: 202 }) : Response.json({ recorded: true }, { status: 201 });
  }
  const { terminalStatus } = await runLocal(workflow, {
    authorize: allow,
    invokeStep: async function invoke({ agent, input }) {
      if (agent.id === "triage-judge-rules") return { output: await readRules(attachments) };
      if (agent.id !== "triage-judge") throw new Error(`no agent but the rules reader and the judge runs, not ${agent.id}`);
      if (!input || typeof input !== "object" || !("questions" in input) || !Array.isArray(input.questions)) throw new Error("the judge step was not given a chunk");
      const text = input.questions.filter(isQuestion).map((question) => answerText(question.id)).join("");
      return { output: { reply: JSON.stringify({ judge: text }) } };
    },
    actionResolver: (ref) => (actions as Record<string, ActionHandler>)[ref]!,
    actionCredentials: actionCredentials(hub),
    triggerPayload: MAIL,
  }).complete;
  return { terminalStatus, calls };
}

function attached(rulesOutput: unknown): MessageAttachment[] {
  return [{ name: JUDGE_RULES_ATTACHMENT, contentType: "application/json", data: new TextEncoder().encode(JSON.stringify(rulesOutput)) }];
}

test("the judge runs the chunks the manager attached, reports the whole verdict and stops, posting nothing", async () => {
  const rulesOutput = await ruled();
  expect(rulesOutput.chunks.length).toBeGreaterThan(0);
  const { terminalStatus, calls } = await runJudge(attached(rulesOutput));
  expect(terminalStatus).toBe("completed");
  const posted = calls.find((call) => call.method === "POST");
  expect(posted).toMatchObject({ path: `/api/tenants/${TENANT}/manager/reviewer-result`, body: { kind: "judge", head: SHA, source: "github", repo: "acme/widgets", number: 8 } });
  if (posted === undefined) throw new Error("the judge posted nothing");
  expect((posted.body as { result?: unknown }).result).toMatchObject({ headSha: SHA, verdict: "pass", request: { header: { head: SHA, verdict: "pass" } }, automatic: [], actions: [] });
  expect(calls.some((call) => call.path.includes("github.com"))).toBe(false);
  expect(calls.at(-1)).toEqual({ method: "DELETE", path: `/api/tenants/${TENANT}/workflows/runs/${RUN}` });
});


test("a judge whose mail carries no rules reports that it did not finish and stops", async () => {
  const { calls } = await runJudge([]);
  expect(calls).toEqual([
    { method: "POST", path: `/api/tenants/${TENANT}/manager/reviewer-result`, body: { source: "github", repo: "acme/widgets", number: 8, kind: "judge", head: SHA, failed: "the judge did not finish" } },
    { method: "DELETE", path: `/api/tenants/${TENANT}/workflows/runs/${RUN}` },
  ]);
});
