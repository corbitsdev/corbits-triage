import { Button } from "@corbits/react-ui";
import { useMutation, type UseMutationResult } from "@tanstack/react-query";
import { errorText } from "@corbits/common";
import type { RepoSource } from "@corbits/triage-contracts";
import { createHubTransport } from "../../lib/hub-transport.ts";
import { usePortal } from "../../lib/portal.tsx";
import { restartListener } from "../../lib/triage-upgrade.ts";

type Restart = UseMutationResult<void, Error, void>;

/** Restarts the host's listener after one of its credentials is replaced; started once the replace has succeeded, so it never fails the replace. */
export function useRestartTriage(source: RepoSource): Restart {
  const { snapshot } = usePortal();
  return useMutation({
    async mutationFn() {
      if (!snapshot) throw new Error("The service is unavailable. Reload the page and try again.");
      await restartListener(createHubTransport(), snapshot.workspace.tenantId, source);
    },
  });
}

export function RestartFailed({ restart }: { restart: Restart }) {
  function retry() {
    restart.mutate();
  }

  if (!restart.error) return null;
  return (
    <div className="rline">
      <p role="alert" className="field-error">Saved. Restarting Triage failed; try again. {errorText(restart.error)}</p>
      <Button type="button" variant="outline" size="sm" disabled={restart.isPending} onClick={retry}>Try again</Button>
    </div>
  );
}
