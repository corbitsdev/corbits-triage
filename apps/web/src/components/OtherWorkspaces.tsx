import { useOpenWorkspaceAfterSending } from "../lib/held-inbox.tsx";
import { sharesName } from "../lib/hub-api.ts";
import { usePortal } from "../lib/portal.tsx";

export function OtherWorkspaces() {
  const { snapshot } = usePortal();
  const openWorkspace = useOpenWorkspaceAfterSending();
  if (!snapshot) return null;
  const { workspaces } = snapshot;
  const others = workspaces.filter((workspace) => workspace.tenantId !== snapshot.workspace.tenantId);
  if (others.length === 0) return null;
  return (
    <p className="other-workspaces">
      Or open
      {others.map((workspace) => (
        <button key={workspace.tenantId} type="button" className="linkish" onClick={() => void openWorkspace(workspace.tenantId)}>
          {sharesName(workspace, workspaces) ? `${workspace.name} (${workspace.slug})` : workspace.name}
        </button>
      ))}
    </p>
  );
}
