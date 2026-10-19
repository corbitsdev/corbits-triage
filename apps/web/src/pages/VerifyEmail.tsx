import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@corbits/react-ui";
import { errorText } from "@corbits/common";
import { getAuthMethods, resendVerificationEmail } from "../lib/hub-auth.ts";
import { useSignOutAfterSending } from "../lib/held-inbox.tsx";
import { SignInShell } from "../components/SignInShell.tsx";

export function VerifyEmail({ email }: { email: string }) {
  const signOut = useSignOutAfterSending();
  const methods = useQuery({ queryKey: ["auth-methods"], queryFn: getAuthMethods });
  const resend = useMutation({ mutationFn: () => resendVerificationEmail(email) });
  const sendsEmail = methods.data?.verificationEmail === true;

  return (
    <SignInShell>
      <div className="signin-head">
        <h1>Verify your email</h1>
        {sendsEmail && <p>Check your inbox to verify {email}. Open the link in the email to continue.</p>}
        {methods.data && !sendsEmail && <p>Ask whoever runs this Triage to verify your address.</p>}
      </div>
      {methods.error && <p role="alert" className="field-error">Could not load sign-in options. {errorText(methods.error)}</p>}
      {resend.isSuccess && <p role="status" className="field-help">A new link is on its way to {email}.</p>}
      {resend.error && <p role="alert" className="field-error">{errorText(resend.error)}</p>}
      <div className="signin-form">
        {sendsEmail && (
          <Button type="button" size="lg" disabled={resend.isPending} onClick={() => resend.mutate()}>
            {resend.isPending ? "Sending…" : "Resend link"}
          </Button>
        )}
        <Button type="button" variant="outline" size="lg" onClick={() => void signOut()}>Sign out</Button>
      </div>
    </SignInShell>
  );
}
