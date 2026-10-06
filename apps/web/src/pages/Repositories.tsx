import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { hasVerifiedWebhookDelivery } from "../lib/connect-view.ts";
import { DeniedNotice } from "../lib/denied.tsx";
import { backlogSyncFromConfig, githubAppInstallUrl, githubAppSlugFromCredentials, hasActiveGithubCredential, projectQueue, type RepoRecord } from "../lib/hub-api.ts";
import { isRepoCatchingUp } from "../lib/backlog-status.ts";
import { githubAppPickerUrl, GITHUB_APP_PICKER_UNAVAILABLE, openGithubInstallation } from "../lib/github-manifest.ts";
import { useGithubReturnSync } from "../lib/github-return-sync.ts";
import { repoNeedsCheckSetup } from "../lib/check-pack.ts";
import { usePortal } from "../lib/portal.tsx";

export default function Repositories() {
  const { snapshot, refreshNow, runBacklog, readOnly } = usePortal();
  const repos = snapshot?.repos ?? [];
  const denied = snapshot?.denied.repos ?? false;
  const [pending, setPending] = useState<"refresh" | "add" | "retry" | null>(null);
  const [error, setError] = useState("");
  const backlogSync = useMemo(() => backlogSyncFromConfig(snapshot?.config), [snapshot?.config]);
  const retryableBacklog = repos.filter((repo) => backlogSync[repo.name]?.status === "failed");
  const items = snapshot ? projectQueue(snapshot) : [];

  async function observe() {
    setPending("refresh");
    setError("");
    try {
      await refreshNow();
    } catch (cause) {
      setError(`Could not refresh repositories. ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setPending(null);
    }
  }

  const { arm } = useGithubReturnSync(() => { void observe(); });

  async function addRepositories() {
    if (!snapshot) return;
    setPending("add");
    setError("");
    try {
      const url = githubAppPickerUrl(githubAppSlugFromCredentials(snapshot.credentials));
      if (!url) {
        setError(hasActiveGithubCredential(snapshot.credentials)
          ? GITHUB_APP_PICKER_UNAVAILABLE
          : "Save the GitHub App ID and private key first, then add repositories.");
        return;
      }
      if (!openGithubInstallation(url)) {
        setError("Your browser blocked the GitHub window. Allow popups for this page, then try again.");
        return;
      }
      arm();
    } catch (cause) {
      setError(`Could not open GitHub. ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setPending(null);
    }
  }

  async function retryFailed() {
    setPending("retry");
    setError("");
    try {
      for (const repo of retryableBacklog) {
        await runBacklog(repo.name);
      }
    } catch (cause) {
      setError(`Could not retry backlog. ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setPending(null);
    }
  }

  const busy = pending !== null;
  const storedSlug = githubAppSlugFromCredentials(snapshot?.credentials ?? []);
  const installUrl = storedSlug ? githubAppInstallUrl(storedSlug) : null;
  const pendingSetup = repos.filter((repo) => repoNeedsCheckSetup(repo)).length;

  function renderRepoCard(repo: RepoRecord) {
    const needsSetup = repoNeedsCheckSetup(repo);
    const to = `/repositories/${encodeURIComponent(repo.name)}${needsSetup ? "/setup" : ""}`;
    const receivingEvents = hasVerifiedWebhookDelivery(snapshot?.logs ?? [], repo.name);
    const backlog = backlogSync[repo.name];
    const catchingUp = snapshot ? isRepoCatchingUp(snapshot, repo.name) : false;
    const failed = backlog?.status === "failed";
    const status = needsSetup ? "Needs setup" : failed ? "Backlog failed" : catchingUp ? "Catching up open pull requests" : receivingEvents ? "Receiving events" : "Needs setup";
    const open = items.filter((item) => item.repo === repo.name);
    const needs = open.filter((item) => item.needsHuman).length;
    const prLine = open.length === 0 ? "No open pull requests" : open.length === 1 ? "1 open" : `${open.length} open`;
    const needsLine = needs === 0 ? "None need action" : needs === 1 ? "1 needs action" : `${needs} need action`;
    const mode = repo.cleanupMode === "automated" ? "Automated" : "Human approved";
    return (
      <Link key={repo.name} className="repo-card" to={to}>
        <h2 className="mono">{repo.name}</h2>
        <span className={`status${needsSetup || failed ? " needs-setup" : catchingUp ? " catching" : ""}`}><i />{status}</span>
        {needsSetup
          ? <p className="small muted"><span className="repo-needs">Set up checks</span> · not classifying yet</p>
          : <p className="small muted">{prLine} · <span className={needs ? "repo-needs" : ""}>{needsLine}</span> · {mode}</p>}
      </Link>
    );
  }

  return (
    <div className="main-shell">
      <div className="workspace">
        <header className="workspace-head">
          <div className="page-heading">
            <div>
              <h1>Repositories</h1>
              <p className="lede">
                {pendingSetup === 0
                  ? "Places you installed the GitHub App. Choose repositories on GitHub, then come back here for check setup."
                  : `${pendingSetup === 1 ? "1 repository needs" : `${pendingSetup} repositories need`} check setup before triage classifies pull requests.`}
              </p>
            </div>
            <button type="button" className="btn primary" disabled={readOnly || denied || busy || !snapshot} onClick={() => void addRepositories()}>
              {pending === "add" ? "Opening GitHub…" : "Choose repositories on GitHub"}
            </button>
          </div>
        </header>
        <main id="main" className="scroller">
          <div className="content-wide">
            {denied && <DeniedNotice section="repositories" />}
            {error && <p role="alert" className="error">{error}</p>}
            {retryableBacklog.length > 0 && (
              <div role="alert" className="error">
                <p>Could not scan {retryableBacklog.length} repositor{retryableBacklog.length === 1 ? "y" : "ies"}. Retry the failed scans.</p>
                {retryableBacklog.map((repo) => <p key={repo.name}><span className="mono">{repo.name}</span>: {backlogSync[repo.name]?.error ?? "Scan not started."}</p>)}
                <button type="button" className="btn" disabled={readOnly || denied || busy} onClick={() => void retryFailed()}>Retry failed backlog</button>
              </div>
            )}
            <p className="field-help">GitHub’s installer. New repos come back here for check setup.</p>
            <div className="row wrap">
              <button type="button" className="btn" disabled={readOnly || denied || busy} onClick={() => void observe()}>{pending === "refresh" ? "Refreshing…" : "Refresh"}</button>
              {installUrl && <a className="btn" href={installUrl} target="_blank" rel="noreferrer">Install App on another account</a>}
            </div>
            {repos.length === 0 && !denied && <div className="empty">No repositories selected. Choose repositories on GitHub, then Refresh.</div>}
            <div className="repo-grid">
              {repos.map(renderRepoCard)}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
