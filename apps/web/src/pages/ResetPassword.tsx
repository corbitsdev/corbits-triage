import { useState, type FormEvent } from "react";
import { Button, Input } from "@corbits/react-ui";
import { useLocation } from "react-router-dom";
import { errorText } from "@corbits/common";
import { resetPassword } from "../lib/hub-auth.ts";
import { SignInShell } from "../components/SignInShell.tsx";

export function ResetPassword() {
  const token = new URLSearchParams(useLocation().search).get("token");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;
    setPending(true);
    setError("");
    try {
      await resetPassword(token, password);
      setDone(true);
    } catch (cause: unknown) {
      setError(`Could not set the password. ${errorText(cause).replace(/[.\s]*$/, "")}.`);
    } finally {
      setPending(false);
    }
  }

  return (
    <SignInShell footer={done ? undefined : <Button asChild variant="link" size="sm"><a href="/">Back to sign in</a></Button>}>
      <div className="signin-head">
        <h1>Set a password</h1>
      </div>
      {!token && <p role="alert" className="signin-error">This reset link was already used or has expired. Ask for a new one from the sign-in page.</p>}
      {done && (
        <>
          <p role="status" className="signin-notice">Password set. Sign in with it.</p>
          <Button asChild size="lg"><a href="/">Go to sign in</a></Button>
        </>
      )}
      {token && !done && (
        <form className="signin-form" aria-busy={pending} onSubmit={(event) => void save(event)}>
          <label className="signin-field">
            New password
            <Input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} required disabled={pending} />
          </label>
          {error && <p role="alert" className="signin-error">{error}</p>}
          <Button type="submit" size="lg" disabled={pending}>{pending ? "Saving…" : "Set password"}</Button>
        </form>
      )}
    </SignInShell>
  );
}
