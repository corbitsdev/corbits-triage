import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@corbits/react-ui";
import { ApiError } from "@intx/hub-client";
import { useLocation } from "react-router-dom";
import { errorText } from "@corbits/common";
import { acceptInvitation } from "../lib/hub-api.ts";
import { getAuthMethods, hasSignInMethod } from "../lib/hub-auth.ts";
import { createHubTransport } from "../lib/hub-transport.ts";
import { useOpenWorkspaceAfterSending } from "../lib/held-inbox.tsx";
import { usePortal } from "../lib/portal.tsx";
import { useSession } from "../lib/session.tsx";
import { VerifyEmail } from "./VerifyEmail.tsx";
import { Welcome } from "./Welcome.tsx";
import { SignInShell } from "../components/SignInShell.tsx";

const SPENT = "This invite link was already used or has expired. Ask whoever invited you to resend it.";

/**
 * Where an invite lands. Arriving from the emailed magic link (`?from=email`) joins straight away; a copied link waits
 * for a click, so no other page can join someone by linking here. `?error=` beside `?from=email` means the magic link
 * was spent or expired; `?error=` alone is a failed Google sign-in, which the sign-in form reports.
 */
export function AcceptInvite({ tenantId }: { tenantId: string }) {
  const { session, error: sessionError } = useSession();
  const { warn } = usePortal();
  const openWorkspace = useOpenWorkspaceAfterSending();
  const params = new URLSearchParams(useLocation().search);
  const fromEmail = params.get("from") === "email";
  const linkFailed = fromEmail && params.has("error");
  const [refusal, setRefusal] = useState("");
  const [unverified, setUnverified] = useState(false);
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
      if (cause instanceof ApiError && cause.code === "email_unverified") setUnverified(true);
      else setRefusal(errorText(cause));
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

  if (session && unverified) return <VerifyEmail email={session.email} />;
  const message = failure();
  if (message) {
    return (
      <SignInShell>
        <div className="signin-head">
          <h1>Could not join</h1>
        </div>
        <p role="alert" className="signin-error">{message}</p>
        <Button asChild size="lg"><a href="/">{session ? "Go to Corbits Triage" : "Go to sign in"}</a></Button>
      </SignInShell>
    );
  }
  if (!session) return <Welcome intro="You were invited to a Corbits Triage workspace. Sign in as the invited address to join it." />;
  if (!joining) {
    return (
      <SignInShell>
        <div className="signin-head">
          <h1>Join the workspace</h1>
          <p>You were invited to a Corbits Triage workspace. You are signed in as {session.email}.</p>
        </div>
        <Button type="button" size="lg" onClick={() => void accept()}>Join workspace</Button>
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
