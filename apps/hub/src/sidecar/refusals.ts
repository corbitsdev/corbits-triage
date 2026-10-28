// Stock keeps why a placement was refused only while it waits for its next try, and drops the reason once the run
// ends, so the hub notes each refusal for capacity as the provisioner answers it.
import { errorText } from "@corbits/common";
import type { DestroySidecarRequest, DestroySidecarResult, EnsureSidecarRequest, EnsureSidecarResult, SidecarProvisioner, SidecarProvisionerHost } from "@intx/hub-sessions";
import { CAPACITY_UNAVAILABLE } from "./host-capacity.js";

/** Records that the run's placement was refused for capacity. */
export type RecordRefused = (tenantId: string, anchorRunId: string) => Promise<void>;

/**
 * The provisioner, recording each placement it refuses for capacity before stock reads the answer. A record that fails
 * is logged and the answer still goes to stock, which retries the placement either way.
 */
export function noteRefusals(provisioner: SidecarProvisioner, record: RecordRefused, log: (entry: Record<string, unknown>) => void): SidecarProvisioner {
  async function ensure(request: EnsureSidecarRequest): Promise<EnsureSidecarResult> {
    const result = await provisioner.ensure(request);
    if (result.kind !== "rejected" || result.code !== CAPACITY_UNAVAILABLE) return result;
    try {
      await record(request.tenantId, request.anchorRunId);
    } catch (error) {
      log({ level: "error", msg: "sidecar_refusal_unrecorded", provisionerId: provisioner.id, runId: request.anchorRunId, error: errorText(error) });
    }
    return result;
  }

  function destroy(request: DestroySidecarRequest): Promise<DestroySidecarResult> {
    return provisioner.destroy(request);
  }

  function attach(host: SidecarProvisionerHost): void {
    provisioner.attach?.(host);
  }

  const { id, apiVersion, bindingFingerprint, capabilities } = provisioner;
  return { id, apiVersion, bindingFingerprint, capabilities, attach, ensure, destroy };
}
