import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { Button } from "@corbits/react-ui";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ExternalLink } from "lucide-react";
import { counted, errorText } from "@corbits/common";
import HealthMark from "../components/repo-panel/HealthMark.tsx";
import RepoPanel from "../components/repo-panel/RepoPanel.tsx";
import { catchingUpRepos } from "../lib/backlog-status.ts";
import { useBitbucketDatacenterRepositories, useRepositories } from "../lib/bitbucket-datacenter.ts";
import { enabledCheckCount, useCheckPacks, type PackState } from "../lib/check-packs.ts";
import { DeniedNotice } from "../lib/denied.tsx";
import { githubAppSlugFromCredentials, hasActiveGithubCredential } from "../lib/hub-api.ts";
import { githubAppPickerUrl, GITHUB_APP_PICKER_UNAVAILABLE } from "../lib/github-manifest.ts";
import { useGithubSync } from "../lib/github-sync.ts";
import { awaitingText } from "../lib/inbox-view.ts";
import { useOpenPulls, useQueueItems, useQueueLoading } from "../lib/open-pulls.ts";
import { rowFor, upgradeLabel, usePolicyUpgrades } from "../lib/policy-upgrades.ts";
import { usePortal } from "../lib/portal.tsx";
import { hostName } from "../lib/pull-link.ts";
import { createHubTransport } from "../lib/hub-transport.ts";
import { repoKey } from "../lib/repo-id.ts";
import { findRepo, hostedRepos, repoRows, selectedRepo, type RepoRow } from "../lib/repo-rows.ts";
import { useTriageVerdicts } from "../lib/triage-verdicts.ts";
import { relativeTime } from "../lib/triage-view.ts";

function listed(words: string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

function sourcesNote(accounts: string[], fromBitbucket: boolean): string {
  const seen: string[] = [];
  if (accounts.length > 0) seen.push(`the repositories its GitHub app is installed on, in ${listed(accounts)}`);
  if (fromBitbucket) seen.push("the Bitbucket Data Center repositories its token can see");
  return `Triage sees ${seen.join(", and ")}.`;
}

function checksLabel(state: PackState | undefined): string {
  if (!state || state.pending) return "";
  if (state.error) return "Could not read";
  if (state.found?.kind === "invalid") return "Policy file refused";
  return state.found ? `${counted(enabledCheckCount(state.found.pack), "rule", "rules")} on` : "Not set up";
}

function ownersLabel(owners: string[]): string {
  if (owners.length === 0) return "None";
  return owners.length === 1 ? owners[0]! : `${owners[0]} · ${owners.length - 1} more`;
}

function isPlainClick(event: MouseEvent): boolean {
  if (event.defaultPrevented || event.button !== 0) return false;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  return window.getSelection()?.type !== "Range";
}

export default function Repositories() {
  const { snapshot, readOnly } = usePortal();
  const tenantId = snapshot?.workspace.tenantId;
  const stats = useMemo(function statsReader() {
    return tenantId ? { tenantId, transport: createHubTransport() } : null;
  }, [tenantId]);
  const verdicts = useTriageVerdicts();
  const navigate = useNavigate();
  const params = useParams();
  const [search] = useSearchParams();
  const selection = selectedRepo(params, search);
  const { repos, pending: reposPending } = useRepositories();
  const bitbucket = useBitbucketDatacenterRepositories();
  const denied = snapshot?.denied.repos ?? false;
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState("");
  const items = useQueueItems();
  const loading = useQueueLoading();
  const { data: openPulls, error: pullsError } = useOpenPulls();
  const packs = useCheckPacks(repos);
  const upgrades = usePolicyUpgrades();
  const triaged = useMemo(() => hostedRepos(verdicts.data?.triaged ?? []), [verdicts.data]);
  const active = useMemo(() => hostedRepos(verdicts.data?.active ?? []), [verdicts.data]);
  const catchingUp = useMemo(() => catchingUpRepos(verdicts.data?.pulls ?? [], triaged), [verdicts.data, triaged]);
  const rows = useMemo(
    () => repoRows(repos, packs, items, active, catchingUp, openPulls, pullsError),
    [repos, packs, items, active, catchingUp, openPulls, pullsError],
  );
  const accounts = [...new Set(repos.filter((repo) => repo.source === "github").map((repo) => repo.name.split("/")[0]!))];
  const fromBitbucket = repos.some((repo) => repo.source === "bitbucket-datacenter");
  const selectedConfig = findRepo(repos, selection.repo);
  const selectedRow = findRepo(rows, selection.repo);
  const lastOpen = useRef<string | null>(null);

  const closePanel = useCallback(function closePanel() {
    navigate("/repositories");
  }, [navigate]);

  useEffect(function returnFocusToRow() {
    const closed = lastOpen.current;
    lastOpen.current = selectedRow ? selectedRow.href : null;
    if (closed && !selectedRow) document.querySelector<HTMLElement>(`[data-repo-link="${CSS.escape(closed)}"]`)?.focus();
  }, [selectedRow]);

  const githubConnected = Boolean(snapshot && hasActiveGithubCredential(snapshot.credentials));
  const sync = useGithubSync(githubConnected);

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
      setError(`Could not open GitHub. ${errorText(cause)}`);
    } finally {
      setOpening(false);
    }
  }

  /** Cells read from run logs and open pull requests stay blank until those have loaded once. */
  function live(value: ReactNode): ReactNode {
    return loading ? null : value;
  }

  /** A repository that still needs a policy file, or whose policy pull request waits for merge, says so in place of its usual health, which stays blank until its policy is read. */
  function healthOf(row: RepoRow): ReactNode {
    const found = rowFor(upgrades, row);
    const label = found && upgradeLabel(found);
    if (found?.pull && !found.pullUnread) return <span className="hl wait"><span className="dot" />{label}</span>;
    if (label) return <HealthMark health={{ tone: "warn", label }} />;
    if (packs.get(repoKey(row))?.pending) return null;
    return row.health.tone === "warn" ? <HealthMark health={row.health} /> : live(<HealthMark health={row.health} />);
  }

  function renderRow(row: RepoRow) {
    function openRow(event: MouseEvent<HTMLTableRowElement>) {
      if (isPlainClick(event)) navigate(row.href);
    }
    const pulls = "error" in row.pulls ? null : row.pulls;
    const open = row === selectedRow;
    return (
      <tr key={row.href} className={open ? "on" : undefined} onClick={openRow}>
        <td className="c-name">
          <Link to={row.href} data-repo-link={row.href} aria-current={open ? "true" : undefined}><b title={row.name}>{row.name}</b></Link>
          {row.source === "bitbucket-datacenter" && <small className="src">Bitbucket Data Center</small>}
          {pulls && pulls.awaiting > 0 && live(<small>{awaitingText(pulls.awaiting)}</small>)}
        </td>
        <td className="c-n mono">{pulls && live(pulls.open)}</td>
        <td className="c-n mono">{"error" in row.pulls ? <span title={row.pulls.error}>{hostName(row.source)} error</span> : live(row.pulls.needsYou)}</td>
        <td className="c-checks">{checksLabel(packs.get(repoKey(row)))}</td>
        <td className="c-own" title={pulls?.owners.join(", ")}>{pulls && live(ownersLabel(pulls.owners))}</td>
        <td className="c-act">{pulls && live(pulls.lastActivity ? relativeTime(pulls.lastActivity) : "None")}</td>
        <td className="c-health">{healthOf(row)}</td>
      </tr>
    );
  }

  if (selection.redirect) return <Navigate to={selection.redirect} replace />;
  if (selection.repo && snapshot && !reposPending && !selectedConfig && !denied) return <Navigate to="/repositories" replace />;

  return (
    <div className={`repos${selectedConfig && selectedRow ? " split" : ""}`}>
      <section className="panel rl" aria-label="Repositories">
        <div className="lh">
          <div className="lh-top">
            <h1>Repositories</h1>
            {snapshot && <span className="n">{repos.length}</span>}
            <span className="sp" />
            {githubConnected && (
              <Button type="button" variant="outline" size="sm" disabled={readOnly || denied || opening || !snapshot} onClick={() => void manageOnGithub()}>
                {opening ? "Opening GitHub…" : "Manage repositories on GitHub"}
                <ExternalLink size={13} strokeWidth={1.6} aria-hidden="true" />
              </Button>
            )}
          </div>
        </div>
        <main id="main" className="scroll">
          {denied && <DeniedNotice section="repositories" />}
          {error && <p role="alert" className="rt-note error">{error}</p>}
          {sync.error && <p role="alert" className="rt-note error">Could not read your repositories from GitHub. {sync.error.message}</p>}
          {bitbucket.error && <p role="alert" className="rt-note error">Could not read your repositories from Bitbucket Data Center. {bitbucket.error.message}</p>}
          {verdicts.error && <p role="alert" className="rt-note error">Could not read triage results. {verdicts.error.message}</p>}
          {sync.isFetching && repos.length === 0 && <p className="rt-empty" role="status">Reading your repositories from GitHub…</p>}
          {repos.length === 0 && !denied && !sync.isFetching && !reposPending && <p className="rt-empty">{githubConnected ? "No repositories yet. Use Manage repositories on GitHub to add some." : <>No repositories yet. <Link to="/settings/triage">Connect a source in Settings.</Link></>}</p>}
          {rows.length > 0 && (
            <>
              <table className="rt">
                <thead>
                  <tr>
                    <th className="c-name">Repository</th>
                    <th className="c-n">Open</th>
                    <th className="c-n">Needs you</th>
                    <th className="c-checks">Rules</th>
                    <th className="c-own">Owners</th>
                    <th className="c-act">Last activity</th>
                    <th className="c-health">Health</th>
                  </tr>
                </thead>
                <tbody>{rows.map(renderRow)}</tbody>
              </table>
              <p className="rt-note">{sourcesNote(accounts, fromBitbucket)} Open one to change its triage and rules.</p>
            </>
          )}
        </main>
      </section>
      {selectedConfig && selectedRow ? <RepoPanel key={selectedRow.href} repo={selectedConfig} row={selectedRow} live={!loading && !packs.get(repoKey(selectedRow))?.pending} stats={stats} onClose={closePanel} /> : null}
    </div>
  );
}
