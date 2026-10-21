import { Button } from "@corbits/react-ui";
import { doGroups, type PendingDo } from "../lib/pending-dos.ts";

type SuggestedActionsProps = { dos: PendingDo[]; disabled: boolean; onApprove: (pending: PendingDo) => void; onSkip: (pending: PendingDo) => void };

export function SuggestedActions({ dos, disabled, onApprove, onSkip }: SuggestedActionsProps) {
  if (dos.length === 0) return null;
  return (
    <section className="dos" aria-label="Suggested actions">
      <h3 className="lbl-h">Waiting for your approval</h3>
      {doGroups(dos).map((group) => (
        <div key={group.list} className="suggest">
          <p className="suggest-text">{group.reason}</p>
          <div className="suggest-actions">
            {group.dos.map((pending) => <Button key={pending.key} type="button" variant="outline" size="sm" disabled={disabled} onClick={() => onApprove(pending)}>Approve: {pending.label}</Button>)}
            <Button type="button" variant="ghost" size="sm" onClick={() => group.dos.forEach(onSkip)}>Hide for me</Button>
          </div>
          {group.dos.filter((pending) => pending.error !== null).map((pending) => <p key={pending.key} role="alert" className="error">{pending.label} failed last time: {pending.error}</p>)}
        </div>
      ))}
    </section>
  );
}
