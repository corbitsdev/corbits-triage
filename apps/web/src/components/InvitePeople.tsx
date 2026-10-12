import { useState, type FormEvent } from "react";
import { skipToken, useQuery } from "@tanstack/react-query";
import { ApiError } from "@intx/hub-client";
import { DeniedNotice } from "../lib/denied.tsx";
import { createInvitation, listInvitations, revokeInvitation, type Invitation } from "../lib/hub-api.ts";
import { createHubTransport } from "../lib/hub-transport.ts";
import { INVITATIONS_QUERY_KEY, usePortal, useSignOutWhenRejected } from "../lib/portal.tsx";
import { useRoles } from "../lib/tenant-entities.ts";

const DEFAULT_ROLE = "member";

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function roleLabel(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** On the setup page it folds away, and is left out for whoever may not invite. */
export function InvitePeople({ onSetupPage }: { onSetupPage: boolean }) {
  const { snapshot, notify, refresh, readOnly } = usePortal();
  const signOutWhenRejected = useSignOutWhenRejected();
  const roles = useRoles();
  const tenantId = snapshot?.workspace.tenantId;
  const query = useQuery({
    queryKey: [INVITATIONS_QUERY_KEY, tenantId],
    queryFn: tenantId === undefined ? skipToken : async function readInvitations() {
      try {
        return await listInvitations(createHubTransport(), tenantId);
      } catch (cause: unknown) {
        signOutWhenRejected(cause);
        throw cause;
      }
    },
    refetchInterval: 60_000,
  });
  const [email, setEmail] = useState("");
  const [roleId, setRoleId] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");

  const denied = query.error instanceof ApiError && query.error.status === 403;
  if (denied) return onSetupPage ? null : <DeniedNotice section="invites" />;
  if (!tenantId || !query.data) return null;
  const { invitations, assignableRoleIds } = query.data;
  const choices = roles.rows.filter((role) => assignableRoleIds.includes(role.id));
  const chosenRole = roleId || choices.find((role) => role.name === DEFAULT_ROLE)?.id || "";

  async function act(key: string, run: () => Promise<void>) {
    setPending(key);
    setError("");
    try {
      await run();
    } catch (cause: unknown) {
      setError(message(cause));
    } finally {
      setPending(null);
      refresh();
    }
  }

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!tenantId) return;
    await act("invite", async function sendInvite() {
      const created = await createInvitation(createHubTransport(), tenantId, { email: email.trim(), roleId: chosenRole });
      notify(created.emailed ? `Invite emailed to ${created.email}.` : `Invited ${created.email}. Copy the link and send it to them.`);
      setEmail("");
    });
  }

  async function copy(invitation: Invitation) {
    if (invitation.link === undefined) return;
    try {
      await navigator.clipboard.writeText(invitation.link);
      notify(`Link for ${invitation.email} copied.`);
    } catch (cause: unknown) {
      setError(`Could not copy the link. ${message(cause)}`);
    }
  }

  function withdraw(invitation: Invitation) {
    if (!tenantId || !window.confirm(`Withdraw the invite to ${invitation.email}? Its link stops working.`)) return;
    void act(invitation.id, async function withdrawInvite() {
      await revokeInvitation(createHubTransport(), tenantId, invitation.id);
      notify(`Withdrew the invite to ${invitation.email}.`);
    });
  }

  const content = <>
    <p className="field-help">They join with the role you pick by opening the invite link, signed in as that email. Links expire after 7 days.</p>
    {error && <p role="alert" className="error">{error}</p>}
    <form onSubmit={(event) => void invite(event)}>
      <label className="field">
        Email
        <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required disabled={readOnly || pending !== null} />
      </label>
      <label className="field">
        Role
        <select value={chosenRole} onChange={(event) => setRoleId(event.target.value)} disabled={readOnly || pending !== null}>
          {choices.map((role) => <option key={role.id} value={role.id}>{roleLabel(role.name)}</option>)}
        </select>
      </label>
      <button type="submit" className="btn primary" disabled={readOnly || pending !== null || !email.trim() || !chosenRole}>
        {pending === "invite" ? "Inviting…" : "Invite"}
      </button>
    </form>
    {invitations.length > 0 && (
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>Invited</th>
              <th>Role</th>
              <th>Expires</th>
              <th><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {invitations.map((invitation) => (
              <tr key={invitation.id}>
                <td>{invitation.email}</td>
                <td>{roleLabel(invitation.role.name)}</td>
                <td>{new Date(invitation.expiresAt).toLocaleDateString()}</td>
                <td>
                  {invitation.link && <button type="button" className="btn ghost" onClick={() => void copy(invitation)}>Copy link</button>}
                  <button type="button" className="btn ghost" disabled={readOnly || pending !== null} onClick={() => withdraw(invitation)}>
                    {pending === invitation.id ? "Withdrawing…" : "Withdraw"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}
  </>;
  if (onSetupPage) {
    return (
      <details className="setup-help setup-invite">
        <summary>Invite people</summary>
        {content}
      </details>
    );
  }
  return (
    <section className="panel settings-panel" aria-label="Invite people">
      <h2>Invite people</h2>
      {content}
    </section>
  );
}
