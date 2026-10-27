import type { ReactNode } from "react";
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { Button } from "@corbits/react-ui";
import { errorText } from "@corbits/common";
import { DO_GRANT_ACTION, doResource, type ActionKind, type MergeRisk, type RepoSource } from "@corbits/triage-contracts";
import { findTriageRole } from "../../lib/automation-grid.ts";
import { checkPackQuery } from "../../lib/check-packs.ts";
import type { CheckPackArtifact, HubRole } from "../../lib/hub-api.ts";
import { doName } from "../../lib/policy-view.ts";
import { usePortal } from "../../lib/portal.tsx";
import { useAllowed, useRoles, type TenantSection } from "../../lib/tenant-entities.ts";

const RISK_NAMES: Record<MergeRisk, string> = { "first-timers": "pull requests from first-time contributors", "ci-config": "changes to CI workflows" };

type GrantsReading = { text: string } | { roleId: string; kinds: ActionKind[]; missing: ActionKind[]; risks: readonly MergeRisk[] };

/** What Triage approving or merging on its own can let in; the risks name GitHub's author associations and workflow paths. */
export function MergeCaution({ source, risks }: { source: RepoSource; risks: readonly MergeRisk[] }) {
  if (source !== "github" || risks.length === 0) return null;
  return <div className="sentence"><span className="txt">Triage approves or merges on its own, which can let unintended code in: {risks.map((risk) => RISK_NAMES[risk]).join(", ")}.</span></div>;
}

type PolicyResult = Pick<UseQueryResult<CheckPackArtifact | null>, "isPending" | "isError" | "data">;

export function readGrants(policy: PolicyResult, roles: TenantSection<HubRole>): GrantsReading {
  if (policy.isPending || roles.loading) return { text: "Checking what Triage may do here…" };
  if (policy.isError) return { text: "Could not read what Triage may do here, so it asks before every action." };
  const found = policy.data;
  if (found?.kind !== "file") return { text: "This repository has no policy to allow, so Triage asks before every action." };
  if (roles.unavailable || roles.denied) return { text: "Could not read what Triage may do here, so it asks before every action." };
  const triage = findTriageRole(roles.rows);
  if (!triage) return { text: "This workspace has no Triage role, so Triage asks before every action." };
  return { roleId: triage.id, kinds: found.wanted, missing: found.wanted.filter((kind) => !found.automatic.includes(kind)), risks: found.mergeRisks };
}

export function missesGrants(reading: GrantsReading): boolean {
  return "missing" in reading && reading.missing.length > 0;
}

type PolicyGrantsProps = { repo: string; source: RepoSource; disabled: boolean };

export default function PolicyGrants({ repo, source, disabled }: PolicyGrantsProps) {
  const { snapshot } = usePortal();
  const policy = useQuery(checkPackQuery(snapshot?.workspace.tenantId, repo, source));
  const roles = useRoles();
  return <GrantsCard repo={repo} source={source} disabled={disabled} reading={readGrants(policy, roles)} />;
}

/** `listIndex` places the card in a list of repositories, which names the repository and keeps its heading id unique. */
type GrantsCardProps = { repo: string; source: RepoSource; disabled: boolean; reading: GrantsReading; listIndex?: number };

export function GrantsCard({ repo, source, disabled, reading, listIndex }: GrantsCardProps) {
  const { addGrant, snapshot } = usePortal();
  const tenantId = snapshot?.workspace.tenantId;
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

  function body() {
    if ("text" in reading) return sentence(<span className="txt">{reading.text}</span>);
    if (reading.missing.length === 0) return <>{sentence(<span className="txt">Triage does these on its own: {names(reading.kinds)}.</span>)}<MergeCaution source={source} risks={reading.risks} /></>;
    const { roleId, missing } = reading;
    return (
      <>
        {sentence(
          <>
            <span className="txt">This policy wants Triage to: {names(missing)}. Until you allow it, these wait for you on Triage.</span>
            <Button type="button" size="sm" disabled={disabled || !canCreate || allow.isPending} onClick={() => allow.mutate({ roleId, kinds: missing })}>{allow.isPending ? "Allowing…" : "Allow"}</Button>
          </>,
        )}
        <MergeCaution source={source} risks={reading.risks} />
      </>
    );
  }

  const listed = listIndex !== undefined;
  const headingId = listed ? `grants-${`${source}:${repo}`.replace(/[^A-Za-z0-9_-]/g, "-")}-${listIndex}` : "rs-alone";

  return (
    <section className="rs" aria-labelledby={headingId} id={listed ? undefined : "rp-alone"}>
      <h3 id={headingId}>Actions Triage takes on its own{listed ? ` in ${repo}` : ""}</h3>
      <div className="gcard">
        <div className="sentences">
          {body()}
        </div>
      </div>
      {allow.error ? <p role="alert" className="error">Could not allow these actions. {errorText(allow.error)} Try again.</p> : null}
    </section>
  );
}
