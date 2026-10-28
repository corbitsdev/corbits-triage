import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useIsFetching, useQuery } from "@tanstack/react-query";
import { Button, StatusDot } from "@corbits/react-ui";
import { errorText } from "@corbits/common";
import { repoPolicy, type CheckPack, type RepoSource } from "@corbits/triage-contracts";
import { DecisionModelSection } from "../components/code-review/DecisionModelSection.tsx";
import PolicySwitches, { type Missing } from "../components/code-review/PolicySwitches.tsx";
import { readRecent, repoKey, RepoSwitcher } from "../components/code-review/RepoSwitcher.tsx";
import { ExternalIcon } from "../components/inbox-icons.tsx";
import PolicyRules from "../components/repo-panel/PolicyRules.tsx";
import PolicyStart, { HOST_NAME } from "../components/repo-panel/PolicyStart.tsx";
import { CodeReviewSection } from "../components/settings/CodeReviewSection.tsx";
import { checkPackQuery } from "../lib/check-packs.ts";
import { anthropicSecrets } from "../lib/credential-actions.ts";
import { isActiveCredential, type PortalSnapshot, type RepoRecord } from "../lib/hub-api.ts";
import { useBranchPolicy, usePolicyFile } from "../lib/policy-file.ts";
import { differingIds } from "../lib/policy-patch.ts";
import { usePolicyPull, usePolicyStartActions, usePolicyUpgrade, type PolicyUpgradeRow } from "../lib/policy-upgrades.ts";
import { usePortal } from "../lib/portal.tsx";

/** What code review lacks in this workspace, and where on this page it is added. */
function reviewMissing(snapshot: PortalSnapshot): Missing | undefined {
  if (snapshot.codeReviewPlace === null) return { words: "Code review needs an isolated place to run", action: "Set one up", href: "#code-review" };
  if (!anthropicSecrets(snapshot.credentials).some(isActiveCredential)) return { words: "Code review needs the workspace's Anthropic key", action: "Add the key", href: "#code-review" };
  return undefined;
}

type Pull = NonNullable<PolicyUpgradeRow["pull"]>;

function PullRow({ repo, source, pull }: { repo: string; source: RepoSource; pull: Pull }) {
  const { merge } = usePolicyStartActions(repo, source);
  const { headSha } = pull;
  const host = HOST_NAME[source];
  return (
    <div className="sentences">
      <div className="sentence pr-row">
        <span className="txt">Pull request #{pull.number}</span>
        <span className="state"><span className="dot" />Open, waiting for review</span>
        {headSha ? (
          <>
            <Button asChild variant="ghost" size="sm"><a href={pull.url} target="_blank" rel="noreferrer">Review on {host} <ExternalIcon /></a></Button>
            <Button type="button" size="sm" disabled={merge.isPending} onClick={() => merge.mutate({ number: pull.number, headSha })}>Merge</Button>
          </>
        ) : (
          <Button asChild variant="outline" size="sm"><a href={pull.url} target="_blank" rel="noreferrer">Merge on {host} <ExternalIcon /></a></Button>
        )}
      </div>
      {merge.error ? <p role="alert" className="error">{errorText(merge.error)}</p> : null}
    </div>
  );
}

/** A file the page cannot change rule by rule, read back as sentences with why. */
function ReadOnly({ why, pack, source }: { why: string; pack: CheckPack; source: RepoSource }) {
  return (
    <>
      <p className="help">{why}</p>
      <PolicyRules pack={pack} source={source} />
    </>
  );
}

function FileProblem({ problem }: { problem: string }) {
  return (
    <div className="gcard">
      <div className="sentences">
        <div className="sentence"><span className="txt">Triage runs nothing until the file is fixed:</span></div>
        {problem.split("\n").map((line) => <p key={line} className="reason">{line}</p>)}
      </div>
    </div>
  );
}

type RepoPolicyProps = { snapshot: PortalSnapshot; repo: RepoRecord; disabled: boolean };

/** The selected repository's rules, the pull request that changes them while one is open, and a start when it has no file. */
function RepoPolicy({ snapshot, repo, disabled }: RepoPolicyProps) {
  const { name, source } = repo;
  const file = usePolicyFile(name, source);
  const policy = useQuery(checkPackQuery(snapshot.workspace.tenantId, name, source));
  const pull = usePolicyPull(name, source);
  const standing = usePolicyUpgrade(name, source);
  const branch = useBranchPolicy(name, source, file.data?.pull?.text);

  if (standing?.error) return <p role="alert" className="error">{standing.error}</p>;
  if (file.isError) return <p role="alert" className="error">Could not read the policy file. {errorText(file.error)} <button type="button" className="linkish quiet" onClick={() => void file.refetch()}>Try again</button></p>;
  if (policy.isError) return <p role="alert" className="error">Could not read the policy. {errorText(policy.error)} <button type="button" className="linkish quiet" onClick={() => void policy.refetch()}>Try again</button></p>;
  if (branch.isError) return <p role="alert" className="error">Could not read the open pull request's policy. {errorText(branch.error)} <button type="button" className="linkish quiet" onClick={() => void branch.refetch()}>Try again</button></p>;
  if (file.data === undefined || policy.isLoading || branch.isLoading) return <div className="loading-indicator"><StatusDot label="Loading" live tone="emphasis" /></div>;
  if (file.data === null) return <PolicyStart repo={name} source={source} pull={pull} disabled={disabled} />;
  if (file.data.problem) return <FileProblem problem={file.data.problem} />;
  if (policy.data?.kind === "invalid") return <FileProblem problem={policy.data.reason} />;
  if (!policy.data) return null;
  // While a policy pull request is open, changes land on its branch, so the switches show that file.
  const shown = branch.data ?? policy.data;
  if (shown.kind === "invalid") return <FileProblem problem={shown.reason} />;
  const { pack } = shown;
  if (shown.extends) return <ReadOnly why={`This policy builds on ${shown.extends}'s, so its rules are changed there.`} pack={pack} source={source} />;
  if (file.data.text === undefined) return <ReadOnly why="This policy file is too large to change here." pack={pack} source={source} />;
  const pending = branch.data ? differingIds(policy.data.pack, pack, policy.data.codeReview, shown.codeReview) : [];

  return (
    <PolicySwitches
      repo={name}
      source={source}
      file={file.data}
      pack={pack}
      reviewOn={shown.codeReview}
      hasModel={snapshot.decisionModel !== undefined}
      reviewMissing={reviewMissing(snapshot)}
      pull={pull ? <PullRow repo={name} source={source} pull={pull} /> : null}
      pending={pending}
      disabled={disabled}
    />
  );
}

function firstRepo(repos: readonly RepoRecord[]): RepoRecord | undefined {
  const recent = readRecent();
  return recent.flatMap((key) => repos.filter((repo) => repoKey(repo) === key))[0] ?? repos[0];
}

/** Every triaged repository's rules, judging and code review, one repository at a time, and the settings all of them share. */
export default function CodeReview() {
  const { snapshot, readOnly } = usePortal();
  const { hash } = useLocation();
  // The rules above a section load after the page does, so the jump waits until nothing is loading.
  const fetching = useIsFetching();
  const settled = snapshot !== null && fetching === 0;
  const jumped = useRef("");
  const repos = useMemo(() => (snapshot?.repos ?? []).filter((repo) => repo.connected && repoPolicy(repo).enabled), [snapshot?.repos]);
  const [picked, setPicked] = useState<string | null>(null);
  const selected = repos.find((repo) => repoKey(repo) === picked) ?? firstRepo(repos);

  useEffect(function jumpToSection() {
    if (!settled || !hash || jumped.current === hash) return;
    jumped.current = hash;
    document.getElementById(hash.slice(1))?.scrollIntoView();
  }, [settled, hash]);

  if (!snapshot) return null;
  return (
    <main className="settings code-review" id="main">
      <h1>Code review</h1>
      {selected ? (
        <>
          <RepoSwitcher repos={repos} selected={selected} onSelect={(repo) => setPicked(repoKey(repo))} />
          <RepoPolicy key={repoKey(selected)} snapshot={snapshot} repo={selected} disabled={readOnly || snapshot.denied.repos} />
        </>
      ) : (
        <p className="lede">No repository is triaged yet. <Link className="linkish" to="/repositories">Choose repositories</Link></p>
      )}
      <h2 className="for-all">For every repository</h2>
      <DecisionModelSection snapshot={snapshot} />
      <CodeReviewSection snapshot={snapshot} />
    </main>
  );
}
