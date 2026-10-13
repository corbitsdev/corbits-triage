import { useState } from "react";
import { Button, EmptyState } from "@corbits/react-ui";
import { recommendedPack, type Action, type TriageStats } from "@corbits/triage-contracts";
import { moveAction, removeAction, upsertAction, type DraftProblem, type RepoDraft } from "../../lib/pack-draft.ts";
import type { RepoPack } from "../../lib/repo-pack.ts";
import ActionBuilder from "./ActionBuilder.tsx";
import ActionRow from "./ActionRow.tsx";
import VerdictRow from "./VerdictRow.tsx";

type ActionsListProps = {
  draft: RepoDraft;
  stats: TriageStats | undefined;
  disabled: boolean;
  edit: RepoPack["edit"];
  problem: DraftProblem | null;
};

const NEW = "new";

/** The built-in verdict first, then the pack's actions in order, each editable in place. */
export default function ActionsList({ draft, stats, disabled, edit, problem }: ActionsListProps) {
  const [editing, setEditing] = useState<string | null>(null);
  const actions = draft.pack.actions;
  const where = problem?.where;

  const unset = Object.keys(draft.pack.checks).length === 0;

  function close() {
    setEditing(null);
  }

  function save(action: Action) {
    edit((current) => upsertAction(current, action));
    close();
  }

  function remove(id: string) {
    edit((current) => removeAction(current, id));
    close();
  }

  function startFromRecommended() {
    edit(function recommended(current) {
      const { checks, actions } = recommendedPack(current.pack.repo);
      return { ...current, pack: { ...current.pack, checks, actions } };
    });
  }

  return (
    <section className="rs" aria-labelledby="rs-actions">
      <h3 id="rs-actions">Actions</h3>
      <p>What Triage does with each pull request. Automatic Dos run without asking; the rest wait for you.</p>
      <VerdictRow draft={draft} stats={stats} />
      {actions.map((action, index) => editing === action.id ? (
        <ActionBuilder
          key={action.id}
          action={action}
          draft={draft}
          stats={stats}
          disabled={disabled}
          edit={edit}
          onDone={save}
          onCancel={close}
          onRemove={() => remove(action.id)}
        />
      ) : (
        <ActionRow
          key={action.id}
          action={action}
          index={index}
          count={actions.length}
          draft={draft}
          stats={stats}
          disabled={disabled || editing !== null}
          reason={where?.section === "actions" && where.id === action.id ? problem?.reason : undefined}
          onEdit={() => setEditing(action.id)}
          onRemove={() => remove(action.id)}
          onMove={(to) => edit((current) => moveAction(current, action.id, to))}
        />
      ))}
      {editing === NEW ? <ActionBuilder draft={draft} stats={stats} disabled={disabled} edit={edit} onDone={save} onCancel={close} /> : null}
      {actions.length === 0 && editing !== NEW ? (
        <EmptyState
          title="No actions yet"
          description={unset
            ? "Actions label, assign, request review, comment or approve when the checks you pick pass, fail or are unsure. The recommended action approves each pull request once every check passes and CI is green. Settings, under Access, says which Dos triage runs on its own."
            : "Actions label, assign, request review, comment or approve when the checks you pick pass, fail or are unsure."}
          action={unset ? <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={startFromRecommended}>Start from recommended</Button> : null}
        />
      ) : null}
      {editing === null ? <div className="more"><Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => setEditing(NEW)}>New action</Button></div> : null}
    </section>
  );
}
