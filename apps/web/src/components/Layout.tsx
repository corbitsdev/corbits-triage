import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { Sidebar, SidebarCollapseToggle, SidebarContent, SidebarFooter, SidebarHeader, SidebarItem, SidebarSection } from "@corbits/react-ui";
import { FolderGit2, Inbox, Settings } from "lucide-react";
import { groupInbox } from "../lib/inbox-view.ts";
import { useQueueItems } from "../lib/open-pulls.ts";
import { useSession } from "../lib/session.tsx";

const COLLAPSE_KEY = "corbits.sidebarCollapsed";

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
}

/** SidebarItem's asChild cannot wrap a router Link (its Slot gets three children), so navigate on click instead. */
function RailItem({ to, active, icon, count, children }: { to: string; active: boolean; icon: ReactNode; count?: number; children: ReactNode }) {
  const navigate = useNavigate();
  function go(event: MouseEvent<HTMLAnchorElement>) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    navigate(to);
  }
  return (
    <SidebarItem href={to} active={active} icon={icon} count={count} onClick={go}>
      {children}
    </SidebarItem>
  );
}

export default function Layout({ children }: { children: ReactNode }) {
  const location = useLocation();
  const { session } = useSession();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const inboxCount = groupInbox(useQueueItems()).groups.reduce((n, group) => n + group.items.length, 0);
  const path = location.pathname;
  const room = path.startsWith("/settings") ? "settings" : path.startsWith("/repositories") ? "repos" : path.startsWith("/triage/pr/") ? "pr" : "inbox";

  useEffect(function markBody() {
    document.body.dataset.rail = collapsed ? "collapsed" : "expanded";
    document.body.dataset.room = room;
    return function unmarkBody() {
      delete document.body.dataset.rail;
      delete document.body.dataset.room;
    };
  }, [collapsed, room]);

  function toggleCollapsed() {
    setCollapsed(function flip(current) {
      const next = !current;
      try {
        window.localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        // Private browsing: keep the in-memory rail state only.
      }
      return next;
    });
  }

  const inboxActive = path.startsWith("/inbox") || path.startsWith("/triage");

  return (
    <div className={["app", collapsed ? "collapsed" : ""].filter(Boolean).join(" ")}>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <Sidebar collapsed={collapsed} aria-label="Workspace" className="rail">
        <SidebarHeader className="rail-head">
          <Link className="brand" to="/inbox">
            <img className="mark" src="/corbits-mark.svg" width="26" height="26" alt="" />
            <strong>Triage</strong>
          </Link>
          <SidebarCollapseToggle collapsed={collapsed} onToggle={toggleCollapsed} />
        </SidebarHeader>
        <SidebarContent>
          <SidebarSection label="Inbox">
            <RailItem to="/inbox" active={inboxActive} icon={<Inbox strokeWidth={1.7} aria-hidden="true" />} count={inboxCount}>
              Inbox
            </RailItem>
          </SidebarSection>
          <SidebarSection label="Workspace">
            <RailItem to="/repositories" active={path.startsWith("/repositories")} icon={<FolderGit2 strokeWidth={1.7} aria-hidden="true" />}>
              Repositories
            </RailItem>
            <RailItem to="/settings" active={path.startsWith("/settings")} icon={<Settings strokeWidth={1.7} aria-hidden="true" />}>
              Settings
            </RailItem>
          </SidebarSection>
        </SidebarContent>
        <SidebarFooter className="rail-user">
          {session ? <span className="rail-user-email">{session.email}</span> : null}
        </SidebarFooter>
      </Sidebar>
      <div className={room === "pr" ? "stage has-sliver" : "stage"} id="stage">
        {children}
      </div>
      <nav className="mobile-nav" aria-label="Mobile">
        <NavLink to="/inbox" className={inboxActive ? "active" : undefined}>
          <Inbox strokeWidth={1.7} aria-hidden="true" />
          Inbox
        </NavLink>
        <NavLink to="/repositories">
          <FolderGit2 strokeWidth={1.7} aria-hidden="true" />
          Repositories
        </NavLink>
        <NavLink to="/settings">
          <Settings strokeWidth={1.7} aria-hidden="true" />
          Settings
        </NavLink>
      </nav>
    </div>
  );
}
