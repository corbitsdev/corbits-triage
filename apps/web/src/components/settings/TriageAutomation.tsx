import { useId } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { errorText } from "@corbits/common";
import { DO_GRANT_ACTION, doResource, repoPolicy, type ActionKind } from "@corbits/triage-contracts";
import { findTriageRole } from "../../lib/automation-grid.ts";
import { checkPackQuery } from "../../lib/check-packs.ts";
import { deleteGrant, type HubGrant, type PortalSnapshot, type RepoRecord } from "../../lib/hub-api.ts";
import { createHubTransport } from "../../lib/hub-transport.ts";
import { DO_NAMES } from "../../lib/pack-prose.ts";
import { GRANTS_QUERY_KEY, usePortal } from "../../lib/portal.tsx";
import { useAllowed, useGrants, useRoles } from "../../lib/tenant-entities.ts";
import { MergeCaution } from "../repo-panel/MergeCaution.tsx";

type RowProps = { tenantId: string; repo: RepoRecord; grants: readonly HubGrant[]; ask: boolean; disabled: boolean };

/**
 * In `ask` mode a kind removed stays removed; otherwise the next read of the policy file gives it back, so the line
 * says the file sets these instead of offering Remove.
 */
function AutomationRow({ tenantId, repo, grants, ask, disabled }: RowProps) {
  const queryClient = useQueryClient();
  const policy = useQuery(checkPackQuery(tenantId, repo.name, repo.source));
  const remove = useMutation({
    mutationFn: async function removeKind(grantId: string) {
      await deleteGrant(createHubTransport(), tenantId, grantId);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: [GRANTS_QUERY_KEY, tenantId] }),
        queryClient.invalidateQueries({ queryKey: checkPackQuery(tenantId, repo.name, repo.source).queryKey }),
      ]);
    },
  });
  const found = policy.data;
  const read = found?.kind === "file" ? found : undefined;
  const automatic = read?.automatic;

  function grantOf(kind: ActionKind): HubGrant | undefined {
    const resource = doResource(kind, repo.name);
    return grants.find((grant) => grant.resource === resource && grant.action === DO_GRANT_ACTION && grant.effect === "allow");
  }

  function kindItem(kind: ActionKind, at: number) {
    const name = DO_NAMES[kind];
    const grant = ask ? grantOf(kind) : undefined;
    return (
      <span key={kind}>
        {at > 0 ? ", " : null}{name}
        {grant === undefined ? null : <> <button type="button" className="linkish quiet" aria-label={`Remove ${name} in ${repo.name}`} disabled={disabled || remove.isPending} onClick={() => remove.mutate(grant.id)}>Remove</button></>}
      </span>
    );
  }

  function text() {
    if (policy.isPending) return "Checking what Triage does here on its own…";
    if (automatic === undefined) return "Could not read what Triage does here on its own.";
    if (automatic.length === 0) return "Triage asks before every action here.";
    return <>Triage does these on its own: {automatic.map(kindItem)}.{ask ? null : " This repository's policy file sets these."}</>;
  }

  return (
    <>
      <div className="sentence">
        <span className="txt mono small-text">{repo.name}</span>
        <span className="key-acts"><span className="model">{text()}</span></span>
        {remove.error ? <p role="alert" className="error">Could not remove it. {errorText(remove.error)} Try again.</p> : null}
      </div>
      <MergeCaution source={repo.source} risks={read?.mergeRisks ?? []} />
    </>
  );
}

/** What Triage does on its own in each enabled repository, for people who manage the workspace's grants. */
export function TriageAutomation({ snapshot }: { snapshot: PortalSnapshot }) {
  const { readOnly } = usePortal();
  const managesGrants = useAllowed("grant:*", "manage");
  const roles = useRoles();
  const grants = useGrants();
  const titleId = useId();
  if (!managesGrants) return null;
  const repos = snapshot.repos.filter((repo) => repo.connected && repoPolicy(repo).enabled);
  const triage = findTriageRole(roles.rows);
  const held = triage === undefined ? [] : grants.rows.filter((grant) => grant.roleId === triage.id);
  const ask = snapshot.config?.automation === "ask";

  return (
    <div className="gcard source" aria-labelledby={titleId} role="group">
      <header>
        <b id={titleId}>On its own</b>
        <span>What Triage does without asking in each enabled repository.</span>
      </header>
      <div className="source-body">
        <div className="sentences">
          {repos.length === 0 ? <div className="sentence"><span className="txt">No repository is enabled yet.</span></div> : null}
          {repos.map((repo) => <AutomationRow key={`${repo.source}:${repo.name}`} tenantId={snapshot.workspace.tenantId} repo={repo} grants={held} ask={ask} disabled={readOnly} />)}
        </div>
      </div>
    </div>
  );
}
