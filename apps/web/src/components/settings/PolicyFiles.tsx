import { Button } from "@corbits/react-ui";
import { Link } from "react-router-dom";
import { POLICY_FILE_PATH } from "@corbits/triage-contracts";
import { DeniedNotice } from "../../lib/denied.tsx";
import type { PortalSnapshot, RepoRecord } from "../../lib/hub-api.ts";
import { usePolicyFile } from "../../lib/policy-file.ts";
import { usePolicyUpgrade } from "../../lib/policy-upgrades.ts";
import { repoHref } from "../../lib/repo-rows.ts";

function policyText(file: { path: string } | null | undefined, failed: boolean) {
  if (failed) return "Could not read its policy file";
  if (file === undefined) return null;
  return file ? <>Has <code>{file.path}</code></> : <>No <code>{POLICY_FILE_PATH}</code></>;
}

function PolicyFileRow({ repo }: { repo: RepoRecord }) {
  const file = usePolicyFile(repo.name, repo.source);
  const canStart = usePolicyUpgrade(repo.name)?.upgrade?.state === "start";

  return (
    <div className="sentence">
      <span className="txt mono small-text">{repo.name}</span>
      <span className="key-acts">
        <span className="model">{policyText(file.data, file.isError)}</span>
        {canStart && <Button asChild variant="link" size="sm"><Link to={repoHref(repo)}>Start a policy file</Link></Button>}
      </span>
    </div>
  );
}

/** Each connected repository and whether its default branch has a policy file; one that can start a file links to its page, where the steps are. */
export function PolicyFiles({ snapshot }: { snapshot: PortalSnapshot }) {
  const repos = snapshot.repos.filter((repo) => repo.connected);

  return (
    <div className="gcard source" aria-labelledby="triage-repos" role="group">
      <header>
        <b id="triage-repos">Repositories</b>
        <span>Each repository's rules and actions come from its policy file.</span>
      </header>
      <div className="source-body">
        {snapshot.denied.repos && <DeniedNotice section="repositories" />}
        <div className="sentences">
          {repos.map((repo) => <PolicyFileRow key={`${repo.source}:${repo.name}`} repo={repo} />)}
          <div className="sentence">
            <span className="txt">{repos.length === 0 ? "No repository is connected yet." : "Turn triage on or off per repository."}</span>
            <Button asChild variant="link" size="sm"><Link to="/repositories">Open Repositories</Link></Button>
          </div>
        </div>
      </div>
    </div>
  );
}
