import type { DraftProblem } from "../../lib/pack-draft.ts";

type SaveBarProps = {
  changes: number;
  unlinked: boolean;
  /** The stored pack could not be read, so saving is worthwhile even with nothing edited. */
  corrupt: boolean;
  problem: DraftProblem | null;
  saving: boolean;
  /** Saving is not possible right now: read-only, still loading or stale. */
  disabled: boolean;
  onShow: (problem: DraftProblem) => void;
  onDiscard: () => void;
  onSave: () => void;
};

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function summary(changes: number, unlinked: boolean): string {
  if (changes > 0) return plural(changes, "unsaved change");
  return unlinked ? "Checks saved but not linked yet" : "The saved checks could not be read. Saving replaces them.";
}

/** Pending changes, the first reason they cannot be saved, and Discard and Save. */
export default function SaveBar({ changes, unlinked, corrupt, problem, saving, disabled, onShow, onDiscard, onSave }: SaveBarProps) {
  if (changes === 0 && !unlinked && !corrupt) return null;
  return (
    <div className="bar save" role="region" aria-label="Unsaved changes">
      {problem ? (
        <button type="button" className="linkish blocked" onClick={() => onShow(problem)}>{problem.reason}</button>
      ) : (
        <span>{summary(changes, unlinked)}</span>
      )}
      <span className="sp" />
      {changes > 0 ? <button type="button" className="btn btn-quiet btn-sm" disabled={saving} onClick={onDiscard}>Discard</button> : null}
      <button type="button" className="btn btn-primary btn-sm" disabled={disabled || saving || problem !== null} onClick={onSave}>{saving ? "Saving…" : "Save changes"}</button>
    </div>
  );
}
