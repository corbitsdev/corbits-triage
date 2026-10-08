import { useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ExternalLink } from "lucide-react";
import { enabledCheckCount, useCheckPacks, type PackState } from "../lib/check-packs.ts";
import { DeniedNotice } from "../lib/denied.tsx";
import { githubAppSlugFromCredentials, hasActiveGithubCredential } from "../lib/hub-api.ts";
import { githubAppPickerUrl, GITHUB_APP_PICKER_UNAVAILABLE } from "../lib/github-manifest.ts";
import { useGithubSync } from "../lib/github-sync.ts";
import { useOpenPulls, useQueueItems, useQueueLoading } from "../lib/open-pulls.ts";
import { usePortal } from "../lib/portal.tsx";
import { repoRows, type RepoHealth, type RepoRow } from "../lib/repo-rows.ts";
import { useRunLogs } from "../lib/run-logs.ts";
import { useRuns } from "../lib/tenant-entities.ts";
import { relativeTime } from "../lib/triage-view.ts";

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function listed(words: string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

function checksLabel(row: RepoRow, state: PackState | undefined): string {
  if (row.needsSetup) return "Not set up";
  if (!state || state.pending) return "";
  if (state.error) return "Could not read";
  return state.pack ? `${plural(enabledCheckCount(state.pack), "check")} on` : "Not set up";
}

function ownersLabel(owners: string[]): string {
  if (owners.length === 0) return "No owner";
  return owners.length === 1 ? owners[0]! : `${owners[0]} · ${owners.length - 1} more`;
}

/** A plain primary click; modified clicks and clicks that end a text selection keep their browser meaning. */
function isPlainClick(event: MouseEvent): boolean {
  if (event.defaultPrevented || event.button !== 0) return false;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  return window.getSelection()?.type !== "Range";
}

function HealthMark({ health }: { health: RepoHealth }) {
  const mark = health.tone === "ok"
    ? <span className="dot ready" />
    : health.tone === "warn" ? <span className="mk flag">!</span> : <span className="dot hollow" />;
  return <span className={`hl ${health.tone}`}>{mark}{health.label}</span>;
}

export default function Repositories() {
  const { snapshot, readOnly } = usePortal();
  const { logs } = useRunLogs();
  const runs = useRuns();
  const navigate = useNavigate();
  const repos = snapshot?.repos ?? [];
  const denied = snapshot?.denied.repos ?? false;
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState("");
  const items = useQueueItems();
  const loading = useQueueLoading();
  const { data: openPulls } = useOpenPulls();
  const packed = useMemo(() => repos.filter((repo) => repo.checkPack).map((repo) => repo.name), [repos]);
  const packs = useCheckPacks(packed);
  const rows = repoRows(repos, items, logs, runs.rows, openPulls);
  const accounts = [...new Set(repos.map((repo) => repo.name.split("/")[0]!))];

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

  /** Cells read from run logs and open pull requests stay blank until those have loaded once. */
  function live(value: ReactNode): ReactNode {
    return loading ? null : value;
  }

  function renderRow(row: RepoRow) {
    function openRow(event: MouseEvent<HTMLTableRowElement>) {
      if (isPlainClick(event)) navigate(row.href);
    }
    return (
      <tr key={row.name} onClick={openRow}>
        <td className="c-name"><Link to={row.href}><b title={row.name}>{row.name}</b></Link></td>
        <td className="c-n mono">{live(row.open)}</td>
        <td className="c-n mono">{live(row.needsYou)}</td>
        <td className="c-post">{row.posting}</td>
        <td className="c-checks">{checksLabel(row, packs.get(row.name))}</td>
        <td className="c-own" title={row.owners.join(", ")}>{live(ownersLabel(row.owners))}</td>
        <td className="c-act">{live(row.lastActivity === undefined ? null : row.lastActivity ? relativeTime(row.lastActivity) : "None")}</td>
        <td className="c-health">{row.health.tone === "warn" ? <HealthMark health={row.health} /> : live(<HealthMark health={row.health} />)}</td>
      </tr>
    );
  }

  return (
    <div className="repos">
      <section className="panel rl" aria-label="Repositories">
        <div className="lh">
          <div className="lh-top">
            <h1>Repositories</h1>
            {snapshot && <span className="n">{repos.length}</span>}
            <span className="sp" />
            <button type="button" className="btn btn-sm" disabled={readOnly || denied || opening || !snapshot} onClick={() => void manageOnGithub()}>
              {opening ? "Opening GitHub…" : "Manage repositories on GitHub"}
              <ExternalLink size={13} strokeWidth={1.6} aria-hidden="true" />
            </button>
          </div>
        </div>
        <main id="main" className="scroll">
          {denied && <DeniedNotice section="repositories" />}
          {error && <p role="alert" className="rt-note error">{error}</p>}
          {sync.error && <p role="alert" className="rt-note error">Could not read your repositories from GitHub. {sync.error.message}</p>}
          {sync.isFetching && repos.length === 0 && <p className="rt-empty" role="status">Reading your repositories from GitHub…</p>}
          {repos.length === 0 && !denied && !sync.isFetching && <p className="rt-empty">No repositories yet. Use Manage repositories on GitHub to add some.</p>}
          {rows.length > 0 && (
            <>
              <table className="rt">
                <thead>
                  <tr>
                    <th className="c-name">Repository</th>
                    <th className="c-n">Open</th>
                    <th className="c-n">Needs you</th>
                    <th className="c-post">Posting</th>
                    <th className="c-checks">Checks</th>
                    <th className="c-own">Owners</th>
                    <th className="c-act">Last activity</th>
                    <th className="c-health">Health</th>
                  </tr>
                </thead>
                <tbody>{rows.map(renderRow)}</tbody>
              </table>
              <p className="rt-note">Triage sees the repositories its GitHub app is installed on, in {listed(accounts)}. Open one to change its posting and checks.</p>
            </>
          )}
        </main>
      </section>
    </div>
  );
}
