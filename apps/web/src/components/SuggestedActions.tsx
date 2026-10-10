import { doGroups, type PendingDo } from "../lib/pending-dos.ts";

type SuggestedActionsProps = { dos: PendingDo[]; disabled: boolean; onRun: (pending: PendingDo) => void };

export function SuggestedActions({ dos, disabled, onRun }: SuggestedActionsProps) {
  if (dos.length === 0) return null;
  return (
    <section className="dos" aria-label="Suggested actions">
      <h3 className="lbl-h">Suggested actions</h3>
      {doGroups(dos).map((group) => (
        <div key={group.actionId} className="suggest">
          <p className="suggest-text">{group.reason}</p>
          <div className="suggest-actions">
            {group.dos.map((pending) => (
              <button key={pending.key} type="button" className="btn btn-sm" disabled={disabled || pending.running} onClick={() => onRun(pending)}>
                {pending.running ? `${pending.label}: already running` : pending.label}
              </button>
            ))}
          </div>
          {group.dos.filter((pending) => pending.error !== null).map((pending) => <p key={pending.key} role="alert" className="error">{pending.label} failed last time: {pending.error}</p>)}
        </div>
      ))}
    </section>
  );
}
