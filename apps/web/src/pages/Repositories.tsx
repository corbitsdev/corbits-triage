import { useState } from "react";
import { Link } from "react-router-dom";
import { repoPolicy } from "@corbits/triage-contracts";
import { hasVerifiedWebhookDelivery } from "../lib/connect-view.ts";
import { DeniedNotice } from "../lib/denied.tsx";
import { githubAppSlugFromCredentials, hasActiveGithubCredential, type RepoRecord } from "../lib/hub-api.ts";
import { isRepoCatchingUp } from "../lib/backlog-status.ts";
import { githubAppPickerUrl, GITHUB_APP_PICKER_UNAVAILABLE } from "../lib/github-manifest.ts";
import { repoNeedsCheckSetup } from "../lib/check-pack.ts";
import { useGithubSync } from "../lib/github-sync.ts";
import { useQueueItems } from "../lib/open-pulls.ts";
import { usePortal } from "../lib/portal.tsx";

export default function Repositories() {
  const { snapshot, readOnly } = usePortal();
  const repos = snapshot?.repos ?? [];
  const denied = snapshot?.denied.repos ?? false;
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState("");
  const items = useQueueItems();

  const sync = useGithubSync(Boolean(snapshot && hasActiveGithubCredential(snapshot.credentials)));

  /** GitHub's Setup URL brings the browser back here after the change. */
  async function manageOnGithub() {
    if (!snapshot) return;
    setOpening(true);
    setError("");
    try {
      const url = githubAppPickerUrl(githubAppSlugFromCredentials(snapshot.credentials));
      if (!url) {
        setError(hasActiveGithubCredential(snapshot.credentials)
          ? GITHUB_APP_PICKER_UNAVAILABLE
          : "Save the GitHub App ID and private key first, then add repositories.");
        return;
      }
      window.location.assign(url);
    } catch (cause) {
      setError(`Could not open GitHub. ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setOpening(false);
    }
  }

  const pendingSetup = repos.filter((repo) => repoNeedsCheckSetup(repo)).length;

  function renderRepoCard(repo: RepoRecord) {
    const needsSetup = repoNeedsCheckSetup(repo);
    const to = `/repositories/${encodeURIComponent(repo.name)}${needsSetup ? "/setup" : ""}`;
    const receivingEvents = hasVerifiedWebhookDelivery(snapshot?.logs ?? [], repo.name);
    const catchingUp = snapshot ? isRepoCatchingUp(snapshot, repo.name) : false;
    const disabled = !needsSetup && !repoPolicy(repo).enabled;
    const status = needsSetup ? "Needs setup" : disabled ? "Disabled" : catchingUp ? "Catching up open pull requests" : receivingEvents ? "Receiving events" : "Ready";
    const open = items.filter((item) => item.repo === repo.name);
    const needs = open.filter((item) => item.needsHuman).length;
    const prLine = open.length === 0 ? "No open pull requests" : open.length === 1 ? "1 open" : `${open.length} open`;
    const needsLine = needs === 0 ? "None need action" : needs === 1 ? "1 needs action" : `${needs} need action`;
    const mode = repo.cleanupMode === "automated" ? "Automated" : "Human approved";
    return (
      <Link key={repo.name} className="repo-card" to={to}>
        <h2 className="mono">{repo.name}</h2>
        <span className={`status${needsSetup || disabled ? " needs-setup" : catchingUp ? " catching" : ""}`}><i />{status}</span>
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
                  ? "Repositories the GitHub App can see. Open one to change its checks."
                  : `${pendingSetup === 1 ? "1 repository needs" : `${pendingSetup} repositories need`} check setup before triage classifies pull requests.`}
              </p>
            </div>
            <button type="button" className="btn primary" disabled={readOnly || denied || opening || !snapshot} onClick={() => void manageOnGithub()}>
              {opening ? "Opening GitHub…" : "Manage repositories on GitHub"}
            </button>
          </div>
        </header>
        <main id="main" className="scroller">
          <div className="content-wide">
            {denied && <DeniedNotice section="repositories" />}
            {error && <p role="alert" className="error">{error}</p>}
            {sync.error && <p role="alert" className="error">Could not read your repositories from GitHub. {sync.error.message}</p>}
            {sync.isFetching && repos.length === 0 && <p className="field-help" role="status">Reading your repositories from GitHub…</p>}
            {repos.length === 0 && !denied && !sync.isFetching && <div className="empty">No repositories yet. Use Manage repositories on GitHub to add some.</div>}
            <div className="repo-grid">
              {repos.map(renderRepoCard)}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
