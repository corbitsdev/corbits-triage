import { type } from "arktype";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { HOOK_MOUNT_PATH } from "../hooks.js";
import { json } from "../route-schema.js";
import type { ProviderHook } from "./intake.js";
import { PROVIDER_HOOKS } from "./providers.js";

const Status = type({ status: "'queued' | 'coalesced' | 'accepted' | 'ignored' | 'needs-setup' | 'duplicate'" });
const Failure = type({ error: "string" });

/** Whether a request under the hook mount is a provider hook rather than a stock or GitHub one. */
export function isProviderHookPath(pathname: string): boolean {
  if (!pathname.startsWith(`${HOOK_MOUNT_PATH}/`)) return false;
  const segments = pathname.slice(HOOK_MOUNT_PATH.length + 1).split("/");
  return segments.length === 2 && PROVIDER_HOOKS.has(segments[0]!) && segments[1] !== "";
}

export function createProviderHookApp(handle: (req: Request, provider: ProviderHook, tenantId: string) => Promise<Response>) {
  const app = new Hono();
  app.post(
    `${HOOK_MOUNT_PATH}/:provider/:tenantId`,
    describeRoute({
      summary: "Receive a source host's signed pull request and push webhooks",
      description: "Verified against the tenant's `<provider>-hook` credential. Pull request events are queued for triage; a merge has the repository's other open pull requests triaged again; a branch update re-reads the policy file.",
      tags: ["hooks"],
      parameters: [
        { in: "path", name: "provider", required: true, schema: { type: "string", enum: [...PROVIDER_HOOKS.keys()] } },
        { in: "path", name: "tenantId", required: true, schema: { type: "string" } },
      ],
      responses: {
        200: json("Delivery already seen", Status),
        202: json("Accepted, queued or ignored", Status),
        400: json("Missing headers or invalid JSON", Failure),
        401: json("Invalid signature", Failure),
        404: json("Unknown provider, hook or repository", Failure),
        413: json("Payload too large", Failure),
        500: json("Could not read or queue; the provider retries", Failure),
      },
    }),
    function providerHook(c) {
      const provider = PROVIDER_HOOKS.get(c.req.param("provider"));
      if (!provider) return Response.json({ error: "unknown_provider" }, { status: 404 });
      return handle(c.req.raw, provider, c.req.param("tenantId"));
    },
  );
  return app;
}
