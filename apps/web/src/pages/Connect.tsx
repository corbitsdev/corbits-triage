import { useEffect, useState, type ChangeEvent, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Check, CircleCheck, Sparkles, Upload } from "lucide-react";
import { isRepoCatchingUp } from "../lib/backlog-status.ts";
import { githubAppSlugFromCredentials, hasActiveGithubCredential, projectQueue, type PortalSnapshot, type RepoRecord } from "../lib/hub-api.ts";
import { createHubTransport } from "../lib/hub-transport.ts";
import { generateWebhookSecret, hasObservedInference, hasVerifiedWebhookDelivery, isPrivateKeyPem } from "../lib/connect-view.ts";
import {
  ManifestStartError,
  cancelGithubManifest,
  githubWebhookUrl,
  githubAppPickerUrl,
  GITHUB_APP_PICKER_UNAVAILABLE,
  postGithubManifest,
  saveExistingGithubApp,
  startGithubManifest,
} from "../lib/github-manifest.ts";
import { useGithubSync } from "../lib/github-sync.ts";
import { usePortal } from "../lib/portal.tsx";
import { useRunLogs } from "../lib/run-logs.ts";
import { DecisionModelForm } from "../components/DecisionModelForm.tsx";
import { DECISION_MODEL_INTRO, hasDecisionModelCredential } from "../lib/decision-models.ts";

type GuidedStep = "create" | "install" | "select" | "model";

/** GitHub appends `installation_id` when it sends the browser back from installing the App. */
function returnedFromInstall(): boolean {
  return new URLSearchParams(window.location.search).has("installation_id");
}

function startingStep(snapshot: PortalSnapshot | null, returnedFromGithub: boolean): GuidedStep {
  if (returnedFromGithub) return "install";
  if (!snapshot || !hasActiveGithubCredential(snapshot.credentials)) return "create";
  if (returnedFromInstall()) return "select";
  return snapshot.repos.length > 0 ? "model" : "install";
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export default function Connect() {
  const { snapshot, refreshNow } = usePortal();
  const navigate = useNavigate();
  const params = new URLSearchParams(window.location.search);
  const connected = params.get("github") === "connected";
  const initialStep = startingStep(snapshot, connected);
  const [step, setStep] = useState<GuidedStep>(initialStep);
  const [appSlug, setAppSlug] = useState(params.get("app") ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [fromGithub] = useState(returnedFromInstall);
  const [setupInProgress, setSetupInProgress] = useState(false);
  const [manualSaved, setManualSaved] = useState(false);
  const [appId, setAppId] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [pemName, setPemName] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [secretNotice, setSecretNotice] = useState("");
  const [webhookUrlNotice, setWebhookUrlNotice] = useState("");
  const webhookUrl = snapshot ? githubWebhookUrl(snapshot.workspace.tenantId) : "";
  const repos = snapshot?.repos ?? [];
  const { logs } = useRunLogs();
  const items = snapshot ? projectQueue(logs, snapshot.approvals) : [];
  const githubReady = repos.some((repo) => hasVerifiedWebhookDelivery(logs, repo.name));
  const modelStored = hasDecisionModelCredential(snapshot?.credentials ?? []);
  const inferenceReady = hasObservedInference(items);
  const liveReady = githubReady && inferenceReady;

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
  async function copyWebhookUrl() {
    if (!webhookUrl) return;
    try {
      await navigator.clipboard.writeText(webhookUrl);
      setWebhookUrlNotice("Webhook URL copied.");
    } catch {
      setWebhookUrlNotice("Could not copy automatically. Select the URL and copy it.");
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
      setError(`Could not read the private key. ${message(cause)}`);
    }
  }
  async function startManifest(replace = false, restart = false) {
    setBusy(true);
    setError("");
    try {
      if (!snapshot) throw new Error("The workspace is still loading.");
      const start = await startGithubManifest(createHubTransport(), snapshot.workspace.tenantId, window.location.origin, replace, restart);
      postGithubManifest(start);
    } catch (cause) {
      if (cause instanceof ManifestStartError && cause.reason === "replacement_confirmation_required") {
        setBusy(false);
        if (window.confirm("A GitHub App is already connected. Replace it only after the new App is created successfully?")) {
          await startManifest(true);
        }
        return;
      }
      if (cause instanceof ManifestStartError && cause.reason === "setup_in_progress") {
        setSetupInProgress(cause.owned);
        setError(cause.owned
          ? "You already have a GitHub setup in progress. Resume it by restarting the GitHub confirmation, or cancel it."
          : "Another workspace member has GitHub setup in progress. Ask them to finish or cancel it.");
        setBusy(false);
        return;
      }
      setError(`Could not start GitHub setup. ${message(cause)}`);
      setBusy(false);
    }
  }

  async function cancelSetup() {
    if (!snapshot) return;
    setBusy(true);
    setError("");
    try {
      await cancelGithubManifest(snapshot.workspace.tenantId);
      setSetupInProgress(false);
    } catch (cause) {
      setError(`Could not cancel GitHub setup. ${message(cause)}`);
    } finally {
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
        appSlug,
        replace,
        credentials: snapshot.credentials,
      }, createHubTransport());
      setPrivateKey("");
      setPemName("");
      setWebhookSecret("");
      setAppSlug("");
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
      setError(`Could not save the existing GitHub App. ${message(cause)}`);
    } finally {
      setBusy(false);
    }
  }

  const githubConnected = Boolean(snapshot && hasActiveGithubCredential(snapshot.credentials));
  const sync = useGithubSync(githubConnected && (fromGithub || repos.length === 0));
  const syncError = sync.error ? `Could not read your repositories from GitHub. ${sync.error.message}` : "";
  const noReposYet = fromGithub && sync.data?.repos.length === 0;

  // Each sync result moves onboarding to the step GitHub's state implies.
  const [lastSync, setLastSync] = useState(sync.data);
  if (sync.data && sync.data !== lastSync) {
    setLastSync(sync.data);
    setStep(sync.data.repos.length > 0 ? "model" : "install");
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
      setError(`Could not open GitHub. ${message(cause)}`);
    }
  }

  useEffect(function advancePastCreate() {
    if (step === "create" && snapshot && hasActiveGithubCredential(snapshot.credentials)) setStep("install");
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
    const catchingUp = snapshot ? isRepoCatchingUp(logs, snapshot.runs, repo.name) : false;
    return <div key={repo.name} className="install-row"><strong className="mono">{repo.name}</strong><span className={`status-badge${catchingUp ? "" : " status-ok"}`}><span aria-hidden="true" />{catchingUp ? "Catching up open pull requests…" : "Connected"}</span></div>;
  }

  const phase = step === "create" ? 0 : step === "model" ? 2 : 1;

  function renderStep(index: number, title: string, doneNote: string, renderBody: () => ReactNode) {
    const state = phase > index ? "done" : phase === index ? "active" : "todo";
    return <li className={`setup-step is-${state}`} aria-current={state === "active" ? "step" : undefined}>
      <span className="setup-step-no" aria-hidden="true">{state === "done" ? <Check strokeWidth={2} /> : index + 1}</span>
      <div className="setup-step-body">
        <div><h2>{title}</h2>{state === "done" && <p>{doneNote}</p>}</div>
        {state === "active" && renderBody()}
      </div>
    </li>;
  }

  function renderCreateBody() {
    return <>
      {busy
        ? <div className="setup-waiting" role="status"><span className="activity-dot" aria-hidden="true" /><div><strong>Opening GitHub…</strong><p>GitHub will confirm a prefilled App. The private key stays on the hub and is never shown here.</p></div></div>
        : <p>GitHub will confirm a prefilled App. The private key stays on the hub and is never shown here.</p>}
      {error && <p role="alert" className="error">{error}</p>}
      <div className="task-actions"><button type="button" className="btn primary" disabled={busy} onClick={() => void startManifest()}>{busy ? "Opening GitHub…" : "Create GitHub App"}</button></div>
      {setupInProgress && <div className="task-actions"><button type="button" className="btn" disabled={busy} onClick={() => void startManifest(false, true)}>Resume setup</button><button type="button" className="btn" disabled={busy} onClick={() => void cancelSetup()}>Cancel setup</button></div>}
      <details className="setup-help">
        <summary>Connect an existing GitHub App instead</summary>
        <p>Use the numeric App ID and private key from the App's General settings.</p>
        <div className="connection-fields">
          <label>App ID<input inputMode="numeric" value={appId} onChange={(event) => setAppId(event.target.value)} autoComplete="off" /><small className="muted">Use the App ID, not the Client ID.</small></label>
          <label>App slug<input value={appSlug} onChange={(event) => setAppSlug(event.target.value)} autoComplete="off" /><small className="muted">{"From the App’s public URL, github.com/apps/{slug}."}</small></label>
          <div className="pem-field full-span"><span className="field-label">Private key</span><input className="sr-only" id="existing-app-pem" type="file" accept=".pem" onChange={(event) => void loadPem(event.target.files?.[0])} />{privateKey ? <div className="file-loaded"><CircleCheck strokeWidth={1.7} aria-hidden="true" /><div><strong>{pemName || "Pasted private key"}</strong><small>Ready</small></div><label className="btn" htmlFor="existing-app-pem">Replace</label><button type="button" className="btn ghost" onClick={clearPrivateKey}>Remove</button></div> : <label className="file-picker" htmlFor="existing-app-pem"><Upload strokeWidth={1.7} aria-hidden="true" /><span><strong>Choose .pem file</strong><small>Downloaded from GitHub App settings</small></span></label>}<details><summary>Paste key instead</summary><textarea aria-label="Private key" value={privateKey} onChange={pastePrivateKey} autoComplete="off" /></details></div>
          <label className="full-span">Webhook secret<div className="secret-input"><input type="password" value={webhookSecret} onChange={editWebhookSecret} autoComplete="new-password" /><button type="button" className="btn" aria-label="Generate and copy webhook secret" title="Generate and copy webhook secret" onClick={() => void generateAndCopyWebhookSecret()}><Sparkles strokeWidth={1.7} aria-hidden="true" /></button></div><small className="muted">Use the same secret in the GitHub App webhook settings.</small>{secretNotice && <small className="secret-notice" role="status">{secretNotice}</small>}</label>
          <div className="webhook-url-field full-span"><span className="field-label">Webhook URL</span><div className="copy-field"><input aria-label="Webhook URL" readOnly value={webhookUrl} onFocus={(event) => event.currentTarget.select()} /><button type="button" className="btn" onClick={() => void copyWebhookUrl()}>Copy</button></div>{webhookUrlNotice && <small role="status" className="secret-notice">{webhookUrlNotice}</small>}</div>
          <details className="setup-help full-span"><summary>GitHub App settings</summary><p>Grant read access to Checks and Metadata and read/write access to Contents, Issues and Pull requests. Set the active webhook URL to the value above, use the same secret, and subscribe to Pull request, Pull request review, Issue comment, Check run, Installation, and Installation repositories events. Set the Setup URL to <code>{`${window.location.origin}/`}</code> and check “Redirect on update” so GitHub returns you here after choosing repositories.</p></details>
        </div>
        <div className="task-actions"><button type="button" className="btn primary" disabled={busy || !appId.trim() || !appSlug.trim() || !privateKey.trim() || !webhookSecret.trim()} onClick={() => void saveManual()}>{busy ? "Connecting…" : "Connect GitHub App"}</button></div>
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
        <button type="button" className="btn primary" onClick={() => void chooseRepositories()}>Choose repositories on GitHub</button>
        {syncError && <button type="button" className="btn" disabled={sync.isFetching} onClick={() => void sync.refetch()}>Try again</button>}
      </div>
    </> : <>
      {sync.isFetching && <div className="setup-waiting" role="status"><span className="activity-dot" aria-hidden="true" /><div><strong>Reading your repositories from GitHub…</strong></div></div>}
      {error && <p role="alert" className="error">{error}</p>}
      {syncError && <p role="alert" className="error">{syncError}</p>}
      {repos.length > 0 && <div className="repository-list">{repos.map(renderInstallRow)}</div>}
      <div className="task-actions">
        {repos.length > 0 && <button type="button" className="btn primary" onClick={() => setStep("model")}>Next: add decision model</button>}
        <button type="button" className="btn" disabled={busy} onClick={() => void chooseRepositories()}>Choose repositories again</button>
        {syncError && <button type="button" className="btn" disabled={sync.isFetching} onClick={() => void sync.refetch()}>Try again</button>}
      </div>
    </>;
  }

  function renderModelBody() {
    return <>
      <p>{DECISION_MODEL_INTRO}</p>
      {modelStored
        ? <div className="success-callout" role="status"><CircleCheck strokeWidth={1.7} aria-hidden="true" /><div><strong>Decision model connected</strong><p>Triage starts on the next pull request event.</p></div></div>
        : <DecisionModelForm />}
      {modelStored && !liveReady && <p role="status" className="muted">{githubReady ? "Waiting for the first triage run." : "Waiting for GitHub to deliver a webhook."}</p>}
      <div className="task-actions">
        {modelStored && <button type="button" className="btn primary" disabled={!liveReady} onClick={() => navigate("/inbox")}>Open triage</button>}
        <button type="button" className="btn ghost" onClick={() => setStep("select")}>Back to repositories</button>
      </div>
    </>;
  }

  const githubDoneNote = connected ? "GitHub App created. Its private key stays on the hub." : "GitHub App connected.";
  const reposDoneNote = `${repos.length} ${repos.length === 1 ? "repository" : "repositories"} selected on GitHub.`;

  return <div className="app is-auth"><main className="setup-flow">
    <span className="onboarding-brand">
      <img src="/triage-logo.svg" width="26" height="26" alt="Corbits" />
      Triage
    </span>
    <section className="setup" aria-labelledby="setup-title" aria-busy={busy}>
      <h1 id="setup-title">Set up Triage</h1>
      <p className="setup-lede">Three steps and Triage starts sorting your open pull requests.</p>
      <ol className="setup-steps">
        {renderStep(0, "Connect GitHub", githubDoneNote, renderCreateBody)}
        {renderStep(1, "Repositories", reposDoneNote, renderRepositoriesBody)}
        {renderStep(2, "Decision model", "", renderModelBody)}
      </ol>
    </section>
  </main></div>;
}
