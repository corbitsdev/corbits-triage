import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@corbits/react-ui";
import { errorText } from "@corbits/common";
import { DO_GRANT_ACTION, doResource, hostKinds, VERDICTS, type ActionKind, type CheckPack, type RepoSource } from "@corbits/triage-contracts";
import { findTriageRole, triageRunsAlone } from "../../lib/automation-grid.ts";
import { DO_NAMES } from "../../lib/pack-prose.ts";
import { GRANTS_QUERY_KEY, usePortal } from "../../lib/portal.tsx";
import { useGrants, useRoles } from "../../lib/tenant-entities.ts";

/** The verdict is always posted: as a comment, and as labels where the host has them. */
const POSTING: readonly ActionKind[] = ["comment", "labels"];

/** A host without labels shows the verdict as a build status, written with the comment. */
function doName(source: RepoSource, kind: ActionKind): string {
  return kind === "comment" && !hostKinds(source).includes("labels") ? "Comment and build status" : DO_NAMES[kind];
}

function policyKinds(pack: CheckPack, source: RepoSource): ActionKind[] {
  const used = new Set<string>([...POSTING, ...VERDICTS.flatMap((verdict) => pack.actions[verdict].map((step) => step.do))]);
  return hostKinds(source).filter((kind) => used.has(kind));
}

type PolicyGrantsProps = { repo: string; source: RepoSource; pack: CheckPack; disabled: boolean };

export default function PolicyGrants({ repo, source, pack, disabled }: PolicyGrantsProps) {
  const { addGrant } = usePortal();
  const grants = useGrants();
  const roles = useRoles();
  const queryClient = useQueryClient();
  const allow = useMutation({
    mutationFn: async function allowKinds({ roleId, kinds }: { roleId: string; kinds: ActionKind[] }) {
      for (const kind of kinds) await addGrant({ roleId, resource: doResource(kind, repo), action: DO_GRANT_ACTION });
      await queryClient.invalidateQueries({ queryKey: [GRANTS_QUERY_KEY] });
    },
  });
  const kinds = policyKinds(pack, source);
  const names = (list: ActionKind[]) => list.map((kind) => doName(source, kind)).join(", ");

  function body() {
    if (grants.loading || roles.loading) return <p className="help">Checking what Triage may do here…</p>;
    if (grants.unavailable || roles.unavailable || grants.denied || roles.denied) return <p className="help">Could not read what Triage may do here, so it asks before every action.</p>;
    const triage = findTriageRole(roles.rows);
    if (!triage) return <p className="help">This workspace has no Triage role, so Triage asks before every action.</p>;
    const missing = kinds.filter((kind) => !triageRunsAlone(roles.rows, grants.rows, kind, repo));
    if (missing.length === 0) return <p className="help">Triage does these on its own: {names(kinds)}.</p>;
    return (
      <>
        <p className="help">This policy wants Triage to: {names(missing)}. Until you allow it, these wait for you in the inbox.</p>
        <Button type="button" size="sm" disabled={disabled || allow.isPending} onClick={() => allow.mutate({ roleId: triage.id, kinds: missing })}>{allow.isPending ? "Allowing…" : "Allow"}</Button>
        {allow.error ? <p role="alert" className="error">Could not allow {names(missing)}. {errorText(allow.error)} Try again.</p> : null}
      </>
    );
  }

  return (
    <section className="rs" aria-labelledby="rs-alone" id="rp-alone">
      <h3 id="rs-alone">Actions Triage takes on its own</h3>
      {body()}
    </section>
  );
}
