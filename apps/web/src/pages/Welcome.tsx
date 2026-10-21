import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Input, LoginForm } from "@corbits/react-ui";
import { errorText } from "@corbits/common";
import { getAuthMethods, requestPasswordReset, signInWithGoogle } from "../lib/hub-auth.ts";
import { useSession } from "../lib/session.tsx";
import { SignInShell } from "../components/SignInShell.tsx";

type Mode = "sign-in" | "sign-up" | "reset";

function message(cause: unknown): string {
  return errorText(cause).replace(/[.\s]*$/, "");
}

/** The hub's own fallback repeats `what`, so the reason is shown only when it adds something. */
function failure(what: string, reason: string, hint: string): string {
  return reason === what ? `${what}.${hint}` : `${what}. ${reason}.${hint}`;
}

function returnedSignInError(): string {
  const code = new URLSearchParams(window.location.search).get("error");
  return code === null ? "" : `Google sign-in failed (${code.replaceAll("_", " ")}). Use an allowed account, then try again.`;
}

/** `intro` explains why sign-in is asked for, such as an invite waiting behind it. */
export function Welcome({ intro }: { intro?: string }) {
  const { signIn, signUp, error } = useSession();
  const methods = useQuery({ queryKey: ["auth-methods"], queryFn: getAuthMethods });
  const [mode, setMode] = useState<Mode>("sign-in");
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [localError, setLocalError] = useState(returnedSignInError);
  const [notice, setNotice] = useState("");

  async function submit(credentials: { name?: string; email: string; password: string }) {
    setPending(true);
    setLocalError("");
    try {
      await (mode === "sign-up"
        ? signUp(credentials.email, credentials.password, credentials.name)
        : signIn(credentials.email, credentials.password));
    } catch (cause: unknown) {
      setLocalError(mode === "sign-up"
        ? failure("Could not create the account", message(cause), "")
        : failure("Could not sign in", message(cause), " Check your email and password, then try again."));
    } finally {
      setPending(false);
    }
  }

  async function continueWithGoogle() {
    setPending(true);
    setLocalError("");
    try {
      await signInWithGoogle();
    } catch (cause: unknown) {
      setLocalError(`Could not start Google sign-in. ${message(cause)}.`);
      setPending(false);
    }
  }

  async function resetPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setLocalError("");
    try {
      await requestPasswordReset(email);
      setNotice(`If an account uses ${email}, a link to set its password is on its way.`);
    } catch (cause: unknown) {
      setLocalError(`Could not send the reset email. ${message(cause)}.`);
    } finally {
      setPending(false);
    }
  }

  function switchTo(next: Mode) {
    setMode(next);
    setLocalError("");
    setNotice("");
  }

  const shownError = localError || (error ? `Could not load your session. ${error} Reload the page to try again.` : null);

  if (methods.error) {
    return (
      <SignInShell>
        <div className="signin-head">
          <h1>Sign in</h1>
        </div>
        <p role="alert" className="signin-error">Could not load sign-in options. {message(methods.error)}.</p>
        <Button type="button" size="lg" disabled={methods.isFetching} onClick={() => void methods.refetch()}>
          {methods.isFetching ? "Trying again…" : "Try again"}
        </Button>
      </SignInShell>
    );
  }

  const resetting = mode === "reset";
  const signingUp = mode === "sign-up";
  const back = <button type="button" className="signin-link" onClick={() => switchTo("sign-in")}>Back to sign in</button>;
  const switcher = methods.data?.emailPassword && (
    <>
      {signingUp ? "Have an account? " : "New to Corbits Triage? "}
      <button type="button" className="signin-link" disabled={pending} onClick={() => switchTo(signingUp ? "sign-in" : "sign-up")}>
        {signingUp ? "Sign in" : "Create an account"}
      </button>
    </>
  );

  function keepEmail(event: FormEvent<HTMLDivElement>) {
    if (event.target instanceof HTMLInputElement && event.target.type === "email") setEmail(event.target.value);
  }

  return (
    <SignInShell footer={resetting ? back : switcher}>
      {resetting && (
        <>
          <div className="signin-head">
            <h1>Reset your password</h1>
            <p>Enter your email and we will send you a link to set a new password.</p>
          </div>
          {shownError && <p role="alert" className="signin-error">{shownError}</p>}
          {notice && <p role="status" className="signin-notice">{notice}</p>}
          <form className="signin-form" aria-busy={pending} onSubmit={(event) => void resetPassword(event)}>
            <label className="signin-field">
              Email
              <Input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required disabled={pending} />
            </label>
            <Button type="submit" size="lg" disabled={pending}>{pending ? "Sending…" : "Send reset link"}</Button>
          </form>
        </>
      )}
      {!resetting && intro && <p role="status" className="signin-notice">{intro}</p>}
      {!methods.data && (
        <div className="signin-head" aria-busy="true">
          <h1>Sign in</h1>
        </div>
      )}
      {methods.data && (
        // LoginForm keeps its own fields, so it stays mounted while resetting to keep what was typed.
        <div hidden={resetting} onInput={keepEmail}>
          <LoginForm
            mode={signingUp ? "sign-up" : "sign-in"}
            heading={signingUp ? "Create an account" : "Sign in"}
            providers={methods.data.google ? [{ id: "google", label: "Continue with Google", icon: <GoogleMark /> }] : []}
            onProvider={() => void continueWithGoogle()}
            onSubmit={methods.data.emailPassword ? (credentials) => void submit(credentials) : undefined}
            busy={pending}
            error={resetting ? null : shownError}
            footer={methods.data.passwordReset && !signingUp
              ? <button type="button" className="signin-link" disabled={pending} onClick={() => switchTo("reset")}>Forgot password?</button>
              : undefined}
          />
        </div>
      )}
    </SignInShell>
  );
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" width="16" height="16" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}
