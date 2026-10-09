import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { emptyPack, recommendedPack, repoPolicy } from "@corbits/triage-contracts";
import { isRepoCatchingUp } from "../lib/backlog-status.ts";
import {
  CHECK_CATALOG,
  CHECK_GROUPS,
  checkPackFromDraft,
  draftFromCheckPack,
  emptyDraft,
  packJson,
  type CatalogCheck,
  type DraftCheck,
  type DraftPack,
} from "../lib/check-catalog.ts";
import { alreadyWritten, linkCheckPack, repoNeedsCheckSetup, StaleCheckPackError, writeCheckPack, type LoadedCheckPack } from "../lib/check-pack.ts";
import { CHECK_PACK_INDEX_QUERY_KEY, checkPackQuery } from "../lib/check-packs.ts";
import { hasVerifiedWebhookDelivery } from "../lib/connect-view.ts";
import { DeniedNotice } from "../lib/denied.tsx";
import { githubAppSlugFromCredentials, hasActiveGithubCredential, type StoredCheckPack } from "../lib/hub-api.ts";
import { githubAppPickerUrl, GITHUB_APP_PICKER_UNAVAILABLE, openGithubInstallation } from "../lib/github-manifest.ts";
import { useGithubReturnSync } from "../lib/github-return-sync.ts";
import { createHubTransport } from "../lib/hub-transport.ts";
import { useQueueItems } from "../lib/open-pulls.ts";
import { usePortal, useSignOutWhenRejected } from "../lib/portal.tsx";
import { repoHealth } from "../lib/repo-rows.ts";
import { useRunLogs } from "../lib/run-logs.ts";
import { useRuns } from "../lib/tenant-entities.ts";

function ownerAndName(raw: string): { owner: string; name: string } | null {
  let value = raw;
  if (value.includes("%")) {
    try {
      value = decodeURIComponent(value);
    } catch {
      return null;
    }
  }
  const slash = value.indexOf("/");
  if (slash <= 0 || slash !== value.lastIndexOf("/") || slash === value.length - 1) return null;
  return { owner: value.slice(0, slash), name: value.slice(slash + 1) };
}

function defaultValues(spec: CatalogCheck): Record<string, string | number | string[]> {
  if (!spec.valueKey) return {};
  return { [spec.valueKey]: spec.defaultValue ?? "" };
}

function repoPath(label: string, setup = false): string {
  return `/repositories/${encodeURIComponent(label)}${setup ? "/setup" : ""}`;
}

function CheckControl({ spec, row, onChange }: { spec: CatalogCheck; row: DraftCheck; onChange: (values: DraftCheck["values"]) => void }) {
  const on = row.enabled;
  if (spec.param === "number") {
    const key = spec.valueKey ?? "value";
    return (
      <div className="check-value">
        <input type="number" min={spec.min ?? 0} step={1} disabled={!on} value={Number(row.values[key] ?? spec.defaultValue ?? 0)} onChange={(event) => onChange({ ...row.values, [key]: Number(event.target.value) })} />
        {spec.suffix ? <span className="check-suffix">{spec.suffix}</span> : null}
      </div>
    );
  }
  if (spec.param === "select") {
    const key = spec.valueKey ?? "value";
    return (
      <div className="check-value">
        <select disabled={!on} value={String(row.values[key] ?? spec.defaultValue ?? "")} onChange={(event) => onChange({ ...row.values, [key]: event.target.value })}>
          {(spec.options ?? []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </div>
    );
  }
  if (spec.param === "text") {
    const key = spec.valueKey ?? "value";
    return (
      <div className="check-value">
        <input type="text" disabled={!on} value={String(row.values[key] ?? "")} onChange={(event) => onChange({ ...row.values, [key]: event.target.value })} />
      </div>
    );
  }
  if (spec.param === "globs") {
    const key = spec.valueKey ?? "globs";
    const text = Array.isArray(row.values[key]) ? (row.values[key] as string[]).join("\n") : String(row.values[key] ?? "");
    return (
      <div className="check-globs">
        <textarea disabled={!on} value={text} onChange={(event) => onChange({ ...row.values, [key]: event.target.value.split("\n").map((line) => line.trim()).filter(Boolean) })} />
      </div>
    );
  }
  return null;
}

export default function RepoDetail() {
  const params = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { snapshot, refreshNow, syncFromGithub, runBacklog, saveRepoPolicy, notify, readOnly } = usePortal();
  const signOutWhenRejected = useSignOutWhenRejected();
  const fromId = params.id ? ownerAndName(params.id) : null;
  const setupTab = params.tab === "setup";
  const paired = !fromId && params.id && params.tab && params.tab !== "setup"
    ? { owner: params.id, name: params.tab }
    : null;
  const owner = fromId?.owner ?? paired?.owner ?? "";
  const name = fromId?.name ?? paired?.name ?? "";
  const label = fromId || paired ? `${owner}/${name}` : params.id ?? "";
  const config = snapshot?.repos.find((row) => row.name === label || row.name === name || row.name === params.id);
  const initial = repoPolicy(config);
  const [pack, setPack] = useState<DraftPack>(() => emptyDraft(label, initial.cleanupMode));
  const [saved, setSaved] = useState<DraftPack>(() => emptyDraft(label, initial.cleanupMode));
  const [picker, setPicker] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [customName, setCustomName] = useState("");
  const [customGroup, setCustomGroup] = useState<(typeof CHECK_GROUPS)[number]["id"]>("pr");
  const [customInstruction, setCustomInstruction] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [loadingPack, setLoadingPack] = useState(true);
  const [loaded, setLoaded] = useState<LoadedCheckPack | null>(null);
  /** The newest artifact for the repository is not a check pack; the setup choices replace it in place. */
  const [corrupt, setCorrupt] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [staleSave, setStaleSave] = useState(false);
  /** A pack written to the hub whose config link failed; saving it again only redoes the link. */
  const [unlinked, setUnlinked] = useState<StoredCheckPack | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [needsSetup, setNeedsSetup] = useState(() => repoNeedsCheckSetup(config));
  const [customizing, setCustomizing] = useState(false);
  const deniedRepos = snapshot?.denied.repos ?? false;
  const items = useQueueItems().filter((item) => item.repo === (config?.name ?? label));
  const needs = items.filter((item) => item.needsHuman).length;
  const ready = items.filter((item) => item.state === "ready").length;
  const { logs } = useRunLogs();
  const runs = useRuns();
  const receivingEvents = config ? hasVerifiedWebhookDelivery(logs, config.name) : false;
  const catchingUp = isRepoCatchingUp(logs, runs.rows, config?.name ?? label);
  const dirty = packJson(pack) !== packJson(saved) || (needsSetup && customizing) || unlinked !== null;
  async function syncAfterGithub() {
    try {
      await syncFromGithub();
    } catch (cause) {
      setError(`Could not read your repositories from GitHub. ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  const { arm } = useGithubReturnSync(() => { void syncAfterGithub(); });
  const tenantId = snapshot?.workspace.tenantId;
  const repoName = config?.name;

  useEffect(function loadPack() {
    let cancelled = false;
    setLoadingPack(true);
    setLoadFailed(false);
    setError("");
    setStaleSave(false);
    setUnlinked(null);
    setCorrupt(false);
    setCustomizing(false);
    setPicker(false);
    setCustomOpen(false);
    const mode = repoPolicy(config).cleanupMode;
    function startEmpty() {
      const next = emptyDraft(label, mode);
      setPack(next);
      setSaved(next);
      setNeedsSetup(true);
      setLoaded(null);
    }
    if (!snapshot || !tenantId || !repoName) {
      startEmpty();
      setLoadingPack(false);
      return;
    }
    async function run(id: string, repo: string) {
      try {
        const query = checkPackQuery(queryClient, id, repo);
        if (attempt > 0) {
          // Retry and Reload read past the cache, which may predate the change that made them necessary.
          await queryClient.invalidateQueries({ queryKey: [CHECK_PACK_INDEX_QUERY_KEY, id] });
          await queryClient.invalidateQueries({ queryKey: query.queryKey });
        }
        const found = await queryClient.fetchQuery(query);
        if (cancelled) return;
        if (found?.kind === "pack") {
          const draft = draftFromCheckPack(found.pack, mode);
          setPack(draft);
          setSaved(draft);
          setNeedsSetup(false);
          setLoaded({ id: found.id, version: found.version });
        } else {
          startEmpty();
          if (found) {
            setCorrupt(true);
            setLoaded({ id: found.id, version: found.version });
          }
        }
      } catch (cause) {
        if (cancelled) return;
        signOutWhenRejected(cause);
        setError(`Could not load the check pack. ${cause instanceof Error ? cause.message : String(cause)}`);
        setLoadFailed(true);
      } finally {
        if (!cancelled) setLoadingPack(false);
      }
    }
    void run(tenantId, repoName);
    return function cancel() {
      cancelled = true;
    };
  }, [repoName, tenantId, attempt]);

  const remaining = useMemo(function remainingChecks() {
    const have = new Set(pack.checks.map((row) => row.id));
    return CHECK_CATALOG.filter((spec) => !have.has(spec.id));
  }, [pack.checks]);

  function addCheck(spec: CatalogCheck) {
    setPack(function withCheck(current) {
      return { ...current, checks: [...current.checks, { id: spec.id, enabled: true, values: defaultValues(spec) }] };
    });
    setPicker(false);
  }

  function addCustom() {
    const instruction = customInstruction.trim();
    const customNameTrimmed = customName.trim();
    if (!customNameTrimmed || !instruction) return;
    setPack(function withCustom(current) {
      return {
        ...current,
        custom: [...current.custom, {
          id: `custom-${current.custom.length + 1}`,
          enabled: true,
          custom: true,
          name: customNameTrimmed,
          group: customGroup,
          instruction,
          values: { instruction },
        }],
      };
    });
    setCustomName("");
    setCustomInstruction("");
    setCustomOpen(false);
    setPicker(false);
  }

  function submitCustom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    addCustom();
  }

  function toggleCheck(id: string, enabled: boolean) {
    setPack(function withEnabled(current) {
      return {
        ...current,
        checks: current.checks.map((item) => item.id === id ? { ...item, enabled } : item),
        custom: current.custom.map((item) => item.id === id ? { ...item, enabled } : item),
      };
    });
  }

  function setCheckValues(id: string, values: DraftCheck["values"]) {
    setPack(function withValues(current) {
      return { ...current, checks: current.checks.map((item) => item.id === id ? { ...item, values } : item) };
    });
  }

  function editInstruction(id: string, instruction: string) {
    setPack(function withInstruction(current) {
      return {
        ...current,
        custom: current.custom.map((item) => item.id === id ? { ...item, instruction, values: { instruction } } : item),
      };
    });
  }

  function removeCheck(id: string) {
    setPack(function withoutCheck(current) {
      return {
        ...current,
        checks: current.checks.filter((item) => item.id !== id),
        custom: current.custom.filter((item) => item.id !== id),
      };
    });
  }

  function closePicker() {
    setPicker(false);
    setCustomOpen(false);
  }

  async function chooseOnGithub() {
    if (!snapshot) return;
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
      } else {
        arm();
      }
    } catch (cause) {
      setError(`Could not open GitHub. ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  async function triageAgain() {
    if (!config) return;
    setError("");
    setStaleSave(false);
    try {
      await runBacklog(config.name, `Triaging ${items.length} open pull request${items.length === 1 ? "" : "s"}`);
    } catch (cause) {
      setError(`Could not triage again. ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  async function triageOpenPullRequests(repo: string) {
    try {
      await runBacklog(repo, "Triage enabled. Triaging open pull requests.");
    } catch (cause) {
      setError(`Triage enabled. Could not start triage of open pull requests. ${cause instanceof Error ? cause.message : String(cause)} Use Triage again.`);
    }
  }

  async function enableTriage() {
    if (!config) return;
    setToggling(true);
    setError("");
    setStaleSave(false);
    try {
      await saveRepoPolicy(config.name, { ...repoPolicy(config), enabled: true });
      await triageOpenPullRequests(config.name);
      await refreshNow();
    } catch (cause) {
      setError(`Could not enable triage. ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setToggling(false);
    }
  }

  async function disableTriage() {
    if (!config) return;
    setToggling(true);
    setError("");
    setStaleSave(false);
    try {
      await saveRepoPolicy(config.name, { ...repoPolicy(config), enabled: false });
      await refreshNow();
      notify("Triage disabled.");
    } catch (cause) {
      setError(`Could not disable triage. ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setToggling(false);
    }
  }

  async function setTriageDrafts(triageDrafts: boolean) {
    if (!config) return;
    setToggling(true);
    setError("");
    try {
      await saveRepoPolicy(config.name, { ...repoPolicy(config), triageDrafts });
      await refreshNow();
    } catch (cause) {
      setError(`Could not save the draft setting. ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setToggling(false);
    }
  }

  async function persist(artifact: ReturnType<typeof checkPackFromDraft>, draft: DraftPack, completingSetup: boolean) {
    if (!snapshot || !config) return;
    setSaving(true);
    setError("");
    setStaleSave(false);
    const transport = createHubTransport();
    const tenant = snapshot.workspace.tenantId;
    const nextDraft = draftFromCheckPack(artifact, draft.mode);
    let written: StoredCheckPack | null = null;
    try {
      written = alreadyWritten(unlinked, artifact);
      if (!written) {
        written = await writeCheckPack(transport, tenant, config.name, artifact, loaded);
        queryClient.setQueryData(checkPackQuery(queryClient, tenant, config.name).queryKey, written);
        setLoaded({ id: written.id, version: written.version });
        setCorrupt(false);
        setSaved(nextDraft);
        // The pack is live by title from here, so the setup screen gives way to the dashboard, where Save can redo the link.
        setNeedsSetup(false);
        setUnlinked(written);
      }
      await linkCheckPack(transport, tenant, config.name, draft.mode);
      written = null;
      setUnlinked(null);
      setPack(nextDraft);
      setSaved(nextDraft);
      setNeedsSetup(false);
      setCustomizing(false);
      if (completingSetup) navigate(repoPath(config.name));
    } catch (cause) {
      signOutWhenRejected(cause);
      if (written) {
        setError(`The check pack is saved and in effect, but it could not be linked to the repository. Save again to link it. ${cause instanceof Error ? cause.message : String(cause)}`);
      } else if (cause instanceof StaleCheckPackError) {
        setError(cause.message);
        setStaleSave(true);
      } else {
        setError(`Could not save configuration. ${cause instanceof Error ? cause.message : String(cause)} Check the values, then try again.`);
      }
      setSaving(false);
      return;
    }
    setSaving(false);
    await refreshAfterSave();
  }

  /** The save is done by now; a failed refresh is reported as such, not as a failed save. */
  async function refreshAfterSave() {
    try {
      await refreshNow();
    } catch (cause) {
      signOutWhenRejected(cause);
      setError(`Saved, but could not refresh the page. ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  async function save() {
    if (!config) return;
    try {
      const artifact = pack.checks.length === 0 && pack.custom.length === 0
        ? emptyPack(config.name)
        : checkPackFromDraft(pack);
      await persist(artifact, pack, needsSetup);
    } catch (cause) {
      setError(`Could not save configuration. ${cause instanceof Error ? cause.message : String(cause)} Check the values, then try again.`);
    }
  }

  async function useRecommended() {
    if (!config) return;
    const artifact = recommendedPack(config.name);
    const draft = draftFromCheckPack(artifact, "human-approved");
    await persist(artifact, draft, true);
  }

  function startCustomize() {
    setPack(emptyDraft(label, "human-approved"));
    setSaved(emptyDraft(label, "human-approved"));
    setCustomizing(true);
    setPicker(false);
    setCustomOpen(false);
  }

  function abandonCustomize() {
    setCustomizing(false);
    setPack(emptyDraft(label, "human-approved"));
    setSaved(emptyDraft(label, "human-approved"));
  }

  function cancelEdits() {
    if (needsSetup && customizing) {
      abandonCustomize();
      return;
    }
    setPack(saved);
  }

  if (!label) return <div className="empty">Unknown repository.</div>;
  if (loadFailed) {
    return (
      <div className="main-shell">
        <div className="topbar">
          <Link className="btn ghost" to="/repositories">Back</Link>
          <div className="topbar-id"><h1 className="mono">{label}</h1></div>
        </div>
        <main id="main" className="scroller">
          <div className="content-wide">
            <p role="alert" className="error">{error}</p>
            <div className="actions">
              <button type="button" className="btn" onClick={() => setAttempt((count) => count + 1)}>Retry</button>
            </div>
          </div>
        </main>
      </div>
    );
  }
  if (!loadingPack && config && needsSetup && !setupTab && !customizing) {
    return <Navigate to={repoPath(label, true)} replace />;
  }
  if (!loadingPack && config && !needsSetup && setupTab) {
    return <Navigate to={repoPath(label)} replace />;
  }

  const eventText = deniedRepos
    ? "Availability unknown."
    : !config
      ? "Repository not found."
      : repoHealth({ needsSetup, enabled: initial.enabled, catchingUp, receivingEvents }).label;

  function renderCheckRow({ row, spec }: { row: DraftCheck; spec: CatalogCheck | undefined }) {
    const tall = spec?.param === "globs" || row.custom;
    return (
      <div key={row.id} className={`check-row${row.enabled ? "" : " is-off"}${tall ? " has-globs" : ""}`}>
        <label className="check-enable">
          <span className="sr-only">Enable {spec?.name ?? row.name}</span>
          <input type="checkbox" checked={row.enabled} disabled={readOnly} onChange={(event) => toggleCheck(row.id, event.target.checked)} />
        </label>
        <div className="check-copy">
          <strong>{spec?.name ?? row.name}</strong>
          <span className="field-help">{spec?.help ?? "Triage includes this note when it classifies."}</span>
          <span className="check-kind">{row.custom ? "Custom" : spec?.kind === "quality" ? "Produces a score" : "GitHub data"}</span>
        </div>
        {spec && !tall ? <CheckControl spec={spec} row={row} onChange={(values) => setCheckValues(row.id, values)} /> : null}
        <button type="button" className="btn ghost check-remove" onClick={() => removeCheck(row.id)}>Remove</button>
        {spec && tall ? <CheckControl spec={spec} row={row} onChange={(values) => setCheckValues(row.id, values)} /> : null}
        {row.custom ? (
          <div className="check-globs">
            <textarea value={row.instruction ?? ""} onChange={(event) => editInstruction(row.id, event.target.value)} />
          </div>
        ) : null}
      </div>
    );
  }

  function renderCheckGroup(group: (typeof CHECK_GROUPS)[number]) {
    const rows = [
      ...pack.checks.map((row) => ({ row, spec: CHECK_CATALOG.find((item) => item.id === row.id) })),
      ...pack.custom.filter((row) => row.group === group.id).map((row) => ({ row, spec: undefined })),
    ].filter((entry) => (entry.spec ? entry.spec.group === group.id : entry.row.group === group.id));
    if (!rows.length) return null;
    return (
      <section className="check-catalog-group" key={group.id}>
        <h2>{group.label}</h2>
        <p className="field-help">{group.help}</p>
        {rows.map(renderCheckRow)}
      </section>
    );
  }

  const catalog = (
    <section aria-label="Active checks">
      <h2 className="repo-checks-title">{needsSetup ? "Checks" : "Active checks"}</h2>
      {pack.checks.length === 0 && pack.custom.length === 0 ? (
        <div className="check-empty">
          <p className="muted">No checks yet</p>
        </div>
      ) : CHECK_GROUPS.map(renderCheckGroup)}
      <div className="catalog-add">
        <div className="actions actions-end">
          <button type="button" className={`btn${pack.checks.length + pack.custom.length ? "" : " primary"}`} onClick={() => setPicker(true)}>Add check</button>
        </div>
        {picker && (
          <div className="check-picker" role="dialog" aria-label="Add check">
            <div className="check-picker-head">
              <h3>Add check</h3>
              <button type="button" className="btn ghost" onClick={closePicker}>Close</button>
            </div>
            <div className="picker-list">
              {remaining.length === 0 ? <p className="muted">Every shipped check is already added.</p> : remaining.map((spec) => (
                <div className="picker-row" key={spec.id}>
                  <div className="check-copy">
                    <strong>{spec.name}</strong>
                    <span className="field-help">{spec.help}</span>
                  </div>
                  <button type="button" className="btn" onClick={() => addCheck(spec)}>Add</button>
                </div>
              ))}
            </div>
            {customOpen ? (
              <form className="custom-check-form" onSubmit={submitCustom}>
                <label className="field">Name
                  <input value={customName} onChange={(event) => setCustomName(event.target.value)} required maxLength={80} />
                </label>
                <label className="field">Where it looks
                  <select value={customGroup} onChange={(event) => setCustomGroup(event.target.value as (typeof CHECK_GROUPS)[number]["id"])}>
                    {CHECK_GROUPS.map((group) => <option key={group.id} value={group.id}>{group.label}</option>)}
                  </select>
                </label>
                <label className="field">Instruction
                  <span className="field-help">Triage includes this note when it classifies.</span>
                  <textarea value={customInstruction} onChange={(event) => setCustomInstruction(event.target.value)} required />
                </label>
                <div className="actions actions-end">
                  <button type="button" className="btn" onClick={() => setCustomOpen(false)}>Cancel</button>
                  <button type="submit" className="btn primary">Add custom check</button>
                </div>
              </form>
            ) : (
              <div className="actions actions-end">
                <button type="button" className="btn" onClick={() => setCustomOpen(true)}>Add custom check</button>
              </div>
            )}
          </div>
        )}
      </div>
      <details className="artifact">
        <summary>Saved for this repository</summary>
        <p className="field-help">Triage reads this pack when it classifies pull requests.</p>
        <pre className="artifact-json">{packJson(pack)}</pre>
      </details>
    </section>
  );

  const setupChoice = (
    <section className="setup-rec" aria-label="Recommended checks">
      <h2>Recommended</h2>
      <ul className="setup-points">
        <li>PRs touch fewer than 40 files and fewer than 500 lines</li>
        <li>Draft, duplicate of an earlier open PR, merge conflicts, and required GitHub checks</li>
        <li>Linked issue in GitHub or Linear — not a single tracker</li>
        <li>One focused change and tests for behaviour produce a score</li>
        <li>Forbidden paths: <span className="mono">vendor/**</span>, <span className="mono">node_modules/**</span></li>
        <li>Posting starts as Human approved</li>
      </ul>
      <p className="field-help">You can add or change checks later on the repository dashboard. Customize starts with no checks.</p>
      <div className="setup-actions">
        <button type="button" className="btn" disabled={readOnly || saving || !config} onClick={startCustomize}>Customize</button>
        <button type="button" className="btn primary" disabled={readOnly || saving || !config} onClick={() => void useRecommended()}>{saving ? "Saving…" : "Use recommended"}</button>
      </div>
    </section>
  );

  return (
    <div className="main-shell">
      <div className="topbar">
        {needsSetup && customizing
          ? <button type="button" className="btn ghost" onClick={abandonCustomize}>Back</button>
          : <Link className="btn ghost" to="/repositories">Back</Link>}
        <div className="topbar-id"><h1 className="mono">{label}</h1></div>
      </div>
      <div className="workspace">
        <header className="workspace-head">
          <div className="page-heading">
            <div>
              <h1 className={needsSetup && !customizing ? undefined : "mono"}>{needsSetup && !customizing ? (corrupt ? "Replace checks" : "Set up checks") : label}</h1>
              <p className="lede">
                {needsSetup && !customizing
                  ? <>
                    <span className="mono">{label}</span> {corrupt ? "has a check pack that is unreadable; replace it." : "needs a check pack."} Use recommended adds the pack in one click. Customize starts with no checks. Saving checks does not start triage; Enable triage does.
                  </>
                  : needsSetup
                    ? "Add checks from the catalog, or start empty. Save writes the pack."
                    : "When to post, then the checks triage reads for this repository."}
              </p>
            </div>
          </div>
        </header>
        <main id="main" className={`scroller${dirty && (!needsSetup || customizing) ? " has-dirty" : ""}`}>
          <div className="content-wide">
            {deniedRepos && <DeniedNotice section="repositories" />}
            {error && <p role="alert" className="error">{error}</p>}
            {staleSave && (
              <div className="actions">
                <button type="button" className="btn" onClick={() => setAttempt((count) => count + 1)}>Reload</button>
                <span className="field-help">Reload discards your edits.</span>
              </div>
            )}
            {loadingPack ? <p className="muted" role="status">Loading…</p> : needsSetup && !customizing ? setupChoice : (
              <div className="repo-dash">
                <div className="repo-dash-main">
                  {!needsSetup && (
                    <section className="repo-posting" aria-label="When to post">
                      <h2>When to post</h2>
                      <div className="segmented" role="radiogroup" aria-label="When to post">
                        <button type="button" role="radio" aria-checked={pack.mode === "human-approved"} className={pack.mode === "human-approved" ? "active" : ""} disabled={readOnly} onClick={() => setPack({ ...pack, mode: "human-approved" })}>Human approved</button>
                        <button type="button" role="radio" aria-checked={pack.mode === "automated"} className={pack.mode === "automated" ? "active" : ""} disabled={readOnly} onClick={() => setPack({ ...pack, mode: "automated" })}>Automated</button>
                      </div>
                      <p className="field-help">Human approved posts only after a person confirms. Automated posts when confidence is at or above the floor.</p>
                    </section>
                  )}
                  {catalog}
                </div>
                {!needsSetup && (
                  <aside className="repo-dash-side">
                    <dl className="repo-stats">
                      <div className="repo-stat"><dt>Open pull requests</dt><dd>{items.length}</dd></div>
                      <div className={`repo-stat${needs ? " needs" : ""}`}><dt>Needs action</dt><dd>{needs}</dd></div>
                      <div className="repo-stat"><dt>Ready to merge</dt><dd>{ready}</dd></div>
                      <div className="repo-stat"><dt>Last event</dt><dd>{eventText}</dd></div>
                      <div className="repo-stat"><dt>Posting</dt><dd>{pack.mode === "automated" ? "Automated" : "Human approved"}</dd></div>
                      <div className="repo-stat"><dt>Triage</dt><dd>{initial.enabled ? "Enabled" : "Disabled"}</dd></div>
                    </dl>
                    {!initial.enabled && <p className="field-help">Nothing runs until triage is enabled.</p>}
                    <div className="repo-side-actions">
                      {!initial.enabled && <button type="button" className="btn primary" disabled={readOnly || deniedRepos || !config || toggling} onClick={() => void enableTriage()}>{toggling ? "Enabling…" : "Enable triage"}</button>}
                      <Link className={`btn${needs && initial.enabled ? " primary" : ""}`} to="/inbox">Open triage</Link>
                      {initial.enabled && <button type="button" className="btn" disabled={readOnly || deniedRepos || !config} onClick={() => void triageAgain()}>Triage again</button>}
                      {initial.enabled && <button type="button" className="btn" disabled={readOnly || deniedRepos || !config || toggling} onClick={() => void disableTriage()}>{toggling ? "Disabling…" : "Disable triage"}</button>}
                      <div className="segmented" role="radiogroup" aria-label="Draft pull requests">
                        <button type="button" role="radio" aria-checked={initial.triageDrafts} disabled={readOnly || deniedRepos || !config || toggling} onClick={() => void setTriageDrafts(true)}>Triage drafts</button>
                        <button type="button" role="radio" aria-checked={!initial.triageDrafts} disabled={readOnly || deniedRepos || !config || toggling} onClick={() => void setTriageDrafts(false)}>Skip drafts</button>
                      </div>
                      <p className="field-help">Drafts are triaged like any pull request but never shown as ready, and the author is not asked to mark them ready. Skipped drafts wait until they are marked ready.</p>
                      <button type="button" className="btn" onClick={() => void chooseOnGithub()}>Choose repositories on GitHub</button>
                      {config ? <a className="ghost-link" href={`https://github.com/${config.name}`} target="_blank" rel="noreferrer">View on GitHub</a> : null}
                    </div>
                  </aside>
                )}
              </div>
            )}
          </div>
        </main>
      </div>
      {dirty && (!needsSetup || customizing) && (
        <div className="dirty-bar">
          <button type="button" className="btn" onClick={cancelEdits}>Cancel</button>
          <button type="button" className="btn primary" disabled={readOnly || saving || !config} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</button>
        </div>
      )}
    </div>
  );
}
