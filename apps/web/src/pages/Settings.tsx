import { useState, type ReactNode } from "react";
import { Badge, Button, Tabs } from "@corbits/react-ui";
import { useNavigate, useParams } from "react-router-dom";
import { errorText } from "@corbits/common";
import { DeniedNotice } from "../lib/denied.tsx";
import { runCredentialAction, uniqueSecretDisplayNames } from "../lib/credential-actions.ts";
import { githubWebhookUrl } from "../lib/github-manifest.ts";
import { useSignOutAfterSending } from "../lib/held-inbox.tsx";
import { githubAppPickerUrl, GITHUB_APP_PICKER_UNAVAILABLE, openGithubInstallation } from "../lib/github-manifest.ts";
import { currentDeployment, githubAppSlugFromCredentials, hasActiveGithubCredential, type DeployedWorkflow, type HubCredential } from "../lib/hub-api.ts";
import { usePortal } from "../lib/portal.tsx";
import { useGithubReturnSync } from "../lib/github-return-sync.ts";
import { useGithubManageAccess } from "../lib/github-sync.ts";
import { useAllowed, useDeployedWorkflows, useGrants, useRoles, type TenantSection } from "../lib/tenant-entities.ts";
import { WORKFLOW_PACKAGES } from "../lib/workflow-packages.ts";
import { useSession } from "../lib/session.tsx";
import { DecisionModelForm } from "../components/DecisionModelForm.tsx";
import AutomationGrid from "../components/AutomationGrid.tsx";
import { InvitePeople } from "../components/InvitePeople.tsx";
import { SignedInDevices } from "../components/SignedInDevices.tsx";
import { DECISION_MODEL_INTRO } from "@corbits/triage-contracts";
import { hasDecisionModelCredential } from "../lib/decision-models.ts";

const TABS = ["Triage", "GitHub", "Integrations", "Model", "Access", "Account"] as const;
type SettingsTab = (typeof TABS)[number];

function sentenceCase(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
}

function parseTab(value: string | undefined): SettingsTab {
  const match = TABS.find((tab) => tab.toLowerCase() === (value ?? "").toLowerCase());
  return match ?? "Triage";
}

type VersionRow = { name: string; version: string };

/** Each workflow's current version, then the tools those deployments carry, each once. */
function versionRows(deployments: readonly DeployedWorkflow[]): VersionRow[] {
  const current = WORKFLOW_PACKAGES.map((workflow) => ({ name: workflow.name, deployment: currentDeployment(deployments, workflow.name) }));
  const tools = new Map<string, VersionRow>();
  for (const { deployment } of current) {
    for (const tool of deployment?.tools ?? []) tools.set(`${tool.name}@${tool.version}`, tool);
  }
  const workflows = current.map(({ name, deployment }) => ({
    name,
    version: deployment ? deployment.package?.version ?? "Not from the package registry" : "Not deployed",
  }));
  return [...workflows, ...tools.values()];
}

function DeployedVersions({ section }: { section: TenantSection<DeployedWorkflow> }) {
  return (
    <section className="panel settings-panel" aria-label="Deployed versions">
      <h2>Deployed versions</h2>
      {section.denied && <DeniedNotice section="workflow deployments" />}
      {!section.denied && !section.loading && !section.unavailable && (
        <dl className="facts">
          {versionRows(section.rows).map((row) => (
            <div key={`${row.name}@${row.version}`}><dt className="mono">{row.name}</dt><dd className="mono">{row.version}</dd></div>
          ))}
        </dl>
      )}
    </section>
  );
}

function CredentialRow({
  credential,
  displayName,
  readOnly,
  replaceSecret,
  revoke,
  onError,
}: {
  credential: HubCredential;
  displayName: string;
  readOnly: boolean;
  replaceSecret: (credentialId: string, secret: string) => Promise<void>;
  revoke: (credentialId: string) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [secret, setSecret] = useState("");
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState<"rotate" | "revoke" | null>(null);
  const active = credential.status.toLowerCase() === "active";

  async function act(action: "rotate" | "revoke") {
    setPending(action);
    onError("");
    try {
      const completed = await runCredentialAction(action, credential, secret, {
        confirm: (message) => window.confirm(message),
        replaceSecret,
        revoke,
      }, displayName);
      if (completed && action === "rotate") {
        setSecret("");
        setEditing(false);
      }
    } catch (cause) {
      const message = errorText(cause);
      onError(`Could not ${action === "rotate" ? "update" : "remove"} the secret. ${message} Try again.`);
    } finally {
      setPending(null);
    }
  }

  function updateSecret() {
    if (!editing) {
      setEditing(true);
      return;
    }
    void act("rotate");
  }

  return (
    <>
      <div className="install-row">
        <strong>{displayName}</strong>
        <Badge tone={active ? "success" : "neutral"}>{sentenceCase(credential.status)}</Badge>
        <div className="row wrap">
          <Button type="button" variant="outline" aria-label={`Update secret for ${displayName}`} disabled={readOnly || pending !== null || (editing && !secret)} onClick={updateSecret}>
            {pending === "rotate" ? "Updating…" : "Update secret"}
          </Button>
          <Button type="button" variant="ghost" aria-label={`Remove ${displayName}`} disabled={readOnly || pending !== null} onClick={() => void act("revoke")}>
            {pending === "revoke" ? "Removing…" : "Remove"}
          </Button>
        </div>
      </div>
      {editing && (
        <label className="field">
          New secret
          <input type="password" value={secret} onChange={(event) => setSecret(event.target.value)} disabled={readOnly || pending !== null} autoComplete="new-password" />
        </label>
      )}
    </>
  );
}

export default function Settings() {
  const { snapshot, replaceSecret, revoke, addGrant, removeGrants, syncFromGithub, readOnly } = usePortal();
  const { session } = useSession();
  const signOut = useSignOutAfterSending();
  const params = useParams();
  const navigate = useNavigate();
  const tab = parseTab(params.tab);
  const [error, setError] = useState("");
  const repos = snapshot?.repos ?? [];
  const grants = useGrants();
  const roles = useRoles();
  const deployed = useDeployedWorkflows();
  const credentials = snapshot?.credentials ?? [];
  const secretNames = uniqueSecretDisplayNames(credentials);
  const deniedRepos = snapshot?.denied.repos ?? false;
  const deniedCredentials = snapshot?.denied.credentials ?? false;
  const modelStored = hasDecisionModelCredential(credentials);
  const githubReady = hasActiveGithubCredential(credentials);
  const canCreateGrants = useAllowed("grant:*", "create");
  const canManageGrants = useAllowed("grant:*", "manage");
  const canManageGithub = useGithubManageAccess().data === true;
  const webhookUrl = snapshot ? githubWebhookUrl(snapshot.workspace.tenantId) : "";
  async function syncAfterGithub() {
    try {
      await syncFromGithub();
    } catch (cause) {
      setError(`Could not read your repositories from GitHub. ${errorText(cause)}`);
    }
  }
  const { arm } = useGithubReturnSync(() => { void syncAfterGithub(); });

  async function chooseOnGithub() {
    if (!snapshot) return;
    setError("");
    try {
      const url = githubAppPickerUrl(githubAppSlugFromCredentials(snapshot.credentials));
      if (!url) {
        setError(githubReady ? GITHUB_APP_PICKER_UNAVAILABLE : "Save the GitHub App ID and private key first, then add repositories.");
        return;
      }
      if (!openGithubInstallation(url)) {
        setError("Your browser blocked the GitHub window. Allow popups for this page, then try again.");
      } else {
        arm();
      }
    } catch (cause) {
      setError(`Could not open GitHub. ${errorText(cause)}`);
    }
  }

  function selectTab(item: SettingsTab) {
    navigate(item === "Triage" ? "/settings" : `/settings/${item.toLowerCase()}`, { replace: true });
  }

  function settingsPanel(panel: SettingsTab): ReactNode {
    switch (panel) {
      case "Triage":
        return <DeployedVersions section={deployed} />;
      case "GitHub":
        return (
          <div className="panel settings-panel" aria-label="GitHub">
            <h2>Connected App</h2>
            <dl className="facts">
              <div><dt>Status</dt><dd>{githubReady ? "Connected" : "Not connected"}</dd></div>
              <div><dt>Installs</dt><dd>{repos.length} repositories</dd></div>
            </dl>
            <h2>Webhook</h2>
            <div className="hook-url"><code>{webhookUrl}</code></div>
            {canManageGithub && (
              <>
                <Button type="button" onClick={() => void chooseOnGithub()}>Choose repositories on GitHub</Button>
                <p className="field-help">GitHub’s installer. New repos come back here for rule setup.</p>
              </>
            )}
            {deniedRepos && <DeniedNotice section="repositories" />}
            {repos.length === 0 && !deniedRepos && <p className="muted">No repositories configured.</p>}
            {repos.map((repo) => (
              <div key={repo.name} className="install-row">
                <strong className="mono">{repo.name}</strong>
                <Badge tone={repo.connected ? "success" : "neutral"}>{repo.connected ? "Connected" : "Not connected"}</Badge>
              </div>
            ))}
          </div>
        );
      case "Integrations":
        return (
          <section className="integration">
            <h2>GitHub</h2>
            <Badge tone="success">Live</Badge>
            <p>{githubReady ? `Installed. ${repos.length} repositories.` : "Not connected yet."}</p>
          </section>
        );
      case "Model":
        return (
          <section className="panel settings-panel" aria-label="Decision model">
            <h2>Decision model</h2>
            <p className="field-help">{DECISION_MODEL_INTRO}</p>
            {deniedCredentials && <DeniedNotice section="credentials" />}
            <p className="muted small-text">{modelStored ? "API key stored. Save again to replace it." : "No decision model connected."}</p>
            <DecisionModelForm />
          </section>
        );
      case "Access":
        return (
          <>
            <InvitePeople onSetupPage={false} />
            <AutomationGrid
              roles={roles.rows}
              grants={grants.rows}
              loading={[grants, roles].some((section) => section.loading || section.unavailable)}
              denied={grants.denied || roles.denied}
              disabled={readOnly || !canCreateGrants || !canManageGrants}
              addGrant={addGrant}
              removeGrants={removeGrants}
              onError={setError}
            />
          </>
        );
      case "Account":
        return (
          <div className="panel settings-panel" aria-label="Account">
            <h2>{session?.email ?? "Signed in"}</h2>
            <p className="muted">Signed in to this app.</p>
            <Button type="button" variant="outline" onClick={() => void signOut()}>Sign out</Button>
            {tab === "Account" && <SignedInDevices />}
            {credentials.length > 0 && (
              <div>
                {credentials.map((credential) => (
                  <CredentialRow
                    key={credential.id}
                    credential={credential}
                    displayName={secretNames.get(credential.id) ?? credential.name}
                    readOnly={readOnly}
                    replaceSecret={replaceSecret}
                    revoke={revoke}
                    onError={setError}
                  />
                ))}
              </div>
            )}
          </div>
        );
    }
  }

  // Every panel stays mounted under the one tabpanel, so a half-typed key, invite or rule survives a tab switch.
  function allPanels(active: SettingsTab): ReactNode {
    return TABS.map((item) => <div key={item} hidden={item !== active}>{settingsPanel(item)}</div>);
  }

  return (
    <div className="main-shell">
      <div className="workspace">
        <header className="workspace-head">
          <div className="page-heading">
            <div>
              <h1>Settings</h1>
            </div>
          </div>
        </header>
        <main id="main" className="scroller">
          <div className="content-wide">
            {error && <p role="alert" className="error">{error}</p>}
            <Tabs className="settings-tabs" tabs={TABS.map((item) => ({ id: item, label: item }))} active={tab} onChange={selectTab} label="Settings sections">
              {allPanels}
            </Tabs>
          </div>
        </main>
      </div>
    </div>
  );
}
