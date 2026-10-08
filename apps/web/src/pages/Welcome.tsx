import { useEffect, useState, type FormEvent } from "react";
import { getAuthMethods, signInWithGoogle, type AuthMethods } from "../lib/hub-auth.ts";
import { useSession } from "../lib/session.tsx";

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
  const [creating, setCreating] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [localError, setLocalError] = useState(returnedSignInError);
  const [methods, setMethods] = useState<AuthMethods | null>(null);

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
      await (creating ? signUp : signIn)(email, password);
    } catch (cause: unknown) {
      const reason = message(cause);
      setLocalError(creating
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

  function toggleMode() {
    setCreating(!creating);
    setLocalError("");
  }

  return (
    <div className="app is-auth">
      <main className="signin">
        <span className="onboarding-brand">
          <img src="/triage-logo.svg" width="26" height="26" alt="Corbits" />
          Triage
        </span>
        <form
          className="signin-form"
          aria-busy={pending}
          onSubmit={(event) => void submit(event)}
        >
          <h1>{creating ? "Create your Triage account" : "Sign in to Triage"}</h1>
          <p>Every pull request sorted by what you need to do, with the reply already written.</p>
          {methods?.google && (
            <button type="button" className="btn primary large" disabled={pending} onClick={() => void continueWithGoogle()}>
              <GoogleMark /> Continue with Google
            </button>
          )}
          {methods?.google && methods.emailPassword && <div className="signin-or">or with email</div>}
          {methods?.emailPassword && <>
            <label className="field">
              Work email
              <input
                type="email"
                autoComplete="username"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
                aria-invalid={Boolean(localError || error)}
              />
            </label>
            <label className="field">
              Password
              <input
                type="password"
                autoComplete={creating ? "new-password" : "current-password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                aria-invalid={Boolean(localError || error)}
              />
            </label>
          </>}
          {(localError || error) && (
            <p role="alert" className="field-error">
              {localError || (error ? `Could not load your session. ${error} Reload the page to try again.` : "")}
            </p>
          )}
          {methods?.emailPassword && <>
            <button type="submit" className={methods.google ? "btn" : "btn primary large"} disabled={pending}>
              {creating ? (pending ? "Creating account…" : "Create account") : (pending ? "Signing in…" : "Sign in")}
            </button>
            <button type="button" className="signin-switch" onClick={toggleMode}>
              {creating ? "Have an account? Sign in" : "New here? Create an account"}
            </button>
          </>}
        </form>
      </main>
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
