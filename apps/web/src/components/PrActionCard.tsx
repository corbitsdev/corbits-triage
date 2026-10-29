import type { ReactNode } from "react";
import { Button } from "@corbits/react-ui";
import type { ActionMode } from "../lib/inbox-view.ts";
import { DO_NAMES } from "../lib/pack-prose.ts";
import { heldText } from "../lib/pane-report.ts";
import { heldOffer, type PendingDo } from "../lib/pending-dos.ts";
import { useHoldsDo } from "../lib/tenant-entities.ts";

type PrActionCardProps = {
  mode: ActionMode;
  dos: PendingDo[];
  disabled: boolean;
  /** The host's merge gate, which a held merge's button keeps. */
  canMerge: boolean;
  onApprove: (pending: PendingDo) => void;
  onSkip: (pending: PendingDo) => void;
  /** Your controls, shown unless Triage carries the pull request on its own. */
  children: ReactNode;
};

type HeldDoProps = { pending: PendingDo; disabled: boolean; canMerge: boolean; onApprove: (pending: PendingDo) => void; onSkip: (pending: PendingDo) => void };

/** A held action, with its own button only for one who may run it and only while it waits on a person rather than CI. */
function HeldDo({ pending, disabled, canMerge, onApprove, onSkip }: HeldDoProps) {
  const offer = heldOffer(pending, { holdsDo: useHoldsDo(pending.kind, pending.ref.repo), createsGrants: false, wanted: [], onPrimary: false });
  return (
    <div className="suggest">
      <h2>{heldText(pending)}</h2>
      <p className="suggest-text">{pending.reason}</p>
      {pending.error !== null ? <p role="alert" className="error">{pending.label} failed last time: {pending.error}</p> : null}
      <div className="pr-actions-row">
        {offer.doIt ? <Button type="button" disabled={disabled || (pending.kind === "merge" && !canMerge)} onClick={() => onApprove(pending)}>{DO_NAMES[pending.kind]}</Button> : null}
        <Button type="button" variant="outline" onClick={() => onSkip(pending)}>Skip</Button>
      </div>
    </div>
  );
}

/** One card for the policy's mode: what Triage did, the action waiting on you, and your controls when the next step is yours. */
export function PrActionCard({ mode, dos, disabled, canMerge, onApprove, onSkip, children }: PrActionCardProps) {
  if (mode.mode !== "waiting") {
    return (
      <section className="pr-composer" aria-label="What Triage did">
        <p className="suggest-text">{mode.did} {mode.reason}</p>
        {mode.mode === "person" ? <div className="pr-actions-row">{children}</div> : null}
      </section>
    );
  }
  return (
    <section className="pr-composer" aria-label="Waiting for you">
      {dos.length === 0 ? <p className="suggest-text">{mode.reason}</p> : dos.map((pending) => <HeldDo key={pending.key} pending={pending} disabled={disabled} canMerge={canMerge} onApprove={onApprove} onSkip={onSkip} />)}
      <div className="pr-actions-row">{children}</div>
    </section>
  );
}
