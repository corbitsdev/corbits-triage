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

test("the mail director runs its one tool on the step's input without a model call, and replies with the tool's result", async () => {
  const director = mailDirector.factory({}, {} as never, { systemPrompt: "" } as never);
  const input = { tenantId: "tnt_acme", to: "run_manager", content: "{}", fresh: true };
  expect(await director.decide({ type: "message.received", message: { content: JSON.stringify(input) } } as never, STATE, caps)).toEqual({ type: "execute_tools", calls: [{ id: "mail", name: "mail", arguments: input }] });
  const done: ToolResult = { callId: "mail", content: { to: "run_manager", messageId: "m1", status: "sent" } };
  expect(await director.decide({ type: "tool.done", result: done }, STATE, caps)).toEqual({ type: "reply", content: JSON.stringify(done.content) });
  await expect(director.decide({ type: "tool.done", result: { ...done, isError: true } }, STATE, caps)).rejects.toThrow("mail:");
});

test("the mail tool waits for a just-deployed run to reach a sidecar, then mails it at this run's domain as this run", async () => {
  const polled: string[] = [];
  const sent: unknown[] = [];
  const answers = [{ sidecarId: null, publicKey: null }, { sidecarId: "sc_1", publicKey: "pk" }];
  const env = {
    address: "run_listener@acme.test",
    capabilities: { resolve: () => ({ resolve: async (handle: string) => ({ kind: "http", handle, fetch: async (path: string) => (polled.push(path), Response.json(answers.shift())) }) }) },
    transport: { send: async (message: unknown) => (sent.push(message), { messageId: "m1", status: "sent" }) },
  };
  const [factory] = mailAgentOf(mailDirector, { sources: [{ provider: "corbits-system-one", model: "decision" }] }).toolFactories;
  const tools = factory!(env as never);
  const call = { id: "mail", name: "mail", arguments: { tenantId: "tnt_acme", to: "run_manager", content: "{\"kind\":\"pr\"}", fresh: true } };
  expect(await tools.run(call, new AbortController().signal)).toEqual({ callId: "mail", content: { to: "run_manager", messageId: "m1", status: "sent" } });
  expect(polled).toEqual(["/api/tenants/tnt_acme/workflows/runs/run_manager", "/api/tenants/tnt_acme/workflows/runs/run_manager"]);
  expect(sent).toEqual([{ to: "run_manager@acme.test", type: "conversation.message", content: "{\"kind\":\"pr\"}" }]);
  expect(factory!.credentials).toEqual([{ handle: HUB_CREDENTIAL_HANDLE }]);
}, 10_000);
