import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { initialsOf, listCounts } from "../lib/inbox-view.ts";
import { useOpenWorkspaceAfterSending, useSignOutAfterSending } from "../lib/held-inbox.tsx";
import { useOpenItems, useOpenPullsUnanswered } from "../lib/open-pulls.ts";
import { sharesName } from "../lib/hub-api.ts";
import { usePortal } from "../lib/portal.tsx";
import { PulseProvider } from "../lib/pulse-visit.tsx";
import { triageEnabledRepos } from "../lib/repo-rows.ts";
import { useSession } from "../lib/session.tsx";
import { CheckIcon, GearIcon, InboxIcon, ListIcon, PersonIcon, PulseIcon, RepoIcon, SignOutIcon, UpDownIcon } from "./inbox-icons.tsx";

function WorkspaceItems({ close }: { close: () => void }) {
  const { snapshot } = usePortal();
  const openWorkspace = useOpenWorkspaceAfterSending();
  if (!snapshot || (snapshot.workspaces.length < 2 && snapshot.invitations.length === 0)) return null;
  const current = snapshot.workspace.tenantId;
  const options = [...snapshot.workspaces, ...snapshot.invitations];

  async function choose(tenantId: string) {
    close();
    if (tenantId !== current) await openWorkspace(tenantId);
  }

  return (
    <>
      {snapshot.workspaces.map((workspace) => (
        <button key={workspace.tenantId} type="button" role="menuitemradio" aria-checked={workspace.tenantId === current} onClick={() => void choose(workspace.tenantId)}>
          <span className="ws-option"><b>{workspace.name}</b>{sharesName(workspace, options) ? <small>{workspace.slug}</small> : null}</span>
          {workspace.tenantId === current ? <CheckIcon /> : null}
        </button>
      ))}
      {snapshot.invitations.map((invitation) => (
        <button key={invitation.tenantId} type="button" role="menuitem" disabled>
          <span className="ws-option"><b>{invitation.name}</b><small>Invited. An admin needs to let you in.</small></span>
        </button>
      ))}
      <hr />
    </>
  );
}

function UserBlock() {
  const { session } = useSession();
  const signOut = useSignOutAfterSending();
  const location = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const onSettingsOrRepos = location.pathname.startsWith("/settings") || location.pathname.startsWith("/repositories");

  useEffect(function closeOnOutsideClick() {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    }
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  if (!session) return null;

  function go(to: string) {
    setOpen(false);
    navigate(to);
  }

  return (
    <div className="menu-wrap" ref={wrapRef}>
      {open ? (
        <div className="menu up me-menu" role="menu">
          <WorkspaceItems close={() => setOpen(false)} />
          <button type="button" role="menuitem" onClick={() => go("/settings")}><GearIcon />Settings</button>
          <button type="button" role="menuitem" onClick={() => go("/repositories")}><RepoIcon />Repositories</button>
          <hr />
          <button type="button" role="menuitem" onClick={() => void signOut()}><SignOutIcon />Sign out</button>
        </div>
      ) : null}
      <button type="button" className="me" aria-haspopup="menu" aria-expanded={open} aria-current={onSettingsOrRepos ? "true" : undefined} onClick={() => setOpen(!open)}>
        <span className="av lg">{initialsOf(session.name || session.email)}</span>
        <span className="me-t"><b>{session.name || session.email}</b><span>{session.email}</span></span>
        <UpDownIcon />
      </button>
    </div>
  );
}

export default function Layout({ children }: { children: ReactNode }) {
  const location = useLocation();
  const { snapshot } = usePortal();
  const open = useOpenItems();
  const enabled = useMemo(() => triageEnabledRepos(snapshot?.repos ?? []), [snapshot]);
  const counts = useMemo(() => listCounts(open, enabled), [open, enabled]);
  const openPullsUnanswered = useOpenPullsUnanswered();
  const path = location.pathname;
  const room = path.startsWith("/settings") ? "settings" : path.startsWith("/repositories") ? "repos" : path.startsWith("/triage/pr/") ? "pr" : path.startsWith("/pulse") ? "pulse" : "inbox";
  const needsYouActive = path.startsWith("/inbox") || path.startsWith("/triage");
  const allOpenActive = path.startsWith("/open");
  const firstTimersActive = path.startsWith("/first-timers");
  // The inbox and the repositories table draw their own inset panels, so they skip the stage card.
  const ownPanels = room === "inbox" || room === "repos";

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
            <img src="/triage-logo.svg" alt="Corbits" />
            Triage
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
          <Link className="nav-a" to="/open" aria-current={allOpenActive ? "true" : undefined}>
            <ListIcon />
            All open
            {openPullsUnanswered ? null : <span className="n">{counts["all-open"]}</span>}
          </Link>
          <Link className="nav-a" to="/first-timers" aria-current={firstTimersActive ? "true" : undefined}>
            <PersonIcon />
            First-timers
            {openPullsUnanswered ? null : <span className="n">{counts["first-timers"]}</span>}
          </Link>
          <span className="grow" />
          <UserBlock />
        </nav>
        {ownPanels ? children : (
          <div className={room === "pr" ? "stage has-sliver" : "stage"} id="stage">
            {children}
          </div>
        )}
        <nav className="mobile-nav" aria-label="Mobile">
          <NavLink to="/inbox" className={needsYouActive ? "active" : undefined}>
            <InboxIcon />
            Needs you
          </NavLink>
          <NavLink to="/open" className={allOpenActive ? "active" : undefined}>
            <ListIcon />
            All open
          </NavLink>
          <NavLink to="/first-timers" className={firstTimersActive ? "active" : undefined}>
            <PersonIcon />
            First-timers
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
