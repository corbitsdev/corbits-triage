import { useState } from "react";
import type { RepoRecord } from "../../lib/hub-api.ts";
import { usePortal } from "../../lib/portal.tsx";
import { useAllowed, useGrants, useRoles } from "../../lib/tenant-entities.ts";
import ApproverGrid from "../ApproverGrid.tsx";
import { InvitePeople } from "../InvitePeople.tsx";
import TriageOnItsOwn from "../TriageOnItsOwn.tsx";

export function AccessSection({ repos }: { repos: RepoRecord[] }) {
  const { addGrant, removeGrants, readOnly } = usePortal();
  const [error, setError] = useState("");
  const grants = useGrants();
  const roles = useRoles();
  const canCreateGrants = useAllowed("grant:*", "create");
  const canManageGrants = useAllowed("grant:*", "manage");
  const grantProps = {
    roles: roles.rows,
    repos: repos.map((repo) => repo.name),
    grants: grants.rows,
    loading: [grants, roles].some((section) => section.loading || section.unavailable),
    denied: grants.denied || roles.denied,
    disabled: readOnly || !canCreateGrants || !canManageGrants,
    addGrant,
    removeGrants,
    onError: setError,
  };
  return (
    <section id="access" aria-labelledby="sec-access">
      <h2 id="sec-access" className="sr-only">Access</h2>
      {error && <p role="alert" className="error">{error}</p>}
      <InvitePeople onSetupPage={false} />
      <ApproverGrid {...grantProps} />
      <TriageOnItsOwn {...grantProps} repos={repos} />
    </section>
  );
}
