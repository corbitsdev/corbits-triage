import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { inboxAction, initialsOf } from "../lib/inbox-view.ts";
import { useQueueItems } from "../lib/open-pulls.ts";
import { useSession } from "../lib/session.tsx";
import { GearIcon, InboxIcon, RepoIcon, SignOutIcon, UpDownIcon } from "./inbox-icons.tsx";

function UserBlock() {
  const { session, signOut } = useSession();
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
  const inboxCount = useQueueItems().filter((item) => inboxAction(item) !== null).length;
  const path = location.pathname;
  const room = path.startsWith("/settings") ? "settings" : path.startsWith("/repositories") ? "repos" : path.startsWith("/triage/pr/") ? "pr" : "inbox";
  const inboxActive = path.startsWith("/inbox") || path.startsWith("/triage");
  // The inbox and the repositories table draw their own inset panels, so they skip the stage card.
  const ownPanels = room === "inbox" || room === "repos";

  useEffect(function markBody() {
    document.body.dataset.room = room;
    return function unmarkBody() {
      delete document.body.dataset.room;
    };
  }, [room]);

  return (
    <div className="app shell">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <nav className="rail" aria-label="Main">
        <Link className="brand" to="/inbox">
          <img src="/triage-logo.svg" alt="Corbits" />
          Triage
        </Link>
        <h3>Inbox</h3>
        <Link className="nav-a" to="/inbox" aria-current={inboxActive ? "true" : undefined}>
          <InboxIcon />
          Inbox
          <span className="n">{inboxCount}</span>
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
        <NavLink to="/inbox" className={inboxActive ? "active" : undefined}>
          <InboxIcon />
          Inbox
        </NavLink>
        <NavLink to="/repositories">
          <RepoIcon />
          Repositories
        </NavLink>
        <NavLink to="/settings">
          <GearIcon />
          Settings
        </NavLink>
      </nav>
    </div>
  );
}
