import { Badge, Button, ConfirmButton } from "@corbits/react-ui";
import { errorText } from "@corbits/common";
import { POLICY_FILE_PATH } from "@corbits/triage-contracts";
import { ChevronRight } from "lucide-react";
import { useState, type ReactNode } from "react";
import { changesFromDefaults } from "../pack-edit.ts";
import { readLocalPack } from "../pack-store.ts";
import type { PrRef } from "../pr.ts";
import { githubToken, localPacks, policyFiles, runStates, systemOne, views } from "../storage.ts";
import { DecisionModelForm } from "./DecisionModelForm.tsx";
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

function changesLine(stored: unknown, repo: string): string {
  if (stored === undefined) return "Recommended rules";
  const read = readLocalPack(stored, repo);
  if ("error" in read) return "Saved rules do not read";
  const count = changesFromDefaults(read.pack);
  return count ? `${count} ${count === 1 ? "change" : "changes"}` : "Recommended rules";
}

function RepoRules({ repo, usesFile, stored, onManage }: { repo: string; usesFile: boolean; stored: unknown; onManage: (repo: string) => void }) {
  if (usesFile) return <p className="repo-link"><span className="mono">{repo}</span><span className="hint">Uses {POLICY_FILE_PATH}</span></p>;
  return (
    <button type="button" className="repo-link" onClick={() => onManage(repo)}>
      <span className="mono">{repo}</span>
      <span className="hint">{changesLine(stored, repo)}</span>
      <ChevronRight aria-hidden="true" />
    </button>
  );
}

function RulesSection({ pr, onManage }: { pr: PrRef | undefined; onManage: (repo: string) => void }) {
  const packs = useStorageItem(localPacks);
  const files = useStorageItem(policyFiles);
  if (packs === undefined || files === undefined) return null;
  const repos = [...new Set([...(pr ? [pr.repo] : []), ...Object.keys(packs)])];
  return (
    <SettingSection id="setting-rules" title="Rules" description={`A repository's ${POLICY_FILE_PATH} on its default branch comes first; without one, the rules saved here apply, else the recommended rules.`}>
      {repos.length ? (
        <ul className="repo-links">
          {repos.map((repo) => <li key={repo}><RepoRules repo={repo} usesFile={files[repo]?.outcome.kind === "policy"} stored={packs[repo]} onManage={onManage} /></li>)}
        </ul>
      ) : <p className="empty-line">Open a pull request to change its repository's rules.</p>}
    </SettingSection>
  );
}

function TokenSection() {
  const token = useStorageItem(githubToken);
  if (token === undefined) return null;
  return (
    <SettingSection id="setting-github" title="GitHub token" status={token ? <Badge tone="success">Saved</Badge> : null} description="Required. Every read is made with it, read-only.">
      <GithubTokenForm />
    </SettingSection>
  );
}

function ModelSection() {
  const settings = useStorageItem(systemOne);
  const [choosing, setChoosing] = useState(false);
  if (settings === undefined) return null;

  function choose() {
    setChoosing(true);
  }

  function chosen() {
    setChoosing(false);
  }

  return (
    <SettingSection id="setting-model" title="Decision model" status={settings ? <Badge tone="success">Saved</Badge> : null} description="Optional. Answers the rules that need judgement; without one they show as not evaluated here.">
      {settings || choosing
        ? <DecisionModelForm current={settings} variant="outline" onSaved={chosen} onCancel={chosen} />
        : <div className="row"><Button size="sm" variant="outline" onClick={choose}>Choose a provider</Button></div>}
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

export function Settings({ pr, onManageRules }: { pr: PrRef | undefined; onManageRules: (repo: string) => void }) {
  return (
    <div className="settings">
      <TokenSection />
      <RulesSection pr={pr} onManage={onManageRules} />
      <ModelSection />
      <AboutSection />
    </div>
  );
}
