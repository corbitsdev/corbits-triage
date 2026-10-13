import { useLayoutEffect, useRef } from "react";
import { BUILT_IN_CHECK_NAMES, type CheckRef, type TriageStats } from "@corbits/triage-contracts";
import type { RepoDraft } from "../../lib/pack-draft.ts";
import { checkName, evaluationOf, isCatalogId } from "../../lib/pack-prose.ts";
import EvalBadge from "./EvalBadge.tsx";

const METHOD = { rule: "Computed from GitHub.", model: "Answered from the diff, citing files and lines." };

export type CheckPopoverProps = { id: CheckRef; draft: RepoDraft; stats: TriageStats | undefined; onClose: () => void };

/** How a check is evaluated and how it did this week; its values are edited in the Checks sections. */
export default function CheckPopover({ id, draft, stats, onClose }: CheckPopoverProps) {
  const pack = draft.pack;
  const ref = useRef<HTMLDivElement>(null);

  // Anchored to a name inside wrapped prose, so it shifts left when it would run past the panel's edge.
  useLayoutEffect(function stayInPanel() {
    const pop = ref.current;
    const pane = pop?.closest(".pane-in");
    if (!pop || !pane) return;
    const edge = pane.getBoundingClientRect().right - parseFloat(getComputedStyle(pane).paddingRight);
    const over = pop.getBoundingClientRect().right - edge;
    if (over > 0) pop.style.left = `${-over}px`;
  }, []);

  function jump() {
    document.getElementById(isCatalogId(id) ? "rp-checks" : `rp-custom-${id}`)?.scrollIntoView({ block: "start", behavior: "smooth" });
    onClose();
  }

  const evaluation = evaluationOf(pack, id);
  const ran = stats?.checks[id];
  const runs = ran ? ran.pass + ran.fail + ran.unconfirmed : 0;
  return (
    <div className="pop check-pop" ref={ref} role="dialog" aria-label={checkName(pack, id)}>
      <div className="pop-h"><b>{checkName(pack, id)}</b><EvalBadge evaluation={evaluation} /></div>
      <p className="hint">{METHOD[evaluation]}</p>
      {ran && runs > 0 ? <p className="hint">Passed {ran.pass} of {runs} this week</p> : null}
      {!BUILT_IN_CHECK_NAMES.has(id) && <button type="button" className="linkish" onClick={jump}>Change it in Checks</button>}
    </div>
  );
}
