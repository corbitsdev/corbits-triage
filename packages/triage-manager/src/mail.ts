// A run sends mail only through an agent step's transport. The mail agent's director makes no model call: it runs its
// one tool on the step's input and replies with the tool's result.
import { defineAgent, defineDirector, defineTool, type AgentDefinition, type BaseEnv, type ToolBundle } from "@intx/agent";
import { HUB_CREDENTIAL_HANDLE } from "@intx/types/credential-delivery";
import type { ReactorDirector } from "@intx/types/runtime";
import type { RuntimeCapabilities } from "@intx/types/runtime-capabilities";
import { type } from "arktype";

const MAIL_TOOL = "mail";
const READY_POLLS = 60;
const READY_POLL_MS = 2_000;

/** A mail to the run `to` in this run's tenant; `fresh` when that run was just deployed and may not hold a sidecar yet. */
export const MailInput = type({ tenantId: "string > 0", to: "string > 0", content: "string > 0", fresh: "boolean" });
export type MailInput = typeof MailInput.infer;

const Run = type({ "sidecarId?": "string | null", "publicKey?": "string | null" });

interface MailEnv extends BaseEnv {
  capabilities: RuntimeCapabilities;
  address: string;
  transport: {
    send: (message: { to: string; type: string; content: string }, signal: AbortSignal) => Promise<{ messageId: string; status: string }>;
  };
}

/** Waits until the hub shows the run on a sidecar that can take its mail. */
async function untilReady(env: MailEnv, { tenantId, to }: MailInput): Promise<void> {
  const hub = await env.capabilities.resolve("credentials").resolve(HUB_CREDENTIAL_HANDLE);
  if (hub.kind !== "http") throw new Error(`${HUB_CREDENTIAL_HANDLE} is ${hub.kind}, not http`);
  for (let poll = 0; poll < READY_POLLS; poll++) {
    const response = await hub.fetch(`/api/tenants/${encodeURIComponent(tenantId)}/workflows/runs/${encodeURIComponent(to)}`);
    if (!response.ok) throw new Error(`reading run ${to} answered ${response.status}: ${await response.text()}`);
    const run = Run(await response.json());
    if (run instanceof type.errors) throw new Error(`run ${to}: ${run.summary}`);
    if (run.sidecarId && run.publicKey) return;
    await new Promise(function wait(resolve) {
      setTimeout(resolve, READY_POLL_MS);
    });
  }
  throw new Error(`run ${to} did not reach a sidecar`);
}

function mailBundle(env: MailEnv): ToolBundle {
  return {
    definitions: [{
      name: MAIL_TOOL,
      description: "Mail a run in this tenant as this run.",
      inputSchema: { type: "object", properties: { tenantId: { type: "string" }, to: { type: "string" }, content: { type: "string" }, fresh: { type: "boolean" } }, required: ["tenantId", "to", "content", "fresh"] },
    }],
    async run(call, signal) {
      const input = MailInput(call.arguments);
      if (input instanceof type.errors) return { callId: call.id, content: `mail: ${input.summary}`, isError: true };
      try {
        if (input.fresh) await untilReady(env, input);
        const domain = env.address.slice(env.address.indexOf("@") + 1);
        const sent = await env.transport.send({ to: `${input.to}@${domain}`, type: "conversation.message", content: input.content }, signal);
        return { callId: call.id, content: { to: input.to, ...sent } };
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

function mailDirector(): ReactorDirector {
  return {
    async decide(event, _state, caps) {
      switch (event.type) {
        case "message.received":
          return caps.executeTools([{ id: MAIL_TOOL, name: MAIL_TOOL, arguments: JSON.parse(event.message.content ?? "") }], false, false);
        case "tool.done":
          if (event.result.isError) throw new Error(`mail: ${JSON.stringify(event.result.content)}`);
          return caps.reply(JSON.stringify(event.result.content));
        default:
          return [];
      }
    },
  };
}

/** The mail director under the package that publishes it, which lists it in its `interchange.directors` module. */
export function mailDirectorOf(packageName: string) {
  return defineDirector<Record<string, never>>({
    id: `${packageName}/mail`,
    configSchema: type({}),
    factory: mailDirector,
  });
}

/** The agent that sends one mail; `inference` is declared because every agent names one, and is never called. */
export function mailAgentOf(director: ReturnType<typeof mailDirectorOf>, inference: AgentDefinition["inference"]) {
  return defineAgent({ id: "triage-mail", systemPrompt: "Send the mail the input names.", tools: [mailTool], capabilities: [], inference, director: director.build({}) });
}
