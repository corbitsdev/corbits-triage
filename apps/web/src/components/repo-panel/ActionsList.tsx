import { useState } from "react";
import { EmptyState } from "@corbits/react-ui";
import { applyRecommended, type Action, type CheckPack } from "@corbits/triage-contracts";
import { moveAction, removeAction, upsertAction, type DraftProblem, type RepoDraft } from "../../lib/pack-draft.ts";
import type { RepoPack } from "../../lib/repo-pack.ts";
import ActionBuilder from "./ActionBuilder.tsx";
import ActionRow from "./ActionRow.tsx";
import VerdictRow from "./VerdictRow.tsx";

type ActionsListProps = {
  draft: RepoDraft;
  saved: CheckPack;
  disabled: boolean;
  edit: RepoPack["edit"];
  problem: DraftProblem | null;
};

const NEW = "new";

/** The built-in verdict first, then the pack's actions in order, each editable in place. */
export default function ActionsList({ draft, saved, disabled, edit, problem }: ActionsListProps) {
  const [editing, setEditing] = useState<string | null>(null);
  const actions = draft.pack.actions;
  const where = problem?.where;
  const customReason = where?.section === "custom" || where?.section === "pack" ? problem?.reason : undefined;

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
    edit((current) => ({ ...current, pack: applyRecommended(current.pack) }));
  }

  return (
    <section className="rs" aria-labelledby="rs-actions">
      <h3 id="rs-actions">Actions</h3>
      <p>What Triage does with each pull request. Automatic Dos run without asking; the rest wait for you.</p>
      <VerdictRow draft={draft} saved={saved} disabled={disabled} edit={edit} reason={customReason} flaggedCheck={where?.section === "custom" ? where.id : undefined} />
      {actions.map((action, index) => editing === action.id ? (
        <ActionBuilder
          key={action.id}
          action={action}
          draft={draft}
          saved={saved}
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
          saved={saved}
          disabled={disabled || editing !== null}
          edit={edit}
          reason={where?.section === "actions" && where.id === action.id ? problem?.reason : undefined}
          onEdit={() => setEditing(action.id)}
          onRemove={() => remove(action.id)}
          onMove={(to) => edit((current) => moveAction(current, action.id, to))}
        />
      ))}
      {editing === NEW ? <ActionBuilder draft={draft} saved={saved} disabled={disabled} edit={edit} onDone={save} onCancel={close} /> : null}
      {actions.length === 0 && editing !== NEW ? (
        <EmptyState
          title="No actions yet"
          description="Actions label, assign, request review or comment when the checks you pick pass, fail or are unsure."
          action={unset ? <button type="button" className="btn btn-sm" disabled={disabled} onClick={startFromRecommended}>Start from recommended</button> : null}
        />
      ) : null}
      {editing === null ? <div className="more"><button type="button" className="btn btn-sm" disabled={disabled} onClick={() => setEditing(NEW)}>New action</button></div> : null}
    </section>
  );
}
