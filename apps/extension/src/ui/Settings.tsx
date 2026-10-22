import { Badge, ConfirmButton } from "@corbits/react-ui";
import { errorText } from "@corbits/common";
import { useState, type ReactNode } from "react";
import { policyFiles, runStates, tokenSaved, views } from "../storage.ts";
import { GithubTokenForm } from "./GithubTokenForm.tsx";
import { useStorageItem } from "./use-storage.ts";

function SettingSection({ id, title, status, description, children }: { id: string; title: string; status?: ReactNode; description?: string; children: ReactNode }) {
  return (
    <section className="setting" aria-labelledby={id}>
      <div className="setting-head">
        <h2 id={id}>{title}</h2>
        {status}
      </div>
      {description ? <p className="hint">{description}</p> : null}
      {children}
    </section>
  );
}

function TokenSection() {
  const token = useStorageItem(tokenSaved);
  if (token === undefined) return null;
  return (
    <SettingSection id="setting-github" title="GitHub token" status={token ? <Badge tone="success">Saved</Badge> : null} description="Optional. Used read-only for what github.com does not show the extension while you are signed in.">
      <GithubTokenForm />
    </SettingSection>
  );
}

function AboutSection() {
  const all = useStorageItem(views);
  const [cleared, setCleared] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (all === undefined) return null;
  const count = Object.keys(all).length;

  async function clearRuns() {
    setError(null);
    try {
      await Promise.all([views.setValue({}), runStates.setValue({}), policyFiles.setValue({})]);
      setCleared(true);
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  return (
    <SettingSection id="setting-about" title="About">
      <dl className="facts">
        <div><dt>Version</dt><dd className="mono">{browser.runtime.getManifest().version}</dd></div>
        <div><dt>Saved checks</dt><dd className="mono">{count}</dd></div>
      </dl>
      <div className="row">
        <ConfirmButton size="sm" variant="outline" disabled={count === 0} confirmLabel="Clear them" onConfirm={clearRuns}>Clear saved checks</ConfirmButton>
      </div>
      {error ? <p className="error" role="alert">{error}</p> : null}
      {cleared ? <p className="hint" role="status">Cleared.</p> : null}
    </SettingSection>
  );
}

export function Settings() {
  return (
    <div className="settings">
      <TokenSection />
      <AboutSection />
    </div>
  );
}
