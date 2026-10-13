import { Link } from "react-router-dom";
import { VERDICTS, type ActionKind, type TriageStats } from "@corbits/triage-contracts";
import { triageRunsAlone } from "../../lib/automation-grid.ts";
import { setList, setWhen, type DraftProblem, type RepoDraft } from "../../lib/pack-draft.ts";
import type { RepoPack } from "../../lib/repo-pack.ts";
import { useGrants, useRoles } from "../../lib/tenant-entities.ts";
import VerdictList from "./VerdictList.tsx";
import WhenPicker from "./WhenPicker.tsx";

type ActionsSectionProps = { repo: string; draft: RepoDraft; stats: TriageStats | undefined; disabled: boolean; edit: RepoPack["edit"]; problem: DraftProblem | null };

/** When the policy wakes, then what runs on each verdict; each Do says whether triage runs it alone or it waits for you. */
export default function ActionsSection({ repo, draft, stats, disabled, edit, problem }: ActionsSectionProps) {
  const grants = useGrants();
  const roles = useRoles();
  const where = problem?.where.section === "actions" ? problem.where : undefined;
  const known = ![grants, roles].some((section) => section.loading || section.unavailable || section.denied);
  const actions = draft.pack.actions;

  function alone(kind: ActionKind): boolean {
    return triageRunsAlone(roles.rows, grants.rows, kind, repo);
  }

  return (
    <section className="rs" aria-labelledby="rs-actions" id="rp-actions">
      <h3 id="rs-actions">Actions</h3>
      <p>What Triage does once it decides a pull request. A Do runs alone when triage holds it in <Link to="/settings/access">Settings → Actions</Link>; the rest wait for you.</p>
      <div className={where && where.list === undefined ? "sentence invalid" : "sentence"}>
        <span className="txt">When a pull request is <WhenPicker when={actions.when} disabled={disabled} onChange={(when) => edit((current) => setWhen(current, when))} /></span>
      </div>
      {where && where.list === undefined ? <p className="reason">{problem?.reason}</p> : null}
      {VERDICTS.map((list) => (
        <VerdictList
          key={list}
          list={list}
          dos={actions[list]}
          roles={Object.keys(draft.policy.roles)}
          alone={known ? alone : undefined}
          fired={stats?.actions[list]}
          disabled={disabled}
          reason={where?.list === list ? problem?.reason : undefined}
          onChange={(dos) => edit((current) => setList(current, list, dos))}
        />
      ))}
    </section>
  );
}
