import { useEffect, useState } from "react";
import { Button } from "@corbits/react-ui";
import { QueryClient, QueryClientProvider, useMutation } from "@tanstack/react-query";
import { Toaster } from "@corbits/react-ui/ui/toast";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { INVITE_PATH, PortalProvider, usePortal } from "./lib/portal.tsx";
import { HeldInboxProvider, useSignOutAfterSending } from "./lib/held-inbox.tsx";
import { SessionProvider, useSession } from "./lib/session.tsx";
import { UserQueryCache } from "./lib/user-cache.tsx";
import type { PortalSnapshot, WorkspaceOption } from "./lib/hub-api.ts";
import Layout from "./components/Layout.tsx";
import LoadingIndicator from "./components/LoadingIndicator.tsx";
import NewerPortalNotice from "./components/NewerPortalNotice.tsx";
import WorkspaceStalledNotice from "./components/TriageStalledNotice.tsx";
import Connect from "./pages/Connect.tsx";
import { OtherWorkspaces } from "./components/OtherWorkspaces.tsx";
import { SignInShell } from "./components/SignInShell.tsx";
import { useGithubSync } from "./lib/github-sync.ts";
import { AcceptInvite } from "./pages/AcceptInvite.tsx";
import { Device, DEVICE_PATH } from "./pages/Device.tsx";
import { ResetPassword } from "./pages/ResetPassword.tsx";
import { RESET_PASSWORD_PATH } from "./lib/hub-auth.ts";
import { VerifyEmail } from "./pages/VerifyEmail.tsx";
import { Welcome } from "./pages/Welcome.tsx";
import Audit from "./pages/Audit.tsx";
import Inbox from "./pages/Inbox.tsx";
import PRDetail from "./pages/PRDetail.tsx";
import Repositories from "./pages/Repositories.tsx";
import Settings from "./pages/Settings.tsx";
import { legacyTriageTarget } from "./lib/inbox-view.ts";

function LegacyListRedirect() {
  const { pathname, search } = useLocation();
  return <Navigate to={legacyTriageTarget(pathname, search) ?? "/"} replace />;
}

function TriageRedirect() {
  return <Navigate to="/" replace />;
}

function NotConfigured() {
  return (
    <SignInShell>
      <div className="signin-head">
        <h1>Service URL not configured</h1>
        <p>Set VITE_HUB_URL to the Interchange hub URL, then reload this page.</p>
      </div>
    </SignInShell>
  );
}

function HubOutage({ message }: { message: string }) {
  return (
    <SignInShell>
      <div className="signin-head">
        <h1>Service unavailable</h1>
        <p>Check the service, then reload this page.</p>
      </div>
      <p role="alert" className="field-error">{message}</p>
    </SignInShell>
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
      <SignInShell>
        <div className="signin-head">
          <h1>Only an owner or admin can finish this</h1>
          <p>Your role cannot connect GitHub to this workspace. Ask an owner or admin to finish connecting it.</p>
        </div>
      </SignInShell>
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
  const signOut = useSignOutAfterSending();
  const sections: string[] = [];
  if (snapshot.denied.repos) sections.push("repositories");
  if (snapshot.denied.credentials) sections.push("credentials");
  if (snapshot.denied.models) sections.push("models");
  return (
    <SignInShell>
      <div className="signin-head">
        <h1>Access denied</h1>
        <p>You do not have access to {sections.join(" and ")}. Ask an administrator for access.</p>
      </div>
      <OtherWorkspaces />
      <Button type="button" variant="outline" size="lg" onClick={() => void signOut()}>Sign out</Button>
    </SignInShell>
  );
}

function KeysUnreadNotice({ message }: { message: string }) {
  const { refreshNow } = usePortal();
  const retry = useMutation({ mutationFn: refreshNow });
  return (
    <main className="page-notice" id="main">
      <p>Couldn't read your workspace's keys.</p>
      <p role="alert" className="field-error">{message}</p>
      <Button type="button" variant="outline" size="sm" disabled={retry.isPending} onClick={() => retry.mutate()}>{retry.isPending ? "Trying again…" : "Try again"}</Button>
    </main>
  );
}

function InvitationGate({ invitations }: { invitations: WorkspaceOption[] }) {
  const signOut = useSignOutAfterSending();
  return (
    <SignInShell>
      <div className="signin-head">
        <h1>Invitation pending</h1>
        {invitations.map((invitation) => (
          <p key={invitation.tenantId}><b>{invitation.name}</b> invited you. Open the invite link you were sent to join, or ask for a new one.</p>
        ))}
      </div>
      <Button type="button" variant="outline" size="lg" onClick={() => void signOut()}>Sign out</Button>
    </SignInShell>
  );
}

function Gate() {
  const { configured, loading, connected, loadError, snapshot, invitations, unverified } = usePortal();
  const { ready, session } = useSession();
  const location = useLocation();
  const path = location.pathname;

  if (!configured) return <NotConfigured />;
  if (!ready) return <LoadingGate />;
  // A refusal or a join in flight belongs to whoever was signed in; the next person starts over.
  if (path.startsWith(INVITE_PATH)) return <AcceptInvite key={session?.id} tenantId={path.slice(INVITE_PATH.length)} />;
  if (path === RESET_PASSWORD_PATH) return <ResetPassword />;
  if (!session) return <Welcome />;
  if (unverified) return <VerifyEmail email={session.email} />;
  if (path === DEVICE_PATH) return <Device />;
  if (!snapshot) {
    if (invitations.length > 0) return <InvitationGate invitations={invitations} />;
    if (loading || !loadError) return <LoadingGate />;
    return <HubOutage message={loadError || "Could not reach the service."} />;
  }
  if (snapshot.denied.repos || snapshot.denied.credentials || snapshot.denied.models) {
    return <DeniedGate snapshot={snapshot} />;
  }
  // Without the keys, whether the workspace is connected is unknown, so it is never sent back to onboarding.
  if (snapshot.credentialsError) return <Layout><KeysUnreadNotice message={snapshot.credentialsError} /></Layout>;
  if (!connected || path === "/connect") return <Connect />;

  if (path === "/" && new URLSearchParams(location.search).has("installation_id")) return <GithubReturn />;
  if (path === "/" || path === "/login") {
    if (snapshot.repos.length === 0) return <Navigate to="/repositories" replace />;
    if (path === "/login") return <Navigate to="/" replace />;
  }

  return (
    <Layout>
      <Routes>
        <Route path="/pulse" element={<LegacyListRedirect />} />
        <Route path="/inbox" element={<LegacyListRedirect />} />
        <Route path="/inbox/:owner/:repo/:number" element={<LegacyListRedirect />} />
        <Route path="/ready" element={<LegacyListRedirect />} />
        <Route path="/ready/:owner/:repo/:number" element={<LegacyListRedirect />} />
        <Route path="/open" element={<LegacyListRedirect />} />
        <Route path="/open/:owner/:repo/:number" element={<LegacyListRedirect />} />
        <Route path="/triage/pr/:owner/:repo/:number" element={<PRDetail />} />
        <Route path="/triage/pr/:id" element={<PRDetail />} />
        <Route path="/prs/:owner/:repo/:number" element={<PRDetail />} />
        <Route path="/prs/:id" element={<PRDetail />} />
        <Route path="/triage/*" element={<TriageRedirect />} />
        <Route path="/queue/*" element={<TriageRedirect />} />
        <Route path="/approvals" element={<TriageRedirect />} />
        <Route path="/audit" element={<Audit />} />
        <Route path="/runs/*" element={<TriageRedirect />} />
        <Route path="/repositories/:owner?/:repo?" element={<Repositories />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/settings/:tab" element={<Settings />} />
        <Route path="/" element={<Inbox />} />
        <Route path="/pr/:owner/:repo/:number" element={<Inbox />} />
        <Route path="*" element={<div className="empty">Page not found. Choose a page from the navigation.</div>} />
      </Routes>
    </Layout>
  );
}

function AppShell() {
  return (
    <SessionProvider>
      <UserQueryCache>
        <PortalProvider>
          <HeldInboxProvider>
            <Gate />
          </HeldInboxProvider>
          <LoadingIndicator />
          <div className="notices">
            <NewerPortalNotice />
            <WorkspaceStalledNotice />
          </div>
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
