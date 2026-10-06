// SPDX-License-Identifier: GPL-2.0-only
import { Fragment, useState } from "react";
import type { HubApproval } from "../lib/hub-api.ts";
import { approvalHeadline, argsText, relativeTime } from "../lib/triage-view.ts";

type Props = {
  approval: HubApproval;
  disabled?: boolean;
  onDecide: (id: string, decision: "once" | "deny") => Promise<void>;
  approveLabel?: string;
  rejectLabel?: string;
};

/** No default focus and no form: a stray Enter cannot resolve the gate. */
export function ApprovalCard({ approval, disabled, onDecide, approveLabel = "Approve", rejectLabel = "Reject" }: Props) {
  const [busy, setBusy] = useState<"once" | "deny" | null>(null);
  const [error, setError] = useState("");
  const args = argsText(approval.toolArguments);
  async function run(decision: "once" | "deny") {
    setBusy(decision);
    setError("");
    try {
      await onDecide(approval.id, decision);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(`Could not ${decision === "once" ? "approve" : "reject"} this request. ${message} Try again.`);
    } finally {
      setBusy(null);
    }
  }
  return (
    <article className="panel approval-card" aria-label={approvalHeadline(approval)}>
      <div className="approval-kicker"><span aria-hidden="true">!</span> Approval required</div>
      <h3>{approvalHeadline(approval)}</h3>
      <p className="muted small-text approval-meta">
        Requested {relativeTime(approval.createdAt)}
      </p>
      {args.length > 0 && (
        <dl className="small-text">
          {args.map(([key, value]) => (
            <Fragment key={key}>
              <dt>{key}</dt>
              <dd>{value}</dd>
            </Fragment>
          ))}
        </dl>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="row wrap approval-actions">
        <button type="button" className="small primary" disabled={disabled || busy !== null} onClick={() => void run("once")}>
          {busy === "once" ? "Approving…" : approveLabel}
        </button>
        <button type="button" className="small" disabled={disabled || busy !== null} onClick={() => void run("deny")}>
          {busy === "deny" ? "Rejecting…" : rejectLabel}
        </button>
      </div>
    </article>
  );
}
