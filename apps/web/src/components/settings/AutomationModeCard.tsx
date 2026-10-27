import { useId } from "react";
import { useMutation } from "@tanstack/react-query";
import { Switch } from "@corbits/react-ui";
import { errorText } from "@corbits/common";
import { saveAutomationMode, type PortalSnapshot } from "../../lib/hub-api.ts";
import { createHubTransport } from "../../lib/hub-transport.ts";
import { usePortal } from "../../lib/portal.tsx";
import { useAllowed } from "../../lib/tenant-entities.ts";

const LABEL = "Take the actions each policy file names without asking";

/** Whether each enabled repository's policy file decides what Triage does on its own, or only posting the verdict does. */
export function AutomationModeCard({ snapshot }: { snapshot: PortalSnapshot }) {
  const { readOnly, notify, refresh } = usePortal();
  const switchId = useId();
  const { tenantId } = snapshot.workspace;
  const canManage = useAllowed(`tenant:${tenantId}`, "manage");
  const fromPolicy = snapshot.config?.automation !== "ask";
  const save = useMutation({
    mutationFn: function saveMode(next: boolean) {
      return saveAutomationMode(createHubTransport(), tenantId, next ? "policy" : "ask");
    },
    onSuccess: function announce(_saved, next) {
      notify(next ? "Triage takes the actions each policy file names." : "Triage asks before anything but its verdict.");
      refresh();
    },
  });
  const help = fromPolicy
    ? "Triage takes every action a repository's policy file names on its own. Closing on Unsure, and merging on anything but Pass, still wait for you."
    : "Triage posts its verdict on its own. Every other action waits for you on Triage, and a policy pull request lists the actions that will.";

  return (
    <div className="gcard source" aria-labelledby="triage-automation" role="group">
      <header>
        <b id="triage-automation">Actions Triage takes on its own</b>
        <span>{help}</span>
      </header>
      {canManage && (
        <div className="source-body">
          <div className="switch-card">
            <div className="sc-t">
              <label htmlFor={switchId}>{LABEL}</label>
            </div>
            <Switch id={switchId} className="sw lg" checked={fromPolicy} onCheckedChange={(next) => save.mutate(next)} label={LABEL} disabled={readOnly || save.isPending} />
          </div>
          {save.isError ? <p role="alert" className="error">Could not save. {errorText(save.error)}</p> : null}
        </div>
      )}
    </div>
  );
}
