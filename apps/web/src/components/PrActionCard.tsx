import type { ReactNode } from "react";
import { Button } from "@corbits/react-ui";
import type { ActionMode } from "../lib/inbox-view.ts";
import { DO_NAMES } from "../lib/pack-prose.ts";
import { heldText } from "../lib/pane-report.ts";
import type { PendingDo } from "../lib/pending-dos.ts";

type PrActionCardProps = {
  mode: ActionMode;
  dos: PendingDo[];
  disabled: boolean;
  onApprove: (pending: PendingDo) => void;
  onSkip: (pending: PendingDo) => void;
  /** Your controls, shown unless Triage carries the pull request on its own. */
  children: ReactNode;
};

/** One card for the policy's mode: what Triage did, the action waiting on you, and your controls when the next step is yours. */
export function PrActionCard({ mode, dos, disabled, onApprove, onSkip, children }: PrActionCardProps) {
  if (mode.mode !== "waiting") {
    return (
      <section className="pr-composer" aria-label="What Triage did">
        <p className="suggest-text">{mode.did} {mode.reason}</p>
        {mode.mode === "person" ? <div className="pr-actions-row">{children}</div> : null}
      </section>
    );
  }
  function heldDo(pending: PendingDo) {
    return (
      <div key={pending.key} className="suggest">
        <h2>{heldText(pending)}</h2>
        <p className="suggest-text">{pending.reason}</p>
        {pending.error !== null ? <p role="alert" className="error">{pending.label} failed last time: {pending.error}</p> : null}
        <div className="pr-actions-row">
          <Button type="button" disabled={disabled} onClick={() => onApprove(pending)}>{DO_NAMES[pending.kind]}</Button>
          <Button type="button" variant="outline" onClick={() => onSkip(pending)}>Skip</Button>
        </div>
      </div>
    );
  }

  return (
    <section className="pr-composer" aria-label="Waiting for you">
      {dos.length === 0 ? <p className="suggest-text">{mode.reason}</p> : dos.map(heldDo)}
      <div className="pr-actions-row">{children}</div>
    </section>
  );
}
