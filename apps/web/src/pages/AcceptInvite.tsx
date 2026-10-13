import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { acceptInvitation } from "../lib/hub-api.ts";
import { getAuthMethods, hasSignInMethod } from "../lib/hub-auth.ts";
import { createHubTransport } from "../lib/hub-transport.ts";
import { useOpenWorkspaceAfterSending } from "../lib/held-inbox.tsx";
import { usePortal } from "../lib/portal.tsx";
import { useSession } from "../lib/session.tsx";

const SPENT = "This invite link was already used or has expired. Ask whoever invited you to resend it.";
const SIGN_IN_FIRST = "Sign in as the invited address, then open the link again. Without email set up on this hub, invitees must sign in with Google first.";

/**
 * Where an invite lands. Arriving from the emailed magic link (`?from=email`) joins straight away; a copied link waits
 * for a click, so no other page can join someone by linking here. `?error=` means the magic link was spent or expired.
 */
export function AcceptInvite({ tenantId }: { tenantId: string }) {
  const { session } = useSession();
  const { notify } = usePortal();
  const openWorkspace = useOpenWorkspaceAfterSending();
  const params = new URLSearchParams(useLocation().search);
  const linkFailed = params.has("error");
  const fromEmail = params.get("from") === "email";
  const [refusal, setRefusal] = useState("");
  const [joining, setJoining] = useState(false);
  const accepted = useRef(false);

  const accept = useCallback(async function accept() {
    if (accepted.current) return;
    accepted.current = true;
    setJoining(true);
    try {
      await acceptInvitation(createHubTransport(), tenantId);
      // An invite's magic link is the only sign-in such an account has had.
      if (!(await hasSignInMethod()) && (await getAuthMethods()).passwordReset) {
        notify("No password is set on this account. Use Reset password on the sign-in page to set one.");
      }
      await openWorkspace(tenantId, "/inbox");
    } catch (cause: unknown) {
      setRefusal(cause instanceof Error ? cause.message : String(cause));
    }
  }, [notify, openWorkspace, tenantId]);

  useEffect(function acceptFromEmail() {
    if (session && fromEmail && !linkFailed) void accept();
  }, [accept, fromEmail, linkFailed, session]);

  const message = linkFailed ? SPENT : !session ? SIGN_IN_FIRST : refusal;
  if (message) {
    return (
      <div className="gate">
        <section className="onboarding centered-setup" aria-label="Invite">
          <h1>Could not join</h1>
          <p role="alert" className="error">{message}</p>
          <a className="btn" href="/">Go to Corbits Triage</a>
        </section>
      </div>
    );
  }
  if (!joining) {
    return (
      <div className="gate">
        <section className="onboarding centered-setup" aria-label="Invite">
          <h1>Join the workspace</h1>
          <p className="muted">You were invited to a Corbits Triage workspace.</p>
          <button type="button" className="btn primary" onClick={() => void accept()}>Join</button>
        </section>
      </div>
    );
  }
  return (
    <main className="loading-gate" aria-busy="true" aria-label="Joining the workspace">
      <img src="/corbits-mark.svg" width="40" height="40" alt="" />
      <div>
        <strong role="status">Joining…</strong>
      </div>
    </main>
  );
}
