import { useEffect, useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { ChevronLeft, ChevronRight, FolderGit2, GitMerge, Inbox, List, Settings } from "lucide-react";
import { usePortal } from "../lib/portal.tsx";
import { projectQueue } from "../lib/hub-api.ts";

const COLLAPSE_KEY = "corbits.sidebarCollapsed";

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
}

function productNotice(message: string): string {
  const lower = message.toLowerCase();
  if (
    lower.includes("offline fallback") ||
    lower.includes("hub not connected") ||
    lower.includes("hub connected")
  ) {
    return "";
  }
  return message;
}

export default function Layout({ children }: { children: ReactNode }) {
  const { snapshot, status } = usePortal();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const items = snapshot ? projectQueue(snapshot) : [];
  const actionCount = items.filter((item) => item.needsHuman).length;
  const mergeCount = items.filter((item) => item.state === "ready").length;
  const notice = productNotice(status);
  const path = location.pathname;
  const isPr = path.startsWith("/triage/pr/");
  const room = path.startsWith("/settings")
    ? "settings"
    : path.startsWith("/repositories")
      ? "repos"
      : isPr
        ? "pr"
        : "triage";

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

  const triageActive = path.startsWith("/triage");

  return (
    <div className={["app", collapsed ? "collapsed" : ""].filter(Boolean).join(" ")}>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <aside className="sidebar" aria-label="Workspace">
        <div className="brand">
          <img className="mark" src="/corbits-mark.svg" width="28" height="28" alt="" />
          <strong>corbits</strong>
          <button
            type="button"
            className="rail-toggle"
            aria-expanded={!collapsed}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={toggleCollapsed}
          >
            {collapsed ? <ChevronRight strokeWidth={1.7} aria-hidden="true" /> : <ChevronLeft strokeWidth={1.7} aria-hidden="true" />}
          </button>
        </div>
        <nav className="sidebar-nav" aria-label="Primary">
          <div className="nav-section">
            <p className="nav-section-label" id="nav-triage-label">Triage</p>
            <div className="nav-sub" role="group" aria-labelledby="nav-triage-label">
              <NavLink to="/triage/action" title="Requires Action" className={({ isActive }) => `nav-item sub${isActive || (triageActive && path === "/triage") ? " is-on" : ""}`}>
                <Inbox strokeWidth={1.7} aria-hidden="true" />
                <span className="nav-label">Requires Action</span>
                <span className="nav-count">{actionCount}</span>
              </NavLink>
              <NavLink to="/triage/merge" title="Ready to Merge" className={({ isActive }) => `nav-item sub${isActive ? " is-on" : ""}`}>
                <GitMerge strokeWidth={1.7} aria-hidden="true" />
                <span className="nav-label">Ready to Merge</span>
                <span className="nav-count quiet">{mergeCount}</span>
              </NavLink>
              <NavLink to="/triage/all" title="All PRs" className={({ isActive }) => `nav-item sub${isActive ? " is-on" : ""}`}>
                <List strokeWidth={1.7} aria-hidden="true" />
                <span className="nav-label">All PRs</span>
                <span className="nav-count quiet">{items.length}</span>
              </NavLink>
            </div>
          </div>
          <NavLink to="/repositories" title="Repositories" className={({ isActive }) => `nav-item${isActive ? " is-on" : ""}`}>
            <FolderGit2 strokeWidth={1.7} aria-hidden="true" />
            <span className="nav-label">Repositories</span>
          </NavLink>
        </nav>
        <div className="sidebar-footer">
          <NavLink to="/settings" title="Settings" className={({ isActive }) => `nav-item${isActive ? " is-on" : ""}`}>
            <Settings strokeWidth={1.7} aria-hidden="true" />
            <span className="nav-label">Settings</span>
          </NavLink>
        </div>
      </aside>
      <div className={isPr ? "stage has-sliver" : "stage"} id="stage">
        {children}
      </div>
      <nav className="mobile-nav" aria-label="Mobile">
        <NavLink to="/triage/action" className={triageActive ? "active" : undefined}>
          <Inbox strokeWidth={1.7} aria-hidden="true" />
          Triage
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
      {notice ? (
        <div className="toast" role="status">
          {notice}
        </div>
      ) : null}
    </div>
  );
}
