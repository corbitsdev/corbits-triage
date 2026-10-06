import { useEffect, useState, type FormEvent } from "react";
import { useSession } from "../lib/session.tsx";

export function Welcome() {
  const { signIn, signUp, error } = useSession();
  const [creating, setCreating] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [localError, setLocalError] = useState("");

  useEffect(function markLoginRoom() {
    document.body.dataset.room = "login";
    return function unmarkLoginRoom() {
      delete document.body.dataset.room;
    };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setLocalError("");
    try {
      await (creating ? signUp : signIn)(email, password);
    } catch (cause: unknown) {
      const reason = (cause instanceof Error ? cause.message : String(cause)).replace(/[.\s]*$/, "");
      setLocalError(creating
        ? `Could not create the account. ${reason}.`
        : `Could not sign in. ${reason}. Check your email and password, then try again.`);
    } finally {
      setPending(false);
    }
  }

  function toggleMode() {
    setCreating(!creating);
    setLocalError("");
  }

  return (
    <div className="app is-auth">
      <main className="login-room">
        <div className="login-stage">
          <div className="login-mark">
            <img src="/corbits-mark.svg" width="40" height="40" alt="" />
            <strong>corbits</strong>
          </div>
          <form
            className="login-form"
            aria-busy={pending}
            onSubmit={(event) => void submit(event)}
          >
            <header className="login-head">
              <h1>Classify every pull request.</h1>
              <p>{creating ? "Create an account to set up triage for your GitHub repositories." : "Sign in to the triage queue for your GitHub repositories."}</p>
            </header>
            <label className="field">
              Email
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
            {(localError || error) && (
              <p role="alert" className="field-error">
                {localError || (error ? `Could not load your session. ${error} Reload the page to try again.` : "")}
              </p>
            )}
            <button type="submit" className="btn primary" disabled={pending}>
              {creating ? (pending ? "Creating account…" : "Create account") : (pending ? "Signing in…" : "Sign in")}
            </button>
            <button type="button" className="login-switch" onClick={toggleMode}>
              {creating ? "Have an account? Sign in" : "New here? Create an account"}
            </button>
          </form>
        </div>
      </main>
    </div>
  );
}
