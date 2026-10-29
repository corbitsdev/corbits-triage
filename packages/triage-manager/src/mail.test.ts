import { expect, test } from "bun:test";
import type { ReactorCapabilities, ReactorState, ToolResult } from "@intx/types/runtime";
import { HUB_CREDENTIAL_HANDLE } from "@intx/types/credential-delivery";
import { mailDirector } from "./directors.js";
import { mailAgentOf } from "./mail.js";

const caps = {
  executeTools: (calls: unknown) => ({ type: "execute_tools", calls }),
  reply: (content: string) => ({ type: "reply", content }),
} as unknown as ReactorCapabilities;
const STATE = {} as ReactorState;
const SENT: ToolResult = { callId: "mail", content: { to: "run_manager", mailed: true, messageId: "m1", status: "sent" } };
const REFUSED: ToolResult = { callId: "mail", content: "run run_review: public key was not published", isError: true };

/** The mail tool over a hub that answers each read of the mailed run with the next of `answers`, recording what it reads and sends. */
function mailTool(answers: Record<string, unknown>[]) {
  const polled: string[] = [];
  const sent: unknown[] = [];
  async function fetch(path: string): Promise<Response> {
    polled.push(path);
    return Response.json(answers.shift());
  }
  async function send(message: unknown) {
    sent.push(message);
    return { messageId: "m1", status: "sent" };
  }
  const env = { address: "run_listener@acme.test", capabilities: { resolve: () => ({ resolve: async () => ({ kind: "http", fetch }) }) }, transport: { send } };
  const [factory] = mailAgentOf(mailDirector, { sources: [{ provider: "corbits-system-one", model: "decision" }] }, { tolerate: false }).toolFactories;
  return { polled, sent, factory: factory!, tools: factory!(env as never) };
}

/** A mail to a just-deployed run, which waits up to a minute for its public key. */
function readyCall() {
  const readyBy = new Date(Date.now() + 60_000).toISOString();
  return { id: "mail", name: "mail", arguments: { tenantId: "tnt_acme", to: "run_manager", content: "{\"kind\":\"manage\"}", readyBy } };
}

test("the mail director runs its one tool on the step's input without a model call and replies with its result; a failed mail fails the step unless it tolerates it", async () => {
  const strict = mailDirector.factory({ tolerate: false }, {} as never, { systemPrompt: "" } as never);
  const input = { tenantId: "tnt_acme", to: "run_manager", content: "{}" };
  expect(await strict.decide({ type: "message.received", message: { content: JSON.stringify(input) } } as never, STATE, caps)).toEqual({ type: "execute_tools", calls: [{ id: "mail", name: "mail", arguments: input }] });
  await expect(strict.decide({ type: "message.received", message: {} } as never, STATE, caps)).rejects.toThrow("mail: the message has no content");
  expect(await strict.decide({ type: "tool.done", result: SENT }, STATE, caps)).toEqual({ type: "reply", content: JSON.stringify(SENT.content) });
  await expect(strict.decide({ type: "tool.done", result: REFUSED }, STATE, caps)).rejects.toThrow("mail:");
  const tolerant = mailDirector.factory({ tolerate: true }, {} as never, { systemPrompt: "" } as never);
  expect(await tolerant.decide({ type: "tool.done", result: REFUSED }, STATE, caps)).toEqual({ type: "reply", content: JSON.stringify({ mailed: false, error: REFUSED.content }) });
});

test("the mail tool waits until a just-deployed run publishes its public key, then mails it at this run's domain as this run", async () => {
  const { polled, sent, tools, factory } = mailTool([
    { status: "deployed", sidecarId: null, publicKey: null },
    { status: "deployed", sidecarId: "sc_1", publicKey: null },
    { status: "running", sidecarId: "sc_1", publicKey: "" },
    { status: "running", sidecarId: null, publicKey: "pk" },
  ]);
  const call = readyCall();
  expect(await tools.run(call, new AbortController().signal)).toEqual({ callId: "mail", content: { to: "run_manager", mailed: true, messageId: "m1", status: "sent" } });
  expect(polled).toEqual([
    "/api/tenants/tnt_acme/workflows/runs/run_manager",
    "/api/tenants/tnt_acme/workflows/runs/run_manager",
    "/api/tenants/tnt_acme/workflows/runs/run_manager",
    "/api/tenants/tnt_acme/workflows/runs/run_manager",
  ]);
  expect(sent).toEqual([{ to: "run_manager@acme.test", type: "conversation.message", content: "{\"kind\":\"manage\"}" }]);
  expect(factory.credentials).toEqual([{ handle: HUB_CREDENTIAL_HANDLE }]);

  const late = { ...call, arguments: { ...call.arguments, readyBy: new Date(Date.now() - 1).toISOString() } };
  expect(await tools.run(late, new AbortController().signal)).toMatchObject({ isError: true, content: expect.stringContaining("public key was not published") });
}, 20_000);

test("a cancelled step stops the mail tool's wait for a public key at once, and mails nothing", async () => {
  const { sent, tools } = mailTool([{ status: "deployed", publicKey: null }, { status: "deployed", publicKey: null }]);
  const step = new AbortController();
  const result = tools.run(readyCall(), step.signal);
  step.abort();
  expect(await result).toMatchObject({ isError: true, content: expect.stringContaining("aborted") });
  expect(sent).toEqual([]);
}, 1_000);

test("the mail tool stops waiting as soon as the hub shows the run ended, even with its public key published, and mails nothing", async () => {
  const { polled, sent, tools } = mailTool([{ status: "deployed", publicKey: null }, { status: "error", publicKey: "pk" }]);
  expect(await tools.run(readyCall(), new AbortController().signal)).toMatchObject({ isError: true, content: "run run_manager ended (error) before it was mailed" });
  expect(polled).toHaveLength(2);
  expect(sent).toEqual([]);
}, 10_000);
