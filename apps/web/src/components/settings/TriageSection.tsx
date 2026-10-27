import { useMemo, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { presetFor, TRIAGE_LISTENERS, type DeployedVersions, type RepoSource } from "@corbits/triage-contracts";
import { useCheckPacks } from "../../lib/check-packs.ts";
import { modelSecrets } from "../../lib/credential-actions.ts";
import { DeniedNotice } from "../../lib/denied.tsx";
import { connectedSources, currentDeployment, isActiveCredential, type DeployedWorkflow, type PortalSnapshot } from "../../lib/hub-api.ts";
import { counted } from "../../lib/plural.ts";
import { usePortal } from "../../lib/portal.tsx";
import { hostFullName } from "../../lib/pull-link.ts";
import { packsPending, triageEnabledRepos, triageReadyRepos } from "../../lib/repo-rows.ts";
import type { DeployedSection } from "../../lib/tenant-entities.ts";
import { DecisionModelForm } from "../DecisionModelForm.tsx";
import { BitbucketDatacenterSource } from "./BitbucketDatacenterSource.tsx";
import { GithubSource } from "./GithubSource.tsx";
import { KeyRow } from "./KeyRow.tsx";
import { PolicyFiles } from "./PolicyFiles.tsx";
import { TriageVersions } from "./TriageVersions.tsx";

/** The connected hosts without a listener up. */
function undeployedSources(deployments: readonly DeployedWorkflow[], sources: readonly RepoSource[]): RepoSource[] {
  return sources.filter((source) => currentDeployment(deployments, TRIAGE_LISTENERS[source])?.live !== true);
}

type Status = { sources: RepoSource[]; undeployed: RepoSource[]; model: boolean; triaging: number; total: number };

function statusText({ sources, undeployed, model, triaging, total }: Status): string {
  if (sources.length === 0) return "Triage is not running: no source is connected.";
  if (!model) return "Triage needs a decision model before it can run. Add one below.";
  if (undeployed.length === sources.length) return "Triage is not running: its workflow is not deployed.";
  if (undeployed.length > 0) return `Triage is not running on ${undeployed.map(hostFullName).join(" or ")}: its workflow is not deployed.`;
  if (total === 0) return "Triage is running, but no repository is connected yet.";
  return `Triage is running on ${triaging} of ${counted(total, "repository", "repositories")}.`;
}

/** How full this server is, and where pull requests go once it is. */
function sidecarText({ active, cap, overflow }: DeployedVersions["sidecar"]): string {
  const runs = `This server runs ${active} of up to ${cap} Triage workflows at once`;
  const elsewhere = overflow > 0 ? `; ${overflow} more ${overflow === 1 ? "runs" : "run"} in a sandbox because it is full` : "";
  if (active >= cap && overflow === 0) return `${runs}: it is full, so new pull requests wait for one to finish.`;
  return `${runs}${elsewhere}.`;
}

/** A preset by its name; your own provider by its endpoint and model. */
function judgeModel(saved: { endpoint: string; model: string }): ReactNode {
  const preset = presetFor(saved);
  if (preset.id !== "custom") return <b>{preset.label}</b>;
  return <><b>{saved.endpoint}</b> · <span className="mono small-text">{saved.model}</span></>;
}

function DecisionModel({ snapshot }: { snapshot: PortalSnapshot }) {
  const { removeDecisionModel } = usePortal();
  const saved = snapshot.decisionModel;
  const words = saved ? <>Judge pull requests with {judgeModel(saved)}</> : "Judge pull requests with a decision model";

  return (
    <div className="gcard source" aria-labelledby="triage-model" role="group">
      <header>
        <b id="triage-model">Decision model</b>
        <span>Answers your policies' Judgement rules and chooses the verdict.</span>
      </header>
      <div className="source-body">
        {snapshot.denied.credentials && <DeniedNotice section="credentials" />}
        <div className="sentences">
          <KeyRow
            words={words}
            name="decision model"
            keys={modelSecrets(snapshot.credentials).filter(isActiveCredential)}
            denied={snapshot.denied.credentials}
            remove={removeDecisionModel}
            error={snapshot.credentialsError}
            editor={(onSaved) => <DecisionModelForm onSaved={onSaved} />}
          />
        </div>
      </div>
    </div>
  );
}

export function TriageSection({ snapshot, deployed }: { snapshot: PortalSnapshot; deployed: DeployedSection }) {
  const enabled = useMemo(() => [...triageEnabledRepos(snapshot.repos)], [snapshot.repos]);
  const packs = useCheckPacks(enabled);
  const ready = !deployed.denied && !deployed.loading && !deployed.unavailable && !packsPending(packs);
  const sources = connectedSources(snapshot.credentials);
  const status = {
    sources,
    undeployed: undeployedSources(deployed.rows, sources),
    model: snapshot.decisionModel !== undefined,
    triaging: triageReadyRepos(snapshot.repos, packs).size,
    total: snapshot.repos.length,
  };

  return (
    <section className="sec" id="triage" aria-labelledby="sec-triage">
      <header>
        <h2 id="sec-triage">Triage</h2>
        <p>Every new or updated pull request in an enabled repository gets a verdict: Pass, Fail or Unsure.</p>
      </header>
      <div>
        {deployed.denied && <DeniedNotice section="workflow deployments" />}
        {ready && (
          <div className="sentences">
            <div className="sentence">
              <span className="txt">{statusText(status)}</span>
              <Link className="linkish" to="/repositories">Choose repositories</Link>
            </div>
            {deployed.sidecar && (
              <div className="sentence">
                <span className="txt">{sidecarText(deployed.sidecar)}</span>
              </div>
            )}
            {sources.length > 0 && status.model && <TriageVersions deployed={deployed} sources={sources} />}
          </div>
        )}
        <GithubSource snapshot={snapshot} />
        <BitbucketDatacenterSource />
        <PolicyFiles snapshot={snapshot} />
        <DecisionModel snapshot={snapshot} />
      </div>
    </section>
  );
}
