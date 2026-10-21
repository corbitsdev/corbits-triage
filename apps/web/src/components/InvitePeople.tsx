import { useState, type FormEvent, type ReactNode } from "react";
import { Badge, Button, Input, Select, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@corbits/react-ui";
import { skipToken, useQuery } from "@tanstack/react-query";
import { ApiError } from "@intx/hub-client";
import { errorText } from "@corbits/common";
import type { InviteRoles, InviteSent } from "@corbits/triage-contracts";
import { isTriageRole, roleName } from "../lib/automation-grid.ts";
import { DeniedNotice } from "../lib/denied.tsx";
import { initialsOf } from "../lib/inbox-view.ts";
import { createInvitation, inviteRoles, isPerson, listInvited, markEmailVerified, resendInvitation, withdrawInvitation, type HubPrincipal } from "../lib/hub-api.ts";
import { createHubTransport } from "../lib/hub-transport.ts";
import { INVITATIONS_QUERY_KEY, usePortal, useSignOutWhenRejected } from "../lib/portal.tsx";
import { usePrincipals, useRoles } from "../lib/tenant-entities.ts";
import { CopyField } from "./CopyField.tsx";

const DEFAULT_ROLE = "member";

function roleNames(person: HubPrincipal): string {
  return person.roles.map(roleName).join(", ");
}

function addressOf(person: HubPrincipal): string {
  return person.email ?? person.displayName;
}

function domainList(domains: readonly string[]): string {
  return domains.join(" or ");
}

type SignInLimit = InviteRoles["signInLimit"];

/** Whether the hub will refuse to invite `email`. Single allowed addresses stay private, so only a domain-only allowlist can tell. */
function inviteRefused(email: string, limit: SignInLimit): boolean {
  const address = email.trim().toLowerCase();
  const at = address.lastIndexOf("@");
  if (limit === null || limit.addresses || at < 0) return false;
  return !limit.domains.includes(address.slice(at));
}

function signInLimitText(limit: SignInLimit, sendsEmail: boolean): string {
  if (limit === null) return sendsEmail ? "Any email address may be invited." : "Anyone may sign in.";
  if (limit.domains.length === 0) return "Only people on this hub's allowlist may sign in.";
  if (limit.addresses) return `Only ${domainList(limit.domains)} addresses and people on this hub's allowlist may sign in.`;
  return `Only ${domainList(limit.domains)} addresses may sign in.`;
}

function deliveryText(sendsEmail: boolean): string {
  if (sendsEmail) return "The hub emails each invitee a one-time sign-in link that works for 15 minutes.";
  return "No invite email is sent, so only people who have already signed in here can be invited. Copy the link shown after inviting and send it yourself. They sign in with Google, or with a password once their address is marked verified.";
}

function inviteBlocker(email: string, roleId: string, limit: SignInLimit): string | null {
  if (!email.trim()) return "Enter an email address to invite.";
  if (limit && inviteRefused(email, limit)) return `${email.trim()} cannot sign in here: only ${domainList(limit.domains)} addresses may.`;
  if (!roleId) return "There is no role you may invite into: you must hold every permission of a role to invite someone into it.";
  return null;
}

function PeopleHeader({ first }: { first: string }) {
  return (
    <TableHeader>
      <TableRow>
        <TableHead>{first}</TableHead>
        <TableHead>Role</TableHead>
        <TableHead>State</TableHead>
        <TableHead><span className="sr-only">Actions</span></TableHead>
      </TableRow>
    </TableHeader>
  );
}

function MemberRow({ person, you, unverified, actions }: { person: HubPrincipal; you: boolean; unverified: boolean; actions: ReactNode }) {
  const name = person.displayName || addressOf(person);
  return (
    <TableRow>
      <TableCell>
        <span className="person"><span className="av">{initialsOf(name)}</span><span>{name}{you && " (you)"}{person.email !== name && <span className="muted small-text person-email">{person.email}</span>}</span></span>
      </TableCell>
      <TableCell>{roleNames(person)}</TableCell>
      <TableCell>{unverified ? <Badge tone="warning">Email not verified</Badge> : <Badge tone="success">Active</Badge>}</TableCell>
      <TableCell>{actions}</TableCell>
    </TableRow>
  );
}

function PeopleTable({ you, unverified, actions, children }: { you: string | undefined; unverified: readonly string[]; actions: (person: HubPrincipal) => ReactNode; children: ReactNode }) {
  const members = usePrincipals();
  if (members.denied) return <DeniedNotice section="people" />;
  if (members.loading || members.unavailable) return null;
  return (
    <Table>
      <PeopleHeader first="Name" />
      <TableBody>
        {members.rows.filter(isPerson).map((person) => <MemberRow key={person.id} person={person} you={person.id === you} unverified={unverified.includes(person.id)} actions={actions(person)} />)}
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
        const [access, invited] = await Promise.all([inviteRoles(transport, tenantId), listInvited(transport, tenantId)]);
        return { ...access, invited };
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
  const { invited, assignableRoleIds, sendsEmail, signInLimit, unverifiedPrincipalIds, canMarkVerified } = query.data;
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

  function markVerified(person: HubPrincipal) {
    if (!tenantId || !window.confirm(`Mark ${addressOf(person)} verified? Do this only if you know the address is theirs.`)) return;
    void act(`verify:${person.id}`, async function verifyAddress() {
      await markEmailVerified(createHubTransport(), tenantId, person.id);
      notify(`Marked ${addressOf(person)} verified.`);
    });
  }

  function verifyButton(person: HubPrincipal) {
    if (!canMarkVerified || !unverifiedPrincipalIds.includes(person.id)) return null;
    return (
      <Button type="button" variant="ghost" disabled={readOnly || pending !== null} onClick={() => markVerified(person)}>
        {pending === `verify:${person.id}` ? "Verifying…" : "Mark verified"}
      </Button>
    );
  }

  const blocker = inviteBlocker(email, chosenRole, signInLimit);
  const intro = <p>{signInLimitText(signInLimit, sendsEmail)} {deliveryText(sendsEmail)}</p>;
  const notice = <>
    {error && <p role="alert" className="error">{error}</p>}
    {link && <CopyField label={`Invite link for ${link.email}`} value={link.url} help="Send this link to them yourself." />}
  </>;
  const form = (
    <form className="invite" onSubmit={(event) => void invite(event)}>
      <label className="field">
        Email
        <Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required disabled={readOnly || pending !== null} />
      </label>
      <label className="field">
        Role
        <Select value={chosenRole} onChange={(event) => setRoleId(event.target.value)} disabled={readOnly || pending !== null}>
          {choices.map((role) => <option key={role.id} value={role.id}>{roleName(role)}</option>)}
        </Select>
      </label>
      <Button type="submit" variant="outline" size="sm" aria-describedby="invite-blocker" disabled={readOnly || pending !== null || blocker !== null}>
        {pending === "invite" ? "Inviting…" : "Invite"}
      </Button>
      <p id="invite-blocker" className="field-help invite-blocker" aria-live="polite">{blocker}</p>
    </form>
  );
  const invitedRows = invited.map((person) => (
    <TableRow key={person.id}>
      <TableCell>{onSetupPage ? addressOf(person) : <span className="person"><span className="av none">{initialsOf(addressOf(person))}</span>{addressOf(person)}</span>}</TableCell>
      <TableCell>{roleNames(person)}</TableCell>
      <TableCell><Badge tone="warning">Invite pending</Badge></TableCell>
      <TableCell>
        {verifyButton(person)}
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
    <section className="sec" id="people" aria-labelledby="sec-people">
      <header>
        <h2 id="sec-people">People</h2>
        {intro}
      </header>
      <div>
        <PeopleTable you={snapshot?.workspace.principalId} unverified={unverifiedPrincipalIds} actions={verifyButton}>{invitedRows}</PeopleTable>
        {notice}
        {form}
      </div>
    </section>
  );
}
