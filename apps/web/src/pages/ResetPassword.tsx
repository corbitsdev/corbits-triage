import { useState, type FormEvent } from "react";
import { useLocation } from "react-router-dom";
import { resetPassword } from "../lib/hub-auth.ts";

/** Where the hub's password reset email lands, with `?token=` or, for a spent or expired link, `?error=`. */
export function ResetPassword() {
  const token = new URLSearchParams(useLocation().search).get("token");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState(token ? "" : "This reset link was already used or has expired. Ask for a new one from the sign-in page.");

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;
    setPending(true);
    setError("");
    try {
      await resetPassword(token, password);
      setDone(true);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="gate">
      <section className="onboarding centered-setup" aria-label="Set a password">
        <h1>Set a password</h1>
        {done ? <p role="status" className="muted">Password set. Sign in with it.</p> : token && (
          <form onSubmit={(event) => void save(event)}>
            <label className="field">
              New password
              <input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} required disabled={pending} />
            </label>
            <button type="submit" className="btn primary" disabled={pending || !password}>{pending ? "Saving…" : "Set password"}</button>
          </form>
        )}
        {error && <p role="alert" className="error">{error}</p>}
        <a className="btn" href="/">Go to sign in</a>
      </section>
    </div>
  );
}
