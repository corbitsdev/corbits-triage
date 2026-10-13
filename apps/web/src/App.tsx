import { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { INVITE_PATH, PortalProvider, usePortal } from "./lib/portal.tsx";
import { HeldInboxProvider, useSignOutAfterSending } from "./lib/held-inbox.tsx";
import { SessionProvider, useSession } from "./lib/session.tsx";
import { UserQueryCache } from "./lib/user-cache.tsx";
import { DeniedNotice } from "./lib/denied.tsx";
import type { PortalSnapshot, WorkspaceOption } from "./lib/hub-api.ts";
import Layout from "./components/Layout.tsx";
import LoadingIndicator from "./components/LoadingIndicator.tsx";
import Connect from "./pages/Connect.tsx";
import { OtherWorkspaces } from "./components/OtherWorkspaces.tsx";
import { hasDecisionModelCredential } from "./lib/decision-models.ts";
import { useGithubSync } from "./lib/github-sync.ts";
import { AcceptInvite } from "./pages/AcceptInvite.tsx";
import { Device, DEVICE_PATH } from "./pages/Device.tsx";
import { ResetPassword } from "./pages/ResetPassword.tsx";
import { RESET_PASSWORD_PATH } from "./lib/hub-auth.ts";
import { Welcome } from "./pages/Welcome.tsx";
import Inbox from "./pages/Inbox.tsx";
import PRDetail from "./pages/PRDetail.tsx";
import Pulse from "./pages/Pulse.tsx";
import Repositories from "./pages/Repositories.tsx";
import Settings from "./pages/Settings.tsx";

function InboxRedirect() {
  return <Navigate to="/inbox" replace />;
}

function NotConfigured() {
  return (
    <div className="gate">
      <section className="onboarding centered-setup">
        <h1>Service URL not configured</h1>
        <p className="muted">Set VITE_HUB_URL to the Interchange hub URL, then reload this page.</p>
      </section>
    </div>
  );
}

function HubOutage({ message }: { message: string }) {
  return (
    <div className="gate">
      <section className="onboarding centered-setup">
        <h1>Service unavailable</h1>
        <p role="alert" className="error">
          {message}
        </p>
        <p className="muted">Check the service, then reload this page.</p>
      </section>
    </div>
  );
}

/** GitHub's Setup URL return for a workspace that is already set up (often inside the install popup). */
function GithubReturn() {
  const sync = useGithubSync(true);

  useEffect(function leaveAfterSync() {
    if (!sync.isSuccess) return;
    if (window.opener) window.close();
  }, [sync.isSuccess]);

  if (sync.denied) {
    return (
      <div className="gate">
        <section className="onboarding centered-setup">
          <p className="muted">Ask an owner or admin to finish connecting GitHub.</p>
        </section>
      </div>
    );
  }
  if (sync.error) return <HubOutage message={`Could not read your repositories from GitHub. ${sync.error.message}`} />;
  if (sync.isSuccess && !window.opener) return <Navigate to="/repositories" replace />;
  return <LoadingGate />;
}

function LoadingGate() {
  return (
    <main className="loading-gate" aria-busy="true" aria-label="Loading Corbits Triage">
      <img src="/corbits-mark.svg" width="40" height="40" alt="" />
      <div>
        <strong role="status">Loading…</strong>
      </div>
    </main>
  );
}

function DeniedGate({ snapshot }: { snapshot: PortalSnapshot }) {
  const sections: string[] = [];
  if (snapshot.denied.repos) sections.push("repositories");
  if (snapshot.denied.credentials) sections.push("credentials");
  return (
    <div className="gate">
      <section className="onboarding centered-setup" aria-label="Access denied">
        <h1>Access denied</h1>
        <p className="muted">
          You do not have access to {sections.join(" and ")}. Ask an administrator for access.
        </p>
        {sections.map((section) => (
          <DeniedNotice key={section} section={section} />
        ))}
        <OtherWorkspaces />
      </section>
    </div>
  );
}

function InvitationGate({ invitations }: { invitations: WorkspaceOption[] }) {
  const signOut = useSignOutAfterSending();
  return (
    <div className="gate">
      <section className="onboarding centered-setup" aria-label="Invitation pending">
        <h1>Invitation pending</h1>
        {invitations.map((invitation) => (
          <p key={invitation.tenantId} className="muted">
            {invitation.name} has invited you. Open the link in your invitation email to join, or ask for a new one.
          </p>
        ))}
        <button type="button" className="btn" onClick={() => void signOut()}>Sign out</button>
      </section>
    </div>
  );
}

function Gate() {
  const { configured, loading, connected, loadError, snapshot, invitations } = usePortal();
  const { ready, session } = useSession();
  const location = useLocation();
  const path = location.pathname;

  if (!configured) return <NotConfigured />;
  if (!ready) return <LoadingGate />;
  if (path.startsWith(INVITE_PATH)) return <AcceptInvite tenantId={path.slice(INVITE_PATH.length)} />;
  if (path === RESET_PASSWORD_PATH) return <ResetPassword />;
  if (!session) return <Welcome />;
  if (path === DEVICE_PATH) return <Device />;
  if (!snapshot) {
    if (invitations.length > 0) return <InvitationGate invitations={invitations} />;
    if (loading || !loadError) return <LoadingGate />;
    return <HubOutage message={loadError || "Could not reach the service."} />;
  }
  if (snapshot.denied.repos || snapshot.denied.credentials) {
    return <DeniedGate snapshot={snapshot} />;
  }
  if (!connected || !hasDecisionModelCredential(snapshot.credentials) || path === "/connect") return <Connect />;

  if (path === "/" && new URLSearchParams(location.search).has("installation_id")) return <GithubReturn />;
  if (path === "/login" || path === "/") {
    return <Navigate to={snapshot.repos.length > 0 ? "/inbox" : "/repositories"} replace />;
  }

  return (
    <Layout>
      <Routes>
        <Route path="/pulse" element={<Pulse />} />
        <Route path="/inbox" element={<Inbox view="needs-you" />} />
        <Route path="/inbox/:owner/:repo/:number" element={<Inbox view="needs-you" />} />
        <Route path="/open" element={<Inbox view="all-open" />} />
        <Route path="/open/:owner/:repo/:number" element={<Inbox view="all-open" />} />
        <Route path="/first-timers" element={<Inbox view="first-timers" />} />
        <Route path="/first-timers/:owner/:repo/:number" element={<Inbox view="first-timers" />} />
        <Route path="/triage/pr/:owner/:repo/:number" element={<PRDetail />} />
        <Route path="/triage/pr/:id" element={<PRDetail />} />
        <Route path="/prs/:owner/:repo/:number" element={<PRDetail />} />
        <Route path="/prs/:id" element={<PRDetail />} />
        <Route path="/triage/*" element={<InboxRedirect />} />
        <Route path="/queue/*" element={<InboxRedirect />} />
        <Route path="/approvals" element={<InboxRedirect />} />
        <Route path="/audit" element={<InboxRedirect />} />
        <Route path="/runs/*" element={<InboxRedirect />} />
        <Route path="/repositories/:owner?/:repo?" element={<Repositories />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/settings/:tab" element={<Settings />} />
        <Route path="/" element={<InboxRedirect />} />
        <Route path="*" element={<div className="empty">Page not found. Choose a page from the navigation.</div>} />
      </Routes>
    </Layout>
  );
}

export function AppShell() {
  return (
    <SessionProvider>
      <UserQueryCache>
        <PortalProvider>
          <HeldInboxProvider>
            <Gate />
          </HeldInboxProvider>
          <LoadingIndicator />
          <Toaster position="bottom-right" />
        </PortalProvider>
      </UserQueryCache>
    </SessionProvider>
  );
}

function createPortalQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: true,
        retry: false,
      },
    },
  });
}

export default function App() {
  const [queryClient] = useState(createPortalQueryClient);
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AppShell />
      </BrowserRouter>
    </QueryClientProvider>
  );
}
