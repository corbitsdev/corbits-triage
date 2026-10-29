import { useEffect, useMemo, useState, type ChangeEvent, type ReactNode } from "react";
import { Badge, Button, StatusDot } from "@corbits/react-ui";
import { Link, useNavigate } from "react-router-dom";
import { Check, CircleCheck, Sparkles, Upload } from "lucide-react";
import { errorText } from "@corbits/common";
import { catchingUpRepos } from "../lib/backlog-status.ts";
import { useRepositories } from "../lib/bitbucket-datacenter.ts";
import { connectedSources, githubAppSlugFromCredentials, hasActiveGithubCredential, portalConnected, type PortalSnapshot, type RepoRecord } from "../lib/hub-api.ts";
import { hubOnLocalhost } from "../lib/hub-origin.ts";
import { createHubTransport } from "../lib/hub-transport.ts";
import { generateWebhookSecret, isPrivateKeyPem } from "../lib/connect-view.ts";
import {
  ManifestStartError,
  githubWebhookUrl,
  githubAppPickerUrl,
  GITHUB_APP_PICKER_UNAVAILABLE,
  postGithubManifest,
  saveExistingGithubApp,
  startGithubManifest,
} from "../lib/github-manifest.ts";
import { useGithubSync } from "../lib/github-sync.ts";
import { counted } from "../lib/plural.ts";
import { usePortal } from "../lib/portal.tsx";
import { sameRepo } from "../lib/repo-id.ts";
import { hostedRepos } from "../lib/repo-rows.ts";
import { useTriageVerdicts } from "../lib/triage-verdicts.ts";
import { CopyField } from "../components/CopyField.tsx";
import { BitbucketDatacenterSource } from "../components/settings/BitbucketDatacenterSource.tsx";
import { InvitePeople } from "../components/InvitePeople.tsx";
import { OtherWorkspaces } from "../components/OtherWorkspaces.tsx";

type GuidedStep = "create" | "install" | "select";

const STEP_PHASE: Record<GuidedStep, number> = { create: 0, install: 1, select: 1 };

function stepState(phase: number, index: number): "done" | "active" | "todo" {
  if (phase > index) return "done";
  if (phase === index) return "active";
  return "todo";
}

/** GitHub appends `installation_id` when it sends the browser back from installing the App. */
function returnedFromInstall(): boolean {
  return new URLSearchParams(window.location.search).has("installation_id");
}

function startingStep(snapshot: PortalSnapshot | null): GuidedStep {
  if (!snapshot || !portalConnected(snapshot)) return "create";
  if (!hasActiveGithubCredential(snapshot.credentials)) return "select";
  if (returnedFromInstall()) return "select";
  return snapshot.repos.length > 0 ? "select" : "install";
}

export default function Connect() {
  const { snapshot, refreshNow } = usePortal();
  const navigate = useNavigate();
  const initialStep = startingStep(snapshot);
  const [step, setStep] = useState<GuidedStep>(initialStep);
  const [appSlug, setAppSlug] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [fromGithub] = useState(returnedFromInstall);
  const [manualSaved, setManualSaved] = useState(false);
  const [appId, setAppId] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [pemName, setPemName] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [secretNotice, setSecretNotice] = useState("");
  const webhookUrl = snapshot ? githubWebhookUrl(snapshot.workspace.tenantId) : "";
  const repos = snapshot?.repos ?? [];
  const openable = useRepositories();
  const bitbucketConnected = Boolean(snapshot && connectedSources(snapshot.credentials).includes("bitbucket-datacenter"));
  const bitbucketError = bitbucketConnected ? openable.error : null;
  const listingError = bitbucketError ? `Could not read your repositories from Bitbucket Data Center. ${bitbucketError.message}` : null;
  const verdicts = useTriageVerdicts();
  const triaged = useMemo(() => hostedRepos(verdicts.data?.triaged ?? []), [verdicts.data]);
  const catching = useMemo(() => catchingUpRepos(verdicts.data?.pulls ?? [], triaged), [verdicts.data, triaged]);

  async function generateAndCopyWebhookSecret() {
    const secret = generateWebhookSecret();
    setWebhookSecret(secret);
    try {
      await navigator.clipboard.writeText(secret);
      setSecretNotice("Copied secret to clipboard. Back it up now—you won't be able to see it again after saving.");
    } catch {
      setSecretNotice("Secret generated. Copy it now—you won't be able to see it again after saving.");
    }
  }
  async function loadPem(file: File | undefined) {
    if (!file) return;
    setError("");
    try {
      const contents = await file.text();
      if (!isPrivateKeyPem(contents)) throw new Error("That file is not a GitHub App private key.");
      setPrivateKey(contents);
      setPemName(file.name);
    } catch (cause) {
      setPrivateKey("");
      setPemName("");
      setError(`Could not read the private key. ${errorText(cause)}`);
    }
  }
  async function startManifest(replace = false) {
    setBusy(true);
    setError("");
    try {
      if (!snapshot) throw new Error("The workspace is still loading.");
      const start = await startGithubManifest(createHubTransport(), snapshot.workspace.tenantId, window.location.origin, replace);
      postGithubManifest(start);
    } catch (cause) {
      if (cause instanceof ManifestStartError && cause.reason === "replacement_confirmation_required") {
        setBusy(false);
        if (window.confirm("A GitHub App is already connected. Replace it only after the new App is created successfully?")) {
          await startManifest(true);
        }
        return;
      }
      setError(`Could not start GitHub setup. ${errorText(cause)}`);
      setBusy(false);
    }
  }

  async function saveManual(replace = false) {
    if (!snapshot) return;
    setBusy(true);
    setError("");
    try {
      await saveExistingGithubApp({
        tenantId: snapshot.workspace.tenantId,
        appId,
        privateKey,
        webhookSecret,
        replace,
        credentials: snapshot.credentials,
      }, createHubTransport());
      setPrivateKey("");
      setPemName("");
      setWebhookSecret("");
      setManualSaved(true);
      const current = await refreshNow();
      setAppSlug(githubAppSlugFromCredentials(current?.credentials ?? []) ?? "");
      setStep("install");
    } catch (cause) {
      if (cause instanceof ManifestStartError && cause.reason === "replacement_confirmation_required") {
        setBusy(false);
        if (window.confirm("A GitHub App is already connected. Replace the GitHub App and webhook secrets?")) await saveManual(true);
        return;
      }
      setError(`Could not save the existing GitHub App. ${errorText(cause)} Try again.`);
    } finally {
      setBusy(false);
    }
  }

  const githubConnected = Boolean(snapshot && hasActiveGithubCredential(snapshot.credentials));
  const sync = useGithubSync(githubConnected && (fromGithub || repos.length === 0));
  const syncError = sync.error ? `Could not read your repositories from GitHub. ${sync.error.message}` : "";
  const noReposYet = fromGithub && sync.data?.repos.length === 0;
  // Only a listing that was read can show there are none; one still loading or not allowed says nothing.
  const githubRead = !githubConnected || (sync.data !== undefined && !syncError);
  const bitbucketRead = !bitbucketConnected || (!openable.pending && !bitbucketError);
  const noneVisible = !noReposYet && githubRead && bitbucketRead && openable.repos.length === 0;

  // Each sync result moves onboarding to the step GitHub's state implies.
  const [lastSync, setLastSync] = useState(sync.data);
  if (sync.data && sync.data !== lastSync) {
    setLastSync(sync.data);
    setStep(sync.data.repos.length > 0 ? "select" : "install");
  }

  async function chooseRepositories() {
    if (!snapshot) return;
    setError("");
    try {
      let slug = appSlug.trim();
      if (!slug) {
        slug = githubAppSlugFromCredentials(snapshot.credentials) ?? "";
        if (slug) setAppSlug(slug);
      }
      const appConnected = hasActiveGithubCredential(snapshot.credentials) || manualSaved;
      const url = githubAppPickerUrl(slug || null);
      if (!url) {
        setError(appConnected
          ? GITHUB_APP_PICKER_UNAVAILABLE
          : "Save the GitHub App ID and private key first, then add repositories.");
        return;
      }
      window.location.assign(url);
    } catch (cause) {
      setError(`Could not open GitHub. ${errorText(cause)}`);
    }
  }

  useEffect(function advancePastCreate() {
    if (step === "create" && snapshot && portalConnected(snapshot)) setStep(hasActiveGithubCredential(snapshot.credentials) ? "install" : "select");
  }, [snapshot, step]);

  function clearPrivateKey() {
    setPrivateKey("");
    setPemName("");
  }

  function pastePrivateKey(event: ChangeEvent<HTMLTextAreaElement>) {
    setPrivateKey(event.target.value);
    setPemName("");
  }

  function editWebhookSecret(event: ChangeEvent<HTMLInputElement>) {
    setWebhookSecret(event.target.value);
    setSecretNotice("");
  }

  function renderInstallRow(repo: RepoRecord) {
    const catchingUp = catching.some((row) => sameRepo(row, repo));
    return <div key={repo.name} className="install-row"><strong className="mono">{repo.name}</strong>{catchingUp ? <span className="catching-up"><StatusDot label="In progress" live tone="emphasis" />Catching up open pull requests…</span> : <Badge tone="success">Connected</Badge>}</div>;
  }

  const phase = STEP_PHASE[step];

  function renderStep(index: number, title: string, doneNote: string, renderBody: () => ReactNode) {
    const state = stepState(phase, index);
    return <li className={`setup-step is-${state}`} aria-current={state === "active" ? "step" : undefined}>
      <span className="setup-step-no" aria-hidden="true">{state === "done" ? <Check strokeWidth={2} /> : index + 1}</span>
      <div className="setup-step-body">
        <div><h2>{title}</h2>{state === "done" && <p>{doneNote}</p>}</div>
        {state === "active" && renderBody()}
      </div>
    </li>;
  }

  function renderCreateBody() {
    const intro = "GitHub will confirm a prefilled App, then ask which repositories it may see. The private key stays on the hub and is never shown here."
      + (hubOnLocalhost() ? " GitHub cannot reach a hub on localhost, so the App is created without a webhook and pull requests are picked up every five minutes." : "");
    return <>
      {busy
        ? <div className="setup-waiting" role="status"><StatusDot label="Working" live tone="emphasis" /><div><strong>Opening GitHub…</strong><p>{intro}</p></div></div>
        : <p>{intro}</p>}
      {error && <p role="alert" className="error">{error}</p>}
      <div className="task-actions"><Button type="button" disabled={busy} onClick={() => void startManifest()}>{busy ? "Opening GitHub…" : "Create GitHub App"}</Button></div>
      <details className="setup-help">
        <summary>Connect an existing GitHub App instead</summary>
        <p>Use the numeric App ID and private key from the App's General settings.</p>
        <div className="connection-fields">
          <label>App ID<input inputMode="numeric" value={appId} onChange={(event) => setAppId(event.target.value)} autoComplete="off" /><small className="muted">Use the App ID, not the Client ID.</small></label>
          <div className="pem-field full-span"><span className="field-label">Private key</span><input className="sr-only" id="existing-app-pem" type="file" accept=".pem" onChange={(event) => void loadPem(event.target.files?.[0])} />{privateKey ? <div className="file-loaded"><CircleCheck strokeWidth={1.7} aria-hidden="true" /><div><strong>{pemName || "Pasted private key"}</strong><small>Ready</small></div><Button asChild variant="outline"><label htmlFor="existing-app-pem">Replace</label></Button><Button type="button" variant="ghost" onClick={clearPrivateKey}>Remove</Button></div> : <label className="file-picker" htmlFor="existing-app-pem"><Upload strokeWidth={1.7} aria-hidden="true" /><span><strong>Choose .pem file</strong><small>Downloaded from GitHub App settings</small></span></label>}<details><summary>Paste key instead</summary><textarea aria-label="Private key" value={privateKey} onChange={pastePrivateKey} autoComplete="off" /></details></div>
          <label className="full-span">Webhook secret<div className="secret-input"><input type="password" value={webhookSecret} onChange={editWebhookSecret} autoComplete="new-password" /><Button type="button" variant="outline" size="icon" aria-label="Generate and copy webhook secret" title="Generate and copy webhook secret" onClick={() => void generateAndCopyWebhookSecret()}><Sparkles strokeWidth={1.7} aria-hidden="true" /></Button></div><small className="muted">Use the same secret in the GitHub App webhook settings.</small>{secretNotice && <small className="secret-notice" role="status">{secretNotice}</small>}</label>
          <CopyField className="full-span" label="Webhook URL" value={webhookUrl} />
          <details className="setup-help full-span"><summary>GitHub App settings</summary><p>Grant read access to Checks, Members and Metadata and read/write access to Contents, Issues and Pull requests. Set the active webhook URL to the value above, use the same secret, and subscribe to Pull request, Pull request review, Pull request review thread, Issue comment, Check run, Check suite and Push events. GitHub sends installation events without ticking them. Set the Setup URL to <code>{`${window.location.origin}/`}</code> and check “Redirect on update” so GitHub returns you here after choosing repositories.</p></details>
        </div>
        <div className="task-actions"><Button type="button" disabled={busy || !appId.trim() || !privateKey.trim() || !webhookSecret.trim()} onClick={() => void saveManual()}>{busy ? "Connecting…" : "Connect GitHub App"}</Button></div>
      </details>
      <details className="setup-help">
        <summary>Use Bitbucket Data Center instead</summary>
        <BitbucketDatacenterSource />
      </details>
    </>;
  }

  function renderRepositoriesBody() {
    return step === "install" ? <>
      <p>GitHub will ask which account and repositories this App can access, then send you back here. Repository selection stays on GitHub.</p>
      {noReposYet && <p role="status">GitHub reports no repositories for this App yet. Choose repositories on GitHub.</p>}
      {error && <p role="alert" className="error">{error}</p>}
      {syncError && <p role="alert" className="error">{syncError}</p>}
      <div className="task-actions">
        <Button type="button" onClick={() => void chooseRepositories()}>Choose repositories on GitHub</Button>
        {syncError && <Button type="button" variant="outline" disabled={sync.isFetching} onClick={() => void sync.refetch()}>Try again</Button>}
      </div>
    </> : <>
      {sync.isFetching && <div className="setup-waiting" role="status"><StatusDot label="Working" live tone="emphasis" /><div><strong>Reading your repositories from GitHub…</strong></div></div>}
      {error && <p role="alert" className="error">{error}</p>}
      {syncError && <p role="alert" className="error">{syncError}</p>}
      {listingError && <p role="alert" className="error">{listingError}</p>}
      {repos.length > 0 && <div className="repository-list">{repos.map(renderInstallRow)}</div>}
      {noneVisible && <p role="status">No repositories are visible to this connection yet. <Link className="linkish" to="/settings/triage">Change the connection in Settings</Link>.</p>}
      <div className="task-actions">
        {openable.repos.length > 0 && <Button type="button" onClick={() => navigate("/repositories")}>Open Repositories</Button>}
        {githubConnected && <Button type="button" variant="outline" disabled={busy} onClick={() => void chooseRepositories()}>Choose repositories again</Button>}
        {syncError && <Button type="button" variant="outline" disabled={sync.isFetching} onClick={() => void sync.refetch()}>Try again</Button>}
        {listingError && <Button type="button" variant="outline" disabled={openable.pending} onClick={() => void openable.retry()}>Try again</Button>}
      </div>
    </>;
  }

  const sourceDoneNote = githubConnected ? "GitHub App connected." : "Bitbucket Data Center connected.";
  const reposDoneNote = githubConnected ? `${counted(repos.length, "repository", "repositories")} selected on GitHub.` : "Turn triage on for each repository in Repositories.";

  return <div className="app is-auth"><main className="setup-flow">
    <span className="onboarding-brand">
      <img src="/triage-logo.svg" width="26" height="26" alt="Corbits" />
      Triage
    </span>
    <section className="setup" aria-labelledby="setup-title" aria-busy={busy}>
      <h1 id="setup-title">Set up Triage</h1>
      <p className="setup-lede">Two steps, then turn triage on for each repository.</p>
      <OtherWorkspaces />
      <ol className="setup-steps">
        {renderStep(0, "Connect a source", sourceDoneNote, renderCreateBody)}
        {renderStep(1, "Repositories", reposDoneNote, renderRepositoriesBody)}
      </ol>
      <InvitePeople onSetupPage />
    </section>
  </main></div>;
}
