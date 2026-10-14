import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Button, Input } from "@corbits/react-ui";
import { errorText } from "@corbits/common";
import { getAuthMethods, requestPasswordReset, signInWithGoogle, type AuthMethods } from "../lib/hub-auth.ts";
import { useSession } from "../lib/session.tsx";

type Mode = "sign-in" | "sign-up" | "reset";

function message(cause: unknown): string {
  return errorText(cause).replace(/[.\s]*$/, "");
}

function returnedSignInError(): string {
  const code = new URLSearchParams(window.location.search).get("error");
  return code === null ? "" : `Google sign-in failed (${code.replaceAll("_", " ")}). Use an allowed account, then try again.`;
}

export function Welcome() {
  const { signIn, signUp, error } = useSession();
  const [mode, setMode] = useState<Mode>("sign-in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
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

  if (mode === "reset") {
    return (
      <SignInShell>
        <div className="signin-head">
          <h1>Reset your password</h1>
          <p><button type="button" className="signin-link" onClick={() => switchTo("sign-in")}>Back to sign in</button></p>
        </div>
        <form className="signin-form" aria-busy={pending} onSubmit={(event) => void resetPassword(event)}>
          <label className="field">
            Email
            <Input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required disabled={pending} />
          </label>
          {notice && <p role="status" className="field-help">{notice}</p>}
          {shownError && <p role="alert" className="field-error">{shownError}</p>}
          <Button type="submit" size="lg" disabled={pending || !email}>{pending ? "Sending…" : "Send reset link"}</Button>
        </form>
      </SignInShell>
    );
  }

  const signingUp = mode === "sign-up";

  return (
    <SignInShell>
      <div className="signin-head">
        <h1>{signingUp ? "Create an account" : "Sign in"}</h1>
        {methods?.emailPassword && (
          <p>
            {signingUp ? "Have an account? " : "New to Corbits Triage? "}
            <button type="button" className="signin-link" disabled={pending} onClick={() => switchTo(signingUp ? "sign-in" : "sign-up")}>
              {signingUp ? "Sign in" : "Sign up for an account"}
            </button>.
          </p>
        )}
      </div>
      {shownError && <p role="alert" aria-live="assertive" className="field-error">{shownError}</p>}
      {methods?.emailPassword && (
        <form className="signin-form" aria-busy={pending} onSubmit={(event) => void submit(event)}>
          {signingUp && (
            <label className="field">
              Name
              <Input type="text" autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} required disabled={pending} />
            </label>
          )}
          <label className="field">
            Email
            <Input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required disabled={pending} />
          </label>
          <label className="field">
            Password
            <Input type="password" autoComplete={signingUp ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.target.value)} required disabled={pending} />
          </label>
          {methods.passwordReset && !signingUp && (
            <button type="button" className="signin-link signin-forgot" disabled={pending} onClick={() => switchTo("reset")}>Forgot password?</button>
          )}
          <Button type="submit" size="lg" disabled={pending}>{pending ? (signingUp ? "Signing up…" : "Signing in…") : signingUp ? "Sign up" : "Sign in"}</Button>
        </form>
      )}
      {methods?.google && (
        <>
          {methods.emailPassword && <p className="signin-or">Or with</p>}
          <Button type="button" variant="outline" size="lg" disabled={pending} aria-label="Continue with Google" onClick={() => void continueWithGoogle()}>
            <GoogleMark />Google
          </Button>
        </>
      )}
    </SignInShell>
  );
}

function SignInShell({ children }: { children: ReactNode }) {
  return (
    <div className="signin">
      <main className="signin-main">
        <div className="signin-column">{children}</div>
      </main>
      <div className="signin-brand" aria-hidden="true">
        <span className="signin-wordmark"><img src="/triage-logo.svg" width="48" height="48" alt="" />Corbits Triage</span>
      </div>
    </div>
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
