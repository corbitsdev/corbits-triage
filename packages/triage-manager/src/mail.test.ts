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
const REFUSED: ToolResult = { callId: "mail", content: "run run_review did not reach a sidecar", isError: true };

test("the mail director runs its one tool on the step's input without a model call and replies with its result; a failed mail fails the step unless it tolerates it", async () => {
  const strict = mailDirector.factory({ tolerate: false }, {} as never, { systemPrompt: "" } as never);
  const input = { tenantId: "tnt_acme", to: "run_manager", content: "{}" };
  expect(await strict.decide({ type: "message.received", message: { content: JSON.stringify(input) } } as never, STATE, caps)).toEqual({ type: "execute_tools", calls: [{ id: "mail", name: "mail", arguments: input }] });
  expect(await strict.decide({ type: "tool.done", result: SENT }, STATE, caps)).toEqual({ type: "reply", content: JSON.stringify(SENT.content) });
  await expect(strict.decide({ type: "tool.done", result: REFUSED }, STATE, caps)).rejects.toThrow("mail:");
  const tolerant = mailDirector.factory({ tolerate: true }, {} as never, { systemPrompt: "" } as never);
  expect(await tolerant.decide({ type: "tool.done", result: REFUSED }, STATE, caps)).toEqual({ type: "reply", content: JSON.stringify({ mailed: false, error: REFUSED.content }) });
});

test("the mail tool waits for a just-deployed run to reach a sidecar until its deadline, then mails it at this run's domain as this run", async () => {
  const polled: string[] = [];
  const sent: unknown[] = [];
  const answers = [{ sidecarId: null, publicKey: null }, { sidecarId: "sc_1", publicKey: "pk" }];
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
  const tools = factory!(env as never);
  const readyBy = new Date(Date.now() + 60_000).toISOString();
  const call = { id: "mail", name: "mail", arguments: { tenantId: "tnt_acme", to: "run_manager", content: "{\"kind\":\"manage\"}", readyBy } };
  expect(await tools.run(call, new AbortController().signal)).toEqual({ callId: "mail", content: { to: "run_manager", mailed: true, messageId: "m1", status: "sent" } });
  expect(polled).toEqual(["/api/tenants/tnt_acme/workflows/runs/run_manager", "/api/tenants/tnt_acme/workflows/runs/run_manager"]);
  expect(sent).toEqual([{ to: "run_manager@acme.test", type: "conversation.message", content: "{\"kind\":\"manage\"}" }]);
  expect(factory!.credentials).toEqual([{ handle: HUB_CREDENTIAL_HANDLE }]);

  const late = { ...call, arguments: { ...call.arguments, readyBy: new Date(Date.now() - 1).toISOString() } };
  expect(await tools.run(late, new AbortController().signal)).toMatchObject({ isError: true, content: expect.stringContaining("did not reach a sidecar") });
}, 10_000);
