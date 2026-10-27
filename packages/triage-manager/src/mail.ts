// A run sends mail only through an agent step's transport. The mail agent's director makes no model call: it runs its
// one tool on the step's input and replies with the tool's result.
import { defineAgent, defineDirector, defineTool, type AgentDefinition, type BaseEnv, type ToolBundle } from "@intx/agent";
import { HUB_CREDENTIAL_HANDLE } from "@intx/types/credential-delivery";
import type { ReactorDirector } from "@intx/types/runtime";
import type { RuntimeCapabilities } from "@intx/types/runtime-capabilities";
import { type } from "arktype";
import { setTimeout as sleep } from "node:timers/promises";

const MAIL_TOOL = "mail";
const READY_POLL_MS = 2_000;

/**
 * A mail to the run `to` in this run's tenant. With `readyBy`, the run was just deployed and its public key may not be
 * published yet, so the mail waits until it is.
 */
export const MailInput = type({ tenantId: "string > 0", to: "string > 0", content: "string > 0", "readyBy?": "string.date.iso" });
export type MailInput = typeof MailInput.infer;

const Run = type({ "sidecarId?": "string | null", "publicKey?": "string | null" });

interface MailEnv extends BaseEnv {
  capabilities: RuntimeCapabilities;
  address: string;
  transport: {
    send: (message: { to: string; type: string; content: string }, signal: AbortSignal) => Promise<{ messageId: string; status: string }>;
  };
}

/** Waits until the hub shows the run published a non-empty public key, the deploy ack. Stock never writes sidecarId. */
async function untilReady(env: MailEnv, { tenantId, to }: MailInput, readyBy: string, signal: AbortSignal): Promise<void> {
  const hub = await env.capabilities.resolve("credentials").resolve(HUB_CREDENTIAL_HANDLE);
  if (hub.kind !== "http") throw new Error(`${HUB_CREDENTIAL_HANDLE} is ${hub.kind}, not http`);
  while (Date.now() < Date.parse(readyBy)) {
    const response = await hub.fetch(`/api/tenants/${encodeURIComponent(tenantId)}/workflows/runs/${encodeURIComponent(to)}`, { signal });
    if (!response.ok) throw new Error(`reading run ${to} answered ${response.status}: ${await response.text()}`);
    const run = Run(await response.json());
    if (run instanceof type.errors) throw new Error(`run ${to}: ${run.summary}`);
    if (run.publicKey) return;
    await sleep(READY_POLL_MS, undefined, { signal });
  }
  throw new Error(`run ${to}: public key was not published by ${readyBy}`);
}

function mailBundle(env: MailEnv): ToolBundle {
  return {
    definitions: [{
      name: MAIL_TOOL,
      description: "Mail a run in this tenant as this run.",
      inputSchema: { type: "object", properties: { tenantId: { type: "string" }, to: { type: "string" }, content: { type: "string" }, readyBy: { type: "string" } }, required: ["tenantId", "to", "content"] },
    }],
    async run(call, signal) {
      const input = MailInput(call.arguments);
      if (input instanceof type.errors) return { callId: call.id, content: `mail: ${input.summary}`, isError: true };
      try {
        if (input.readyBy) await untilReady(env, input, input.readyBy, signal);
        const domain = env.address.slice(env.address.indexOf("@") + 1);
        const sent = await env.transport.send({ to: `${input.to}@${domain}`, type: "conversation.message", content: input.content }, signal);
        return { callId: call.id, content: { to: input.to, mailed: true, ...sent } };
      } catch (err) {
        return { callId: call.id, content: err instanceof Error ? err.message : String(err), isError: true };
      }
    },
  };
}

const mailTool = defineTool<MailEnv>({
  id: "@corbits/triage-manager/mail",
  requires: ["capabilities", "transport", "address"],
  definitions: [{ name: MAIL_TOOL }],
  credentials: [{ handle: HUB_CREDENTIAL_HANDLE }],
  factory: mailBundle,
});

/** With `tolerate`, a mail that fails is replied as `{ mailed: false, error }` for a later step to act on; otherwise it fails the step. */
const MailDirectorConfig = type({ tolerate: "boolean" });

function mailDirector({ tolerate }: typeof MailDirectorConfig.infer): ReactorDirector {
  return {
    async decide(event, _state, caps) {
      switch (event.type) {
        case "message.received": {
          const { content } = event.message;
          if (content === undefined) throw new Error("mail: the message has no content");
          return caps.executeTools([{ id: MAIL_TOOL, name: MAIL_TOOL, arguments: JSON.parse(content) }], false, false);
        }
        case "tool.done":
          if (!event.result.isError) return caps.reply(JSON.stringify(event.result.content));
          if (tolerate) return caps.reply(JSON.stringify({ mailed: false, error: event.result.content }));
          throw new Error(`mail: ${JSON.stringify(event.result.content)}`);
        default:
          return [];
      }
    },
  };
}

/** The mail director under the package that publishes it, which lists it in its `interchange.directors` module. */
export function mailDirectorOf(packageName: string) {
  return defineDirector<typeof MailDirectorConfig.infer>({
    id: `${packageName}/mail`,
    configSchema: MailDirectorConfig,
    factory: mailDirector,
  });
}

/** The agent that sends one mail; `inference` is declared because every agent names one, and is never called. */
export function mailAgentOf(director: ReturnType<typeof mailDirectorOf>, inference: AgentDefinition["inference"], { tolerate }: { tolerate: boolean }) {
  return defineAgent({ id: tolerate ? "triage-mail-tolerant" : "triage-mail", systemPrompt: "Send the mail the input names.", tools: [mailTool], capabilities: [], inference, director: director.build({ tolerate }) });
}

/** A tolerant mail agent's reply: whether the mail went, and why when it did not. */
export const Mailed = type("string.json.parse").to(type({ mailed: "true" }).or({ mailed: "false", error: "unknown" }));
