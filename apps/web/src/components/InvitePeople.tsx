import { useState, type FormEvent } from "react";
import { Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@corbits/react-ui";
import { skipToken, useQuery } from "@tanstack/react-query";
import { ApiError } from "@intx/hub-client";
import { errorText } from "@corbits/common";
import type { InviteSent } from "@corbits/triage-contracts";
import { DeniedNotice } from "../lib/denied.tsx";
import { createInvitation, inviteRoles, listInvited, resendInvitation, withdrawInvitation, type HubPrincipal } from "../lib/hub-api.ts";
import { createHubTransport } from "../lib/hub-transport.ts";
import { INVITATIONS_QUERY_KEY, usePortal, useSignOutWhenRejected } from "../lib/portal.tsx";
import { useRoles } from "../lib/tenant-entities.ts";

const DEFAULT_ROLE = "member";

function roleLabel(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** On the setup page it folds away, and is left out for whoever may not invite. */
export function InvitePeople({ onSetupPage }: { onSetupPage: boolean }) {
  const { snapshot, notify, warn, refresh, readOnly } = usePortal();
  const signOutWhenRejected = useSignOutWhenRejected();
  const roles = useRoles();
  const tenantId = snapshot?.workspace.tenantId;
  const query = useQuery({
    queryKey: [INVITATIONS_QUERY_KEY, tenantId],
    queryFn: tenantId === undefined ? skipToken : async function readInvitations() {
      const transport = createHubTransport();
      try {
        const [assignableRoleIds, invited] = await Promise.all([inviteRoles(transport, tenantId), listInvited(transport, tenantId)]);
        return { assignableRoleIds, invited };
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
  const [link, setLink] = useState<{ email: string; url: string } | null>(null);

  const denied = query.error instanceof ApiError && query.error.status === 403;
  if (denied) return onSetupPage ? null : <DeniedNotice section="invites" />;
  if (!tenantId || !query.data) return null;
  const { invited, assignableRoleIds } = query.data;
  const choices = roles.rows.filter((role) => assignableRoleIds.includes(role.id));
  const chosenRole = roleId || choices.find((role) => role.name === DEFAULT_ROLE)?.id || "";

  async function act(key: string, run: () => Promise<void>) {
    setPending(key);
    setError("");
    try {
      await run();
    } catch (cause: unknown) {
      setError(errorText(cause));
    } finally {
      setPending(null);
      refresh();
    }
  }

  function sent(result: InviteSent) {
    setLink(result.link === undefined ? null : { email: result.email, url: result.link });
    if (result.emailed) notify(`Invite emailed to ${result.email}.`);
    else warn(`Invited ${result.email}. Copy the link and send it to them.`);
  }

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!tenantId) return;
    await act("invite", async function sendInvite() {
      sent(await createInvitation(createHubTransport(), tenantId, { email: email.trim(), roleId: chosenRole }));
      setEmail("");
    });
  }

  async function copy(shown: { email: string; url: string }) {
    try {
      await navigator.clipboard.writeText(shown.url);
      notify(`Link for ${shown.email} copied.`);
    } catch (cause: unknown) {
      setError(`Could not copy the link. ${errorText(cause)}`);
    }
  }

  function resend(person: HubPrincipal) {
    if (!tenantId) return;
    void act(`resend:${person.id}`, async function resendInvite() {
      sent(await resendInvitation(createHubTransport(), tenantId, person.id));
    });
  }

  function withdraw(person: HubPrincipal) {
    if (!tenantId || !window.confirm(`Withdraw the invite to ${person.email}? Its links stop working.`)) return;
    void act(person.id, async function withdrawInvite() {
      await withdrawInvitation(createHubTransport(), tenantId, person.id);
      notify(`Withdrew the invite to ${person.email}.`);
    });
  }

  const content = <>
    <p className="field-help">They join with the role you pick by opening the sign-in link sent to that email. Links work once and expire after 15 minutes; resend one if it has.</p>
    {error && <p role="alert" className="error">{error}</p>}
    {link && (
      <div className="hook-url">
        <code>{link.url}</code>
        <Button type="button" variant="ghost" onClick={() => void copy(link)}>Copy link</Button>
      </div>
    )}
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
      <Button type="submit" disabled={readOnly || pending !== null || !email.trim() || !chosenRole}>
        {pending === "invite" ? "Inviting…" : "Invite"}
      </Button>
    </form>
    {invited.length > 0 && (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Invited</TableHead>
            <TableHead>Role</TableHead>
            <TableHead><span className="sr-only">Actions</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {invited.map((person) => (
            <TableRow key={person.id}>
              <TableCell>{person.email}</TableCell>
              <TableCell>{person.roles.map((role) => roleLabel(role.name)).join(", ")}</TableCell>
              <TableCell>
                {person.roles.every((role) => assignableRoleIds.includes(role.id)) && (
                  <Button type="button" variant="ghost" disabled={readOnly || pending !== null} onClick={() => resend(person)}>
                    {pending === `resend:${person.id}` ? "Sending…" : "Resend"}
                  </Button>
                )}
                <Button type="button" variant="ghost" disabled={readOnly || pending !== null} onClick={() => withdraw(person)}>
                  {pending === person.id ? "Withdrawing…" : "Withdraw"}
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
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
