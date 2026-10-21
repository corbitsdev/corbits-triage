import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button, Input } from "@corbits/react-ui";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@corbits/react-ui/ui/menu";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
import { initialsOf, listCounts } from "../lib/inbox-view.ts";
import { useOpenWorkspaceAfterSending, useSignOutAfterSending } from "../lib/held-inbox.tsx";
import { useOpenItems, useOpenPullsUnanswered } from "../lib/open-pulls.ts";
import { createExtraWorkspace, sharesName } from "../lib/hub-api.ts";
import { usePortal } from "../lib/portal.tsx";
import { PulseProvider } from "../lib/pulse-visit.tsx";
import { triageEnabledRepos } from "../lib/repo-rows.ts";
import { createHubTransport } from "../lib/hub-transport.ts";
import { useSession } from "../lib/session.tsx";
import { CheckIcon, GearIcon, InboxIcon, ListIcon, MergeIcon, PulseIcon, RepoIcon, SignOutIcon, UpDownIcon } from "./inbox-icons.tsx";

function WorkspaceSwitcher() {
  const { snapshot, warn } = usePortal();
  const openWorkspace = useOpenWorkspaceAfterSending();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const create = useMutation({ mutationFn: (workspaceName: string) => createExtraWorkspace(createHubTransport(), workspaceName) });
  if (!snapshot) return null;
  const current = snapshot.workspace.tenantId;
  const options = [...snapshot.workspaces, ...snapshot.invitations];

  async function choose(tenantId: string) {
    if (tenantId !== current) await openWorkspace(tenantId);
  }

  function startNaming(event: Event) {
    event.preventDefault();
    setNaming(true);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    let tenantId: string;
    try {
      tenantId = await create.mutateAsync(name.trim());
    } catch (cause) {
      warn(`Could not create the workspace. ${cause instanceof Error ? cause.message : String(cause)}`);
      return;
    }
    try {
      await openWorkspace(tenantId);
    } catch (cause) {
      warn(`The workspace was created but could not be opened. ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  return (
    <Menu>
      <MenuTrigger asChild>
        <button type="button" className="ws" aria-label={`Workspace: ${snapshot.tenantName}`}>
          <span className="ws-name">{snapshot.tenantName}</span>
          <UpDownIcon />
        </button>
      </MenuTrigger>
      <MenuContent side="top" align="start" className="ws-menu">
        {snapshot.workspaces.map((workspace) => (
          <MenuItem key={workspace.tenantId} aria-current={workspace.tenantId === current ? "true" : undefined} onSelect={() => void choose(workspace.tenantId)}>
            <span className="ws-option"><b>{workspace.name}</b>{sharesName(workspace, options) ? <small>{workspace.slug}</small> : null}</span>
            {workspace.tenantId === current ? <CheckIcon /> : null}
          </MenuItem>
        ))}
        {snapshot.invitations.map((invitation) => (
          <MenuItem key={invitation.tenantId} disabled>
            <span className="ws-option"><b>{invitation.name}</b><small>Invited. Open your invite link to join.</small></span>
          </MenuItem>
        ))}
        <MenuSeparator />
        {naming ? (
          <form className="ws-new" onSubmit={(event) => void submit(event)} onKeyDown={(event) => event.stopPropagation()}>
            <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Workspace name" aria-label="Workspace name" autoFocus required />
            <Button type="submit" disabled={create.isPending || !name.trim()}>Create</Button>
          </form>
        ) : (
          <MenuItem onSelect={startNaming}><Plus size={16} strokeWidth={1.7} aria-hidden="true" />New workspace</MenuItem>
        )}
      </MenuContent>
    </Menu>
  );
}

function UserBlock() {
  const { session } = useSession();
  const signOut = useSignOutAfterSending();
  const location = useLocation();
  const navigate = useNavigate();
  const onSettingsOrRepos = location.pathname.startsWith("/settings") || location.pathname.startsWith("/repositories");

  if (!session) return null;

  return (
    <Menu>
      <MenuTrigger asChild>
        <button type="button" className="me" aria-current={onSettingsOrRepos ? "true" : undefined}>
          <span className="av lg">{initialsOf(session.name || session.email)}</span>
          <span className="me-t"><b>{session.name || session.email}</b><span>{session.email}</span></span>
          <UpDownIcon />
        </button>
      </MenuTrigger>
      <MenuContent side="top" align="start" className="me-menu">
        <MenuItem onSelect={() => navigate("/settings")}><GearIcon />Settings</MenuItem>
        <MenuItem onSelect={() => navigate("/repositories")}><RepoIcon />Repositories</MenuItem>
        <MenuSeparator />
        <MenuItem onSelect={() => void signOut()}><SignOutIcon />Sign out</MenuItem>
      </MenuContent>
    </Menu>
  );
}

function roomOf(path: string, pullPage: boolean) {
  if (path.startsWith("/settings")) return "settings";
  if (path.startsWith("/repositories")) return "repos";
  if (pullPage) return "pr";
  if (path.startsWith("/pulse")) return "pulse";
  return "inbox";
}

export default function Layout({ children }: { children: ReactNode }) {
  const location = useLocation();
  const { snapshot } = usePortal();
  const open = useOpenItems();
  const enabled = useMemo(() => triageEnabledRepos(snapshot?.repos ?? []), [snapshot]);
  const counts = useMemo(() => listCounts(open, enabled), [open, enabled]);
  const openPullsUnanswered = useOpenPullsUnanswered();
  const path = location.pathname;
  const pullPage = path.startsWith("/triage/pr/") || path.startsWith("/prs/");
  const room = roomOf(path, pullPage);
  const needsYouActive = path.startsWith("/inbox") || path.startsWith("/triage") || pullPage;
  const readyActive = path.startsWith("/ready");
  const allOpenActive = path.startsWith("/open");
  // The inbox and the repositories table draw their own inset panels, so they skip the stage card.
  const ownPanels = room === "inbox" || room === "repos";
  const stageClass = room === "pr" ? "stage has-sliver" : "stage";

  useEffect(function markBody() {
    document.body.dataset.room = room;
    return function unmarkBody() {
      delete document.body.dataset.room;
    };
  }, [room]);

  return (
    <PulseProvider open={open} path={path}>
      <div className="app shell">
        <a className="skip" href="#main">
          Skip to content
        </a>
        <nav className="rail" aria-label="Main">
          <Link className="brand" to="/inbox">
            <img src="/triage-logo.svg" alt="" />
            Corbits Triage
          </Link>
          <Link className="nav-a" to="/pulse" aria-current={room === "pulse" ? "true" : undefined}>
            <PulseIcon />
            Pulse
          </Link>
          <h3>Inbox</h3>
          <Link className="nav-a" to="/inbox" aria-current={needsYouActive ? "true" : undefined}>
            <InboxIcon />
            Needs you
            {openPullsUnanswered ? null : <span className="n">{counts["needs-you"]}</span>}
          </Link>
          <Link className="nav-a" to="/ready" aria-current={readyActive ? "true" : undefined}>
            <MergeIcon />
            Ready
            {openPullsUnanswered ? null : <span className="n">{counts.ready}</span>}
          </Link>
          <Link className="nav-a" to="/open" aria-current={allOpenActive ? "true" : undefined}>
            <ListIcon />
            All open
            {openPullsUnanswered ? null : <span className="n">{counts["all-open"]}</span>}
          </Link>
          <span className="grow" />
          <WorkspaceSwitcher />
          <UserBlock />
        </nav>
        {ownPanels ? children : (
          <div className={stageClass} id="stage">
            {children}
          </div>
        )}
        <nav className="mobile-nav" aria-label="Mobile">
          <NavLink to="/inbox" className={needsYouActive ? "active" : undefined}>
            <InboxIcon />
            Needs you
          </NavLink>
          <NavLink to="/ready" className={readyActive ? "active" : undefined}>
            <MergeIcon />
            Ready
          </NavLink>
          <NavLink to="/open" className={allOpenActive ? "active" : undefined}>
            <ListIcon />
            All open
          </NavLink>
          <NavLink to="/repositories">
            <RepoIcon />
            Repos
          </NavLink>
          <NavLink to="/settings">
            <GearIcon />
            Settings
          </NavLink>
        </nav>
      </div>
    </PulseProvider>
  );
}
