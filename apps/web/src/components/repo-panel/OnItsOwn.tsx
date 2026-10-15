import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Switch } from "@corbits/react-ui";
import { errorText } from "@corbits/common";
import { DO_GRANT_ACTION, doResource, hostKinds, type ActionKind, type RepoSource } from "@corbits/triage-contracts";
import { findTriageRole, triageScope } from "../../lib/automation-grid.ts";
import { canRemoveGrant } from "../../lib/grant-actions.ts";
import type { HubGrant, HubRole } from "../../lib/hub-api.ts";
import { DO_NAMES } from "../../lib/pack-prose.ts";
import { GRANTS_QUERY_KEY, usePortal } from "../../lib/portal.tsx";

const DOES: Record<ActionKind, string> = {
  labels: "adds its labels",
  assign: "assigns people",
  "request-review": "requests reviewers",
  comment: "posts its comment",
  approve: "approves the pull request",
  "request-changes": "requests changes",
  close: "closes the pull request",
  merge: "merges the pull request",
};

/** A host without labels shows the verdict as a build status, written with the comment. */
function does(source: RepoSource, kind: ActionKind): string {
  return kind === "comment" && !hostKinds(source).includes("labels") ? "posts its comment and the verdict build status" : DOES[kind];
}

type Change = { roleId: string; kind: ActionKind; on: boolean; own: HubGrant[] };

type OnItsOwnProps = { repo: string; source: RepoSource; roles: HubRole[]; grants: HubGrant[]; disabled: boolean };

export default function OnItsOwn({ repo, source, roles, grants, disabled }: OnItsOwnProps) {
  const { addGrant, removeGrants } = usePortal();
  const queryClient = useQueryClient();
  const change = useMutation({
    mutationFn: async function setOn({ roleId, kind, on, own }: Change) {
      if (on) await addGrant({ roleId, resource: doResource(kind, repo), action: DO_GRANT_ACTION });
      else await removeGrants(own);
      await queryClient.invalidateQueries({ queryKey: [GRANTS_QUERY_KEY] });
    },
  });
  const triage = findTriageRole(roles);
  if (!triage) return null;
  const name = repo.toLowerCase();

  function row(triage: HubRole, kind: ActionKind) {
    const scope = triageScope(triage, kind, grants);
    const wider = scope.locked || Boolean(scope.everywhere);
    const own = scope.repos.filter((entry) => entry.repo === name).map((entry) => entry.grant);
    const on = wider || own.length > 0;
    return (
      <div key={kind} className={`sentence${on ? "" : " off"}`}>
        <span className="txt">
          <b>{DO_NAMES[kind]}</b>: Triage {does(source, kind)} without asking.
          {wider ? <span className="wide">On in every repository (<Link to="/settings/access">Settings → Access</Link>)</span> : null}
        </span>
        <Switch className="sw" checked={on} onCheckedChange={(next) => change.mutate({ roleId: triage.id, kind, on: next, own })} label={`${DO_NAMES[kind]} on its own`} disabled={disabled || change.isPending || wider || !own.every(canRemoveGrant)} />
      </div>
    );
  }

  return (
    <section className="rs alone" aria-labelledby="rs-alone" id="rp-alone">
      <h3 id="rs-alone">Actions Triage takes on its own</h3>
      <p className="help">The rest wait for you in the inbox.</p>
      <div className="gcard"><div className="sentences">{hostKinds(source).map((kind) => row(triage, kind))}</div></div>
      {change.error && change.variables ? <p role="alert" className="error">Could not change whether Triage {does(source, change.variables.kind)} on its own. {errorText(change.error)} Try again.</p> : null}
    </section>
  );
}
