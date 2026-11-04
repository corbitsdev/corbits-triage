import { Link } from "react-router-dom";
import { counted } from "@corbits/common";
import type { DeployedVersions } from "@corbits/triage-contracts";
import { hostFullName } from "../lib/pull-link.ts";
import { useTriageStalled } from "../lib/tenant-entities.ts";

type Stalled = NonNullable<DeployedVersions["stalled"]>[number];

function waitingSubject({ source, pull, count }: Stalled): string {
  const host = hostFullName(source);
  if (pull === undefined) return `Pull requests on ${host} have`;
  if (count !== undefined && count > 1) return `${pull} and ${counted(count - 1, "other pull request", "other pull requests")} on ${host} have`;
  return `${pull} on ${host} has`;
}

function reasonTail(reason: string | undefined): string {
  if (reason === undefined) return ".";
  return reason.endsWith(".") ? `: ${reason}` : `: ${reason}.`;
}

export function stalledText(stalled: Stalled): string {
  const at = new Date(stalled.since).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `${waitingSubject(stalled)} waited since ${at} for Triage to start${reasonTail(stalled.reason)}`;
}

/** Tells everyone in the workspace while its pull requests on a host wait for Triage to start. */
export function TriageStalledNotice({ stalled }: { stalled: DeployedVersions["stalled"] }) {
  // The status region stays mounted so screen readers announce the notice when it appears.
  return (
    <div role="status">
      {stalled?.map((host) => (
        <div className="triage-stalled" key={host.source}>
          <span>{stalledText(host)}</span>
          <Link className="linkish" to="/settings/triage">See Triage settings</Link>
        </div>
      ))}
    </div>
  );
}

export default function WorkspaceStalledNotice() {
  return <TriageStalledNotice stalled={useTriageStalled()} />;
}
