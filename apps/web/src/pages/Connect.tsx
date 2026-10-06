// SPDX-License-Identifier: GPL-2.0-only
import { useEffect, useState, type ChangeEvent } from "react";
import { useNavigate } from "react-router-dom";
import { CircleCheck, Sparkles, Upload } from "lucide-react";
import { isRepoCatchingUp } from "../lib/backlog-status.ts";
import { githubAppSlugFromCredentials, hasActiveGithubCredential, projectQueue, type RepoRecord } from "../lib/hub-api.ts";
import { createHubTransport } from "../lib/hub-transport.ts";
import { generateWebhookSecret, hasObservedInference, hasVerifiedWebhookDelivery, isPrivateKeyPem, pollUntil } from "../lib/connect-view.ts";
import {
  ManifestStartError,
  cancelGithubManifest,
  githubWebhookUrl,
  githubAppPickerUrl,
  GITHUB_APP_PICKER_UNAVAILABLE,
  openGithubInstallation,
  postGithubManifest,
  saveExistingGithubApp,
  startGithubManifest,
} from "../lib/github-manifest.ts";
import { usePortal } from "../lib/portal.tsx";
import { useGithubReturnSync } from "../lib/github-return-sync.ts";

type GuidedStep = "create" | "install" | "select";

const STEPS: Array<{ id: GuidedStep; label: string }> = [
  { id: "create", label: "Create GitHub App" },
  { id: "install", label: "Choose repositories on GitHub" },
  { id: "select", label: "See selected repositories" },
];

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export default function Connect() {
  const { snapshot, refreshNow } = usePortal();
  const navigate = useNavigate();
  const params = new URLSearchParams(window.location.search);
  const connected = params.get("github") === "connected";
  const [step, setStep] = useState<GuidedStep>(connected ? "install" : "create");
  const [appSlug, setAppSlug] = useState(params.get("app") ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
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
  const items = snapshot ? projectQueue(snapshot) : [];
  const githubReady = repos.some((repo) => hasVerifiedWebhookDelivery(snapshot?.logs ?? [], repo.name));
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
      const start = await startGithubManifest(snapshot.workspace.tenantId, window.location.origin, replace, restart);
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

  async function observeRepositories() {
    setBusy(true);
    setError("");
    try {
      const current = await refreshNow();
      if ((current?.repos.length ?? 0) > 0) return;
      async function hasRepos() {
        const next = await refreshNow();
        return (next?.repos.length ?? 0) > 0;
      }
      const found = await pollUntil(hasRepos, { attempts: 24, delayMs: 500 });
      if (!found) setError("Confirm the App is installed on GitHub, then Refresh.");
    } catch (cause) {
      setError(`Could not refresh repositories. ${message(cause)}`);
    } finally {
      setBusy(false);
    }
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
      if (!openGithubInstallation(url)) {
        setError("Your browser blocked the GitHub window. Allow popups for this page, then try again.");
        return;
      }
      arm();
      setStep("select");
    } catch (cause) {
      setError(`Could not open GitHub. ${message(cause)}`);
    }
  }

  const { arm } = useGithubReturnSync(() => { void observeRepositories(); });

  useEffect(function markConnectRoom() {
    document.body.dataset.room = "connect";
    return function unmarkConnectRoom() {
      delete document.body.dataset.room;
    };
  }, []);

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
    const catchingUp = snapshot ? isRepoCatchingUp(snapshot, repo.name) : false;
    return <div key={repo.name} className="install-row"><strong className="mono">{repo.name}</strong><span className={`status-badge${catchingUp ? "" : " status-ok"}`}><span aria-hidden="true" />{catchingUp ? "Catching up open pull requests…" : "Connected"}</span></div>;
  }

  const active = STEPS.findIndex((item) => item.id === step);
  const progress = step === "select" ? "repos" : "install";

  return <div className="app is-auth"><main className="connect-room">
    <div className="auth-mast">
      <img src="/corbits-mark.svg" width="28" height="28" alt="" />
      <strong>corbits</strong>
    </div>
    <ol className="connect-progress">
      <li aria-current={progress === "install" ? "step" : undefined}><span className="step-index">01</span>Connect</li>
      <li aria-current={progress === "repos" ? "step" : undefined}><span className="step-index">02</span>Add repos</li>
    </ol>
    <div className="connect-task">
    <section className="setup-coach" aria-labelledby="setup-title">
      <aside className="setup-progress">
        <h1 id="setup-title" tabIndex={-1}>{STEPS[active]?.label ?? "Connect GitHub"}</h1>
        <p className="lede">Install the App on GitHub, then choose repositories.</p>
      </aside>

      <section className="setup-task panel" aria-live="polite" aria-busy={busy}>
        {step === "create" && <>
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
            <div className="pem-field"><span className="field-label">Private key</span><input className="sr-only" id="existing-app-pem" type="file" accept=".pem" onChange={(event) => void loadPem(event.target.files?.[0])} />{privateKey ? <div className="file-loaded"><CircleCheck strokeWidth={1.7} aria-hidden="true" /><div><strong>{pemName || "Pasted private key"}</strong><small>Ready</small></div><label className="btn" htmlFor="existing-app-pem">Replace</label><button type="button" className="btn ghost" onClick={clearPrivateKey}>Remove</button></div> : <label className="file-picker" htmlFor="existing-app-pem"><Upload strokeWidth={1.7} aria-hidden="true" /><span><strong>Choose .pem file</strong><small>Downloaded from GitHub App settings</small></span></label>}<details><summary>Paste key instead</summary><textarea aria-label="Private key" value={privateKey} onChange={pastePrivateKey} autoComplete="off" /></details></div>
            <label className="full-span">Webhook secret<div className="secret-input"><input type="password" value={webhookSecret} onChange={editWebhookSecret} autoComplete="new-password" /><button type="button" className="btn" aria-label="Generate and copy webhook secret" title="Generate and copy webhook secret" onClick={() => void generateAndCopyWebhookSecret()}><Sparkles strokeWidth={1.7} aria-hidden="true" /></button></div><small className="muted">Use the same secret in the GitHub App webhook settings.</small>{secretNotice && <small className="secret-notice" role="status">{secretNotice}</small>}</label>
            <div className="webhook-url-field"><span className="field-label">Webhook URL</span><div className="copy-field"><input aria-label="Webhook URL" readOnly value={webhookUrl} onFocus={(event) => event.currentTarget.select()} /><button type="button" className="btn" onClick={() => void copyWebhookUrl()}>Copy</button></div>{webhookUrlNotice && <small role="status" className="secret-notice">{webhookUrlNotice}</small>}</div>
            <details className="setup-help"><summary>GitHub App settings</summary><p>Grant read access to Checks and Metadata and read/write access to Contents, Issues and Pull requests. Set the active webhook URL to the value above, use the same secret, and subscribe to Pull request, Pull request review, Issue comment, Check run, Installation, and Installation repositories events.</p></details>
            </div>
            <div className="task-actions"><button type="button" className="btn primary" disabled={busy || !appId.trim() || !appSlug.trim() || !privateKey.trim() || !webhookSecret.trim()} onClick={() => void saveManual()}>{busy ? "Connecting…" : "Connect GitHub App"}</button></div>
          </details>
        </>}

        {step === "install" && <>
                    <div className="success-callout" role="status"><CircleCheck strokeWidth={1.7} aria-hidden="true" /><div><strong>GitHub App connected</strong><p>{connected ? "The private key was exchanged by the hub and never sent to this browser." : "The GitHub App ID and private key were saved."}</p></div></div>
          <p>GitHub will ask which account and repositories this App can access. Repository selection stays on GitHub.</p>
          {error && <p role="alert" className="error">{error}</p>}
          <div className="task-actions"><button type="button" className="btn primary" onClick={() => void chooseRepositories()}>Choose repositories on GitHub</button></div>
        </>}

        {step === "select" && <>
                    {repos.length === 0
            ? <div className="setup-waiting" role="status"><span className="activity-dot" aria-hidden="true" /><div><strong>Wait for GitHub to deliver the installation, then Refresh.</strong>{busy && <p>Refreshing…</p>}</div></div>
            : null}
          {error && <p role="alert" className="error">{error}</p>}
          {repos.length > 0 && <div className="repository-list">{repos.map(renderInstallRow)}</div>}
          {repos.length > 0 && githubReady && !inferenceReady && <p role="status">Inference not observed yet.</p>}
          <div className="task-actions">
            <button type="button" className="btn primary" disabled={busy} onClick={() => void observeRepositories()}>{busy ? "Refreshing…" : "Refresh"}</button>
            <button type="button" className="btn" disabled={busy} onClick={() => void chooseRepositories()}>Choose repositories again</button>
            {repos.length > 0 && <button type="button" className="btn primary" disabled={!liveReady} title={!liveReady ? (!githubReady ? "Open triage is unavailable until GitHub webhook delivery is verified." : "Inference not observed yet.") : undefined} onClick={() => navigate("/triage/action")}>Open triage</button>}
          </div>
        </>}
      </section>
    </section>
    </div>
  </main></div>;
}
