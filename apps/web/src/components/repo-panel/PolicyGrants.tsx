import type { ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@corbits/react-ui";
import { errorText } from "@corbits/common";
import { alwaysHeld, DO_GRANT_ACTION, doResource, hostKinds, VERDICTS, type ActionKind, type CheckPack, type MergeRisk, type RepoSource } from "@corbits/triage-contracts";
import { findTriageRole } from "../../lib/automation-grid.ts";
import { checkPackQuery } from "../../lib/check-packs.ts";
import { doName, postingKinds } from "../../lib/policy-view.ts";
import { usePortal } from "../../lib/portal.tsx";
import { useAllowed, useRoles } from "../../lib/tenant-entities.ts";

function policyKinds(pack: CheckPack, decide: readonly ActionKind[], source: RepoSource): ActionKind[] {
  const steps = VERDICTS.flatMap((verdict) => pack.actions[verdict].flatMap((step) => (step.do === "nothing" || alwaysHeld(verdict, step.do) ? [] : [step.do])));
  const used = new Set<string>([...postingKinds(source), ...decide, ...steps]);
  return hostKinds(source).filter((kind) => used.has(kind));
}

const RISK_NAMES: Record<MergeRisk, string> = { "first-timers": "pull requests from first-time contributors", "ci-config": "changes to CI workflows" };

type PolicyGrantsProps = { repo: string; source: RepoSource; disabled: boolean };

export default function PolicyGrants({ repo, source, disabled }: PolicyGrantsProps) {
  const { addGrant, snapshot } = usePortal();
  const tenantId = snapshot?.workspace.tenantId;
  const policy = useQuery(checkPackQuery(tenantId, repo, source));
  const roles = useRoles();
  const canCreate = useAllowed("grant:*", "create");
  const queryClient = useQueryClient();
  const allow = useMutation({
    mutationFn: async function allowKinds({ roleId, kinds }: { roleId: string; kinds: ActionKind[] }) {
      for (const kind of kinds) await addGrant({ roleId, resource: doResource(kind, repo), action: DO_GRANT_ACTION });
      await queryClient.invalidateQueries({ queryKey: checkPackQuery(tenantId, repo, source).queryKey });
    },
  });

  function names(kinds: readonly ActionKind[]): string {
    return kinds.map((kind) => doName(source, kind)).join(", ");
  }

  function sentence(text: ReactNode) {
    return <div className="sentence">{text}</div>;
  }

  function caution(risks: readonly MergeRisk[] | undefined) {
    if (source !== "github" || !risks?.length) return null;
    return sentence(<span className="txt">Triage approves or merges on its own, which can let unintended code in: {risks.map((risk) => RISK_NAMES[risk]).join(", ")}.</span>);
  }

  function body() {
    if (policy.isPending || roles.loading) return sentence(<span className="txt">Checking what Triage may do here…</span>);
    if (policy.isError) return sentence(<span className="txt">Could not read what Triage may do here, so it asks before every action.</span>);
    const found = policy.data;
    if (found?.kind !== "file" && found?.kind !== "pack") return sentence(<span className="txt">This repository has no policy to allow, so Triage asks before every action.</span>);
    if (!found.automatic || roles.unavailable || roles.denied) return sentence(<span className="txt">Could not read what Triage may do here, so it asks before every action.</span>);
    const triage = findTriageRole(roles.rows);
    if (!triage) return sentence(<span className="txt">This workspace has no Triage role, so Triage asks before every action.</span>);
    const kinds = policyKinds(found.pack, found.decide ?? [], source);
    const missing = kinds.filter((kind) => !found.automatic?.includes(kind));
    if (missing.length === 0) return <>{sentence(<span className="txt">Triage does these on its own: {names(kinds)}.</span>)}{caution(found.mergeRisks)}</>;
    return (
      <>
        {sentence(
          <>
            <span className="txt">This policy wants Triage to: {names(missing)}. Until you allow it, these wait for you in the inbox.</span>
            <Button type="button" size="sm" disabled={disabled || !canCreate || allow.isPending} onClick={() => allow.mutate({ roleId: triage.id, kinds: missing })}>{allow.isPending ? "Allowing…" : "Allow"}</Button>
          </>,
        )}
        {caution(found.mergeRisks)}
      </>
    );
  }

  return (
    <section className="rs" aria-labelledby="rs-alone" id="rp-alone">
      <h3 id="rs-alone">Actions Triage takes on its own</h3>
      <div className="gcard">
        <div className="sentences">
          {body()}
        </div>
      </div>
      {allow.error ? <p role="alert" className="error">Could not allow these actions. {errorText(allow.error)} Try again.</p> : null}
    </section>
  );
}
