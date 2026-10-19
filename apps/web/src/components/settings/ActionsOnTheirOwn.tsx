import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Switch } from "@corbits/react-ui";
import { errorText } from "@corbits/common";
import { ACTION_KINDS, DO_GRANT_ACTION, doResource, type ActionKind } from "@corbits/triage-contracts";
import { findTriageRole, hostCased, triageScope } from "../../lib/automation-grid.ts";
import { DeniedNotice } from "../../lib/denied.tsx";
import { canRemoveGrant } from "../../lib/grant-actions.ts";
import type { HubGrant, HubRole } from "../../lib/hub-api.ts";
import { DO_NAMES } from "../../lib/pack-prose.ts";
import { GRANTS_QUERY_KEY, usePortal } from "../../lib/portal.tsx";
import { useAllowed, useGrants, useRoles } from "../../lib/tenant-entities.ts";

type Change = { roleId: string; kind: ActionKind; on: boolean; everywhere: HubGrant | undefined };

/** One switch per action for every repository; a repository's own switches stay on its page. */
export function ActionsOnTheirOwn({ repos }: { repos: readonly string[] }) {
  const { addGrant, removeGrants, readOnly } = usePortal();
  const grants = useGrants();
  const roles = useRoles();
  const canCreate = useAllowed("grant:*", "create");
  const canManage = useAllowed("grant:*", "manage");
  const queryClient = useQueryClient();
  const change = useMutation({
    mutationFn: async function setEverywhere({ roleId, kind, on, everywhere }: Change) {
      if (on) await addGrant({ roleId, resource: doResource(kind, "*"), action: DO_GRANT_ACTION });
      else if (everywhere) await removeGrants([everywhere]);
      await queryClient.invalidateQueries({ queryKey: [GRANTS_QUERY_KEY] });
    },
  });
  const triage = findTriageRole(roles.rows);
  const loading = [grants, roles].some((section) => section.loading || section.unavailable);

  function row(role: HubRole, kind: ActionKind) {
    const scope = triageScope(role, kind, grants.rows);
    const on = scope.locked || scope.everywhere !== undefined;
    const fixed = scope.locked || (scope.everywhere !== undefined && !canRemoveGrant(scope.everywhere));
    const some = [...new Set(scope.repos.map((entry) => hostCased(repos, entry.repo)))];
    return (
      <div key={kind} className={`sentence${on ? "" : " off"}`}>
        <span className="txt">
          {DO_NAMES[kind]}
          {!on && some.length > 0 ? <span className="wide">On in {some.join(", ")}</span> : null}
        </span>
        <Switch className="sw" checked={on} onCheckedChange={(next) => change.mutate({ roleId: role.id, kind, on: next, everywhere: scope.everywhere })} label={`${DO_NAMES[kind]} on its own in every repository`} disabled={readOnly || !canCreate || !canManage || change.isPending || fixed} />
      </div>
    );
  }

  return (
    <div className="gcard source alone" aria-labelledby="triage-alone" role="group">
      <header>
        <b id="triage-alone">Actions that run on their own</b>
        <span>Triage does these in every repository without asking. The rest wait for you in the inbox.</span>
      </header>
      <div className="source-body">
        {(grants.denied || roles.denied) && <DeniedNotice section="access rules" />}
        {!loading && !triage && <p className="muted">Triage asks before every action in this workspace.</p>}
        {!loading && triage && <div className="sentences">{ACTION_KINDS.map((kind) => row(triage, kind))}</div>}
        {change.error && change.variables ? <p role="alert" className="error">Could not change {DO_NAMES[change.variables.kind]} on its own. {errorText(change.error)} Try again.</p> : null}
      </div>
    </div>
  );
}
