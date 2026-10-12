import { useEffect, useRef, useState } from "react";
import { acceptInvitation, resolveWorkspace } from "../lib/hub-api.ts";
import { createHubTransport } from "../lib/hub-transport.ts";
import { useOpenWorkspaceAfterSending, useSignOutAfterSending } from "../lib/held-inbox.tsx";

/** Why the invite failed, and the workspace the user is already active in, if any. */
type Refusal = { message: string; workspaceId: string | null };

export function AcceptInvite({ token }: { token: string }) {
  const openWorkspace = useOpenWorkspaceAfterSending();
  const signOut = useSignOutAfterSending();
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const accepted = useRef<string | null>(null);

  useEffect(function acceptOnce() {
    if (accepted.current === token) return;
    accepted.current = token;
    async function accept() {
      const transport = createHubTransport();
      try {
        await openWorkspace(await acceptInvitation(transport, token));
      } catch (cause: unknown) {
        const message = cause instanceof Error ? cause.message : String(cause);
        let workspaceId: string | null = null;
        try {
          const access = await resolveWorkspace(transport, null);
          if (access.kind === "member") workspaceId = access.workspace.tenantId;
        } catch {
          // Without a readable workspace the page still explains the refusal and offers sign out.
        }
        setRefusal({ message, workspaceId });
      }
    }
    void accept();
  }, [openWorkspace, token]);

  if (!refusal) {
    return (
      <main className="loading-gate" aria-busy="true" aria-label="Joining the workspace">
        <img src="/corbits-mark.svg" width="40" height="40" alt="" />
        <div>
          <strong role="status">Joining…</strong>
        </div>
      </main>
    );
  }
  const { message, workspaceId } = refusal;
  return (
    <div className="gate">
      <section className="onboarding centered-setup" aria-label="Invite">
        <h1>Could not join</h1>
        <p role="alert" className="error">{message}</p>
        <div className="row">
          {workspaceId && <button type="button" className="btn primary" onClick={() => void openWorkspace(workspaceId)}>Open your workspace</button>}
          <button type="button" className="btn" onClick={() => void signOut()}>Sign out</button>
        </div>
      </section>
    </div>
  );
}
