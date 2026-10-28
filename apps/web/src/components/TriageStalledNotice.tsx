import { Button } from "@corbits/react-ui";
import { Link } from "react-router-dom";
import type { DeployedVersions } from "@corbits/triage-contracts";
import { hostFullName } from "../lib/pull-link.ts";
import { useTriageStalled } from "../lib/tenant-entities.ts";

type Stalled = NonNullable<DeployedVersions["stalled"]>[number];

export function stalledText({ source, since }: Stalled): string {
  return `Pull requests on ${hostFullName(source)} have waited since ${new Date(since).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} for Triage to start.`;
}

/** Tells everyone in the workspace while its pull requests on a host wait for Triage to start. */
export function TriageStalledNotice({ stalled }: { stalled: DeployedVersions["stalled"] }) {
  // The status region stays mounted so screen readers announce the notice when it appears.
  return (
    <div role="status">
      {stalled?.map((host) => (
        <div className="triage-stalled" key={host.source}>
          <span>{stalledText(host)}</span>
          <Button asChild variant="link" size="sm"><Link to="/settings/triage">See Triage settings</Link></Button>
        </div>
      ))}
    </div>
  );
}

export default function WorkspaceStalledNotice() {
  return <TriageStalledNotice stalled={useTriageStalled()} />;
}
