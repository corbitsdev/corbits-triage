import { Link } from "react-router-dom";
import type { DeployedVersions } from "@corbits/triage-contracts";

export function stalledText({ since }: NonNullable<DeployedVersions["stalled"]>): string {
  return `Pull requests have waited since ${new Date(since).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} for Triage to start.`;
}

/** Tells everyone in the workspace while its pull requests wait for Triage to start. */
export function TriageStalledNotice({ stalled }: { stalled: DeployedVersions["stalled"] }) {
  // The status region stays mounted so screen readers announce the notice when it appears.
  return (
    <div role="status">
      {stalled ? (
        <div className="triage-stalled">
          <span>{stalledText(stalled)}</span>
          <Link className="linkish" to="/settings/triage">See Triage settings</Link>
        </div>
      ) : null}
    </div>
  );
}
