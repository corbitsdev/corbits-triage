import { useEffect, useState, type FormEvent } from "react";
import { AuthLayout, Button, Input, LoginForm } from "@corbits/react-ui";
import { getAuthMethods, requestPasswordReset, signInWithGoogle, type AuthMethods } from "../lib/hub-auth.ts";
import { useSession } from "../lib/session.tsx";

type Mode = "sign-in" | "sign-up" | "reset";

function message(cause: unknown): string {
  return (cause instanceof Error ? cause.message : String(cause)).replace(/[.\s]*$/, "");
}

/** better-auth sends the browser back with `?error=<code>` when social sign-in fails. */
function returnedSignInError(): string {
  const code = new URLSearchParams(window.location.search).get("error");
  return code === null ? "" : `Google sign-in failed (${code.replaceAll("_", " ")}). Use an allowed account, then try again.`;
}

export function Welcome() {
  const { signIn, signUp, error } = useSession();
  const [mode, setMode] = useState<Mode>("sign-in");
  const [resetEmail, setResetEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [localError, setLocalError] = useState(returnedSignInError);
  const [methods, setMethods] = useState<AuthMethods | null>(null);
  const [notice, setNotice] = useState("");

  useEffect(function loadAuthMethods() {
    async function load() {
      try {
        setMethods(await getAuthMethods());
      } catch (cause: unknown) {
        setLocalError(`Could not load sign-in options. ${message(cause)}.`);
      }
    }
    void load();
  }, []);

  async function submit({ name, email, password }: { name?: string; email: string; password: string }) {
    setPending(true);
    setLocalError("");
    try {
      await (mode === "sign-up" ? signUp(email, password, name) : signIn(email, password));
    } catch (cause: unknown) {
      const reason = message(cause);
      setLocalError(mode === "sign-up"
        ? `Could not create the account. ${reason}.`
        : `Could not sign in. ${reason}. Check your email and password, then try again.`);
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
      await requestPasswordReset(resetEmail);
      setNotice(`If an account uses ${resetEmail}, a link to set its password is on its way.`);
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

  if (mode === "reset") {
    return (
      <AuthLayout brand={<><img src="/triage-logo.svg" width="26" height="26" alt="Corbits" />Triage</>}>
        <form className="signin-reset" aria-busy={pending} onSubmit={(event) => void resetPassword(event)}>
          <h1>Reset your password</h1>
          <label className="field">
            Email
            <Input type="email" autoComplete="email" value={resetEmail} onChange={(event) => setResetEmail(event.target.value)} required disabled={pending} />
          </label>
          {notice && <p role="status" className="field-help">{notice}</p>}
          {shownError && <p role="alert" className="field-error">{shownError}</p>}
          <Button type="submit" size="lg" disabled={pending || !resetEmail}>{pending ? "Sending…" : "Send reset link"}</Button>
          <Button type="button" variant="link" size="sm" onClick={() => switchTo("sign-in")}>Back to sign in</Button>
        </form>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout brand={<><img src="/triage-logo.svg" width="26" height="26" alt="Corbits" />Triage</>}>
      <p className="signin-lede">Every pull request sorted by what you need to do, with the reply already written.</p>
      <LoginForm
        mode={mode}
        heading={mode === "sign-up" ? "Create your Triage account" : "Sign in to Triage"}
        providers={methods?.google ? [{ id: "google", label: "Continue with Google", icon: <GoogleMark /> }] : []}
        onProvider={() => void continueWithGoogle()}
        onSubmit={methods?.emailPassword ? (credentials) => void submit(credentials) : undefined}
        busy={pending}
        error={shownError}
        footer={methods?.emailPassword ? (
          <div className="signin-links">
            <Button type="button" variant="link" size="sm" onClick={() => switchTo(mode === "sign-up" ? "sign-in" : "sign-up")}>
              {mode === "sign-up" ? "Have an account? Sign in" : "New here? Create an account"}
            </Button>
            {methods.passwordReset && mode === "sign-in" && (
              <Button type="button" variant="link" size="sm" onClick={() => switchTo("reset")}>Reset password</Button>
            )}
          </div>
        ) : undefined}
      />
    </AuthLayout>
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
