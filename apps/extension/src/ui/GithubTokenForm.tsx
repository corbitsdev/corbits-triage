import { Button, Input, type ButtonProps } from "@corbits/react-ui";
import { Check } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { ask } from "../messages.ts";
import { tokenSaved } from "../storage.ts";
import { useStorageItem } from "./use-storage.ts";
import { errorText } from "@corbits/common";

type GithubTokenFormProps = { onSaved?: () => void; variant?: ButtonProps["variant"] };

// Public repositories, read-only, is the fine-grained form's default access, so the template needs no permissions.
const NEW_TOKEN_URL = "https://github.com/settings/personal-access-tokens/new?name=Corbits+Triage&description=Reads+public+pull+requests+for+the+Corbits+Triage+extension.&expires_in=90";

/** Stays in this browser. */
export function GithubTokenForm({ onSaved, variant = "outline" }: GithubTokenFormProps) {
  const saved = useStorageItem(tokenSaved);
  const [token, setToken] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hintId = useId();
  const errorId = useId();
  if (saved === undefined) return null;

  async function save(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!token.trim()) {
      setError("Paste a token first.");
      return;
    }
    setChecking(true);
    try {
      await ask({ type: "save-token", token: token.trim() });
      setToken("");
      setReplacing(false);
      onSaved?.();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setChecking(false);
    }
  }

  async function remove() {
    setError(null);
    try {
      await ask({ type: "remove-token" });
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  function replace() {
    setReplacing(true);
  }

  function cancel() {
    setReplacing(false);
    setToken("");
    setError(null);
  }

  if (saved && !replacing) {
    return (
      <div className="saved-setting github-token">
        <p className="saved-line"><Check className="saved-mark" aria-hidden="true" />Token saved.</p>
        <div className="row">
          <Button type="button" size="sm" variant="outline" onClick={replace}>Replace</Button>
          <Button type="button" size="sm" variant="ghost" onClick={remove}>Remove</Button>
        </div>
        {error ? <p className="error" role="alert">{error}</p> : null}
      </div>
    );
  }

  return (
    <form className="form github-token" onSubmit={save}>
      <div className="field">
        <label htmlFor={`${hintId}-input`}>GitHub token</label>
        <Input
          id={`${hintId}-input`}
          type="password"
          autoComplete="off"
          spellCheck={false}
          className="mono"
          value={token}
          placeholder="github_pat_…"
          aria-describedby={error ? `${hintId} ${errorId}` : hintId}
          aria-invalid={error ? true : undefined}
          onChange={(event) => setToken(event.target.value)}
        />
        <p className="hint" id={hintId}>
          <a href={NEW_TOKEN_URL} target="_blank" rel="noreferrer">Create a read-only token</a>. It stays in this browser.
        </p>
      </div>
      {error ? <p className="error" id={errorId} role="alert">{error}</p> : null}
      <div className="row">
        <Button type="submit" size="sm" variant={variant} disabled={checking}>{checking ? "Checking…" : "Save token"}</Button>
        {replacing ? <Button type="button" size="sm" variant="ghost" onClick={cancel}>Cancel</Button> : null}
      </div>
    </form>
  );
}
