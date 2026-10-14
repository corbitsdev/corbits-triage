import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@corbits/react-ui";
import { useLocation } from "react-router-dom";
import { errorText } from "@corbits/common";
import { acceptInvitation } from "../lib/hub-api.ts";
import { getAuthMethods, hasSignInMethod } from "../lib/hub-auth.ts";
import { createHubTransport } from "../lib/hub-transport.ts";
import { useOpenWorkspaceAfterSending } from "../lib/held-inbox.tsx";
import { usePortal } from "../lib/portal.tsx";
import { useSession } from "../lib/session.tsx";
import { SignInShell } from "../components/SignInShell.tsx";

const SPENT = "This invite link was already used or has expired. Ask whoever invited you to resend it.";

/**
 * Where an invite lands. Arriving from the emailed magic link (`?from=email`) joins straight away; a copied link waits
 * for a click, so no other page can join someone by linking here. `?error=` means the magic link was spent or expired.
 */
export function AcceptInvite({ tenantId }: { tenantId: string }) {
  const { session, error: sessionError } = useSession();
  const { warn } = usePortal();
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
        warn("No password is set on this account. Use Reset password on the sign-in page to set one.");
      }
      await openWorkspace(tenantId, "/inbox");
    } catch (cause: unknown) {
      setRefusal(errorText(cause));
    }
  }, [openWorkspace, tenantId, warn]);

  useEffect(function acceptFromEmail() {
    if (session && fromEmail && !linkFailed) void accept();
  }, [accept, fromEmail, linkFailed, session]);

  function failure(): string {
    if (linkFailed) return SPENT;
    if (!session && sessionError) return `Could not load your session. ${sessionError} Reload the page to try again.`;
    return refusal;
  }

  const message = failure();
  if (message) {
    return (
      <SignInShell>
        <div className="signin-head">
          <h1>Could not join</h1>
          <p><a className="signin-link" href="/">{session ? "Go to Corbits Triage" : "Go to sign in"}</a></p>
        </div>
        <p role="alert" className="field-error">{message}</p>
      </SignInShell>
    );
  }
  if (!session) {
    return (
      <SignInShell>
        <div className="signin-head">
          <h1>Join the workspace</h1>
          <p>You were invited to a Corbits Triage workspace. Sign in as the invited address, then open this link again.</p>
          <p><a className="signin-link" href="/">Go to sign in</a></p>
        </div>
      </SignInShell>
    );
  }
  if (!joining) {
    return (
      <SignInShell>
        <div className="signin-head">
          <h1>Join the workspace</h1>
          <p>You were invited to a Corbits Triage workspace.</p>
        </div>
        <Button type="button" size="lg" onClick={() => void accept()}>Join</Button>
      </SignInShell>
    );
  }
  return (
    <SignInShell>
      <div className="signin-head" aria-busy="true">
        <h1>Join the workspace</h1>
        <p role="status">Joining…</p>
      </div>
    </SignInShell>
  );
}
