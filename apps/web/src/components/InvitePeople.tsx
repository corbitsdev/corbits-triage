import { useState, type FormEvent, type ReactNode } from "react";
import { Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@corbits/react-ui";
import { skipToken, useQuery } from "@tanstack/react-query";
import { ApiError } from "@intx/hub-client";
import { errorText } from "@corbits/common";
import type { InviteSent } from "@corbits/triage-contracts";
import { isTriageRole, roleName } from "../lib/automation-grid.ts";
import { DeniedNotice } from "../lib/denied.tsx";
import { initialsOf } from "../lib/inbox-view.ts";
import { createInvitation, inviteRoles, listInvited, resendInvitation, withdrawInvitation, type HubPrincipal } from "../lib/hub-api.ts";
import { createHubTransport } from "../lib/hub-transport.ts";
import { INVITATIONS_QUERY_KEY, usePortal, useSignOutWhenRejected } from "../lib/portal.tsx";
import { usePrincipals, useRoles } from "../lib/tenant-entities.ts";

const DEFAULT_ROLE = "member";

function roleNames(person: HubPrincipal): string {
  return person.roles.map(roleName).join(", ");
}

function addressOf(person: HubPrincipal): string {
  return person.email ?? person.displayName;
}

function PeopleHeader({ first }: { first: string }) {
  return (
    <TableHeader>
      <TableRow>
        <TableHead>{first}</TableHead>
        <TableHead>Role</TableHead>
        <TableHead><span className="sr-only">Actions</span></TableHead>
      </TableRow>
    </TableHeader>
  );
}

function MemberRow({ person, you }: { person: HubPrincipal; you: boolean }) {
  const name = person.displayName || addressOf(person);
  return (
    <TableRow>
      <TableCell><span className="person"><span className="av">{initialsOf(name)}</span>{name}{you && " (you)"}</span></TableCell>
      <TableCell>{roleNames(person)}</TableCell>
      <TableCell />
    </TableRow>
  );
}

/** Active members, then the open invites passed as `children`, once the members are known. */
function PeopleTable({ you, children }: { you: string | undefined; children: ReactNode }) {
  const members = usePrincipals();
  if (members.denied) return <DeniedNotice section="people" />;
  if (members.loading || members.unavailable) return null;
  return (
    <Table>
      <PeopleHeader first="Name" />
      <TableBody>
        {members.rows.map((person) => <MemberRow key={person.id} person={person} you={person.id === you} />)}
        {children}
      </TableBody>
    </Table>
  );
}

/** The workspace's people and open invites; on the setup page only the invites, folded away. Left out for whoever may not invite. */
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
  const choices = roles.rows.filter((role) => assignableRoleIds.includes(role.id) && !isTriageRole(role));
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
    if (!tenantId || !window.confirm(`Withdraw the invite to ${addressOf(person)}? Its links stop working.`)) return;
    void act(person.id, async function withdrawInvite() {
      await withdrawInvitation(createHubTransport(), tenantId, person.id);
      notify(`Withdrew the invite to ${addressOf(person)}.`);
    });
  }

  const intro = <p>Invitees join with the role you pick through a sign-in link that works once and expires after 15 minutes.</p>;
  const notice = <>
    {error && <p role="alert" className="error">{error}</p>}
    {link && (
      <div className="hook-url">
        <code>{link.url}</code>
        <Button type="button" variant="ghost" onClick={() => void copy(link)}>Copy link</Button>
      </div>
    )}
  </>;
  const form = (
    <form className="invite" onSubmit={(event) => void invite(event)}>
      <label className="field">
        Email
        <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required disabled={readOnly || pending !== null} />
      </label>
      <label className="field">
        Role
        <select value={chosenRole} onChange={(event) => setRoleId(event.target.value)} disabled={readOnly || pending !== null}>
          {choices.map((role) => <option key={role.id} value={role.id}>{roleName(role)}</option>)}
        </select>
      </label>
      <Button type="submit" disabled={readOnly || pending !== null || !email.trim() || !chosenRole}>
        {pending === "invite" ? "Inviting…" : "Invite"}
      </Button>
    </form>
  );
  const invitedRows = invited.map((person) => (
    <TableRow key={person.id}>
      <TableCell>{onSetupPage ? addressOf(person) : <span className="person"><span className="av none">{initialsOf(addressOf(person))}</span>{addressOf(person)} (invited)</span>}</TableCell>
      <TableCell>{roleNames(person)}</TableCell>
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
  ));
  if (onSetupPage) {
    return (
      <details className="setup-help setup-invite">
        <summary>Invite people</summary>
        {intro}
        {notice}
        {form}
        {invited.length > 0 && <Table><PeopleHeader first="Invited" /><TableBody>{invitedRows}</TableBody></Table>}
      </details>
    );
  }
  return (
    <section className="sec" aria-labelledby="sec-people">
      <header>
        <h2 id="sec-people">People</h2>
        {intro}
      </header>
      <div>
        <PeopleTable you={snapshot?.workspace.principalId}>{invitedRows}</PeopleTable>
        {notice}
        {form}
      </div>
    </section>
  );
}
