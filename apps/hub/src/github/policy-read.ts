// A repository's policy as triage reads it, so the portal shows and edits the same artifact the hub mails.
import { type } from "arktype";
import type { CheckPackRead } from "./check-pack-store.js";
import type { Member } from "../integrations/app.js";

export const PolicyQuery = type({ repo: /^[\w.-]+\/[\w.-]+$/ });

export function createGithubPolicyRead(deps: { readCheckPack: (tenantId: string, repo: string) => Promise<CheckPackRead> }) {
  return async function handle({ repo }: typeof PolicyQuery.infer, { tenantId }: Member): Promise<Response> {
    const read = await deps.readCheckPack(tenantId, repo);
    if (read.status !== "ok") return Response.json(read);
    return Response.json({ status: "ok", pack: read.pack, source: read.source });
  };
}
