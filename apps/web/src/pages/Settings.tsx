import { useState, type FormEvent, type ReactNode } from "react";
import { Badge, Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Tabs } from "@corbits/react-ui";
import { useNavigate, useParams } from "react-router-dom";
import { errorText } from "@corbits/common";
import { DeniedNotice } from "../lib/denied.tsx";
import { runCredentialAction, uniqueSecretDisplayNames } from "../lib/credential-actions.ts";
import {
  accessWhoOptions,
  canRemoveGrant,
  grantCreateInputFromForm,
  grantWhoLabel,
  parseGrantEffect,
  type GrantEffect,
} from "../lib/grant-actions.ts";
import { githubWebhookUrl } from "../lib/github-manifest.ts";
import { useSignOutAfterSending } from "../lib/held-inbox.tsx";
import { githubAppPickerUrl, GITHUB_APP_PICKER_UNAVAILABLE, openGithubInstallation } from "../lib/github-manifest.ts";
import { describePermission, permissionCatalog, type Permission } from "../lib/permissions.ts";
import { activeGithubCredential, currentDeployment, githubAppSlugFromCredentials, hasActiveGithubCredential, type DeployedWorkflow, type HubCredential, type HubGrant, type HubPrincipal, type HubRole } from "../lib/hub-api.ts";
import { usePortal } from "../lib/portal.tsx";
import { useGithubReturnSync } from "../lib/github-return-sync.ts";
import { useGithubManageAccess } from "../lib/github-sync.ts";
import { useAllowed, useDeployedWorkflows, useGrants, usePrincipals, useRoles, type TenantSection } from "../lib/tenant-entities.ts";
import { WORKFLOW_PACKAGES } from "../lib/workflow-packages.ts";
import { useSession } from "../lib/session.tsx";
import { DecisionModelForm } from "../components/DecisionModelForm.tsx";
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

function GrantRow({
  grant,
  who,
  permission,
  readOnly,
  pending,
  onRemove,
}: {
  grant: HubGrant;
  who: string;
  permission: { label: string; resource?: string };
  readOnly: boolean;
  pending: boolean;
  onRemove: () => Promise<void>;
}) {
  return (
    <TableRow>
      <TableCell>{who}</TableCell>
      <TableCell>
        {permission.label}
        {permission.resource && <span className="mono muted small-text"> {permission.resource}</span>}
      </TableCell>
      <TableCell>{sentenceCase(grant.effect)}</TableCell>
      <TableCell>
        {canRemoveGrant(grant) ? (
          <Button type="button" variant="ghost" disabled={readOnly || pending} onClick={() => void onRemove()}>
            {pending ? "Removing…" : "Remove"}
          </Button>
        ) : (
          <span className="muted small-text">Built-in</span>
        )}
      </TableCell>
    </TableRow>
  );
}

const OTHER_PERMISSION = "other";

function AccessRules({
  grants,
  people,
  roles,
  permissions,
  loading,
  denied,
  readOnly,
  canAdd,
  canRemove,
  addGrant,
  removeGrant,
  onError,
}: {
  grants: HubGrant[];
  people: HubPrincipal[];
  roles: HubRole[];
  permissions: Permission[];
  loading: boolean;
  denied: boolean;
  readOnly: boolean;
  canAdd: boolean;
  canRemove: boolean;
  addGrant: (input: ReturnType<typeof grantCreateInputFromForm>) => Promise<void>;
  removeGrant: (grant: HubGrant) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [who, setWho] = useState("");
  const [permissionIndex, setPermissionIndex] = useState("");
  const [resource, setResource] = useState("");
  const [action, setAction] = useState("");
  const [effect, setEffect] = useState<GrantEffect>("allow");
  const [adding, setAdding] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const other = permissionIndex === OTHER_PERMISSION;
  const locked = readOnly || adding || !canAdd;
  const whoOptions = accessWhoOptions(people, roles);
  const peopleOptions = whoOptions.filter((option) => option.group === "People");
  const roleOptions = whoOptions.filter((option) => option.group === "Roles");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAdding(true);
    onError("");
    try {
      const permission = other ? { resource, action } : permissions[Number(permissionIndex)];
      if (!permission) throw new Error("Choose what they may do.");
      await addGrant(grantCreateInputFromForm({ who, resource: permission.resource, action: permission.action, effect }));
      setWho("");
      setPermissionIndex("");
      setResource("");
      setAction("");
      setEffect("allow");
    } catch (cause) {
      const detail = errorText(cause);
      onError(`Could not add the access rule. ${detail} Try again.`);
    } finally {
      setAdding(false);
    }
  }

  async function remove(grant: HubGrant) {
    if (!window.confirm("Remove this access rule? The person or role will lose this permission.")) return;
    setRemovingId(grant.id);
    onError("");
    try {
      await removeGrant(grant);
    } catch (cause) {
      const detail = errorText(cause);
      onError(`Could not remove the access rule. ${detail} Try again.`);
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <div className="panel settings-panel" aria-label="Access rules">
      <h2>Access rules</h2>
      <p className="field-help">What each person or role may do in this app. This is not who reviews pull requests on GitHub.</p>
      {denied && <DeniedNotice section="access rules" />}
      {!denied && !loading && grants.length === 0 && <p className="muted">No access rules.</p>}
      {!denied && grants.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Who</TableHead>
              <TableHead>Permission</TableHead>
              <TableHead>Effect</TableHead>
              <TableHead><span className="sr-only">Actions</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {grants.map((grant) => (
              <GrantRow
                key={grant.id}
                grant={grant}
                who={grantWhoLabel(grant, people, roles)}
                permission={describePermission(grant, permissions)}
                readOnly={readOnly || !canRemove}
                pending={removingId === grant.id}
                onRemove={() => remove(grant)}
              />
            ))}
          </TableBody>
        </Table>
      )}
      {!denied && (
        <form onSubmit={(event) => void submit(event)}>
          <label className="field">
            Who
            <span className="field-help">Person or role this rule applies to.</span>
            <select value={who} onChange={(event) => setWho(event.target.value)} disabled={locked}>
              <option value="">Select…</option>
              {peopleOptions.length > 0 && (
                <optgroup label="People">
                  {peopleOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </optgroup>
              )}
              {roleOptions.length > 0 && (
                <optgroup label="Roles">
                  {roleOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </optgroup>
              )}
            </select>
          </label>
          <label className="field">
            They may
            <select value={permissionIndex} onChange={(event) => setPermissionIndex(event.target.value)} disabled={locked}>
              <option value="">Select…</option>
              {permissions.map((permission, index) => <option key={permission.label} value={String(index)}>{permission.label}</option>)}
              <option value={OTHER_PERMISSION}>Other…</option>
            </select>
          </label>
          {other && (
            <>
              <label className="field">
                Action
                <span className="field-help">What they may do, such as read, create, manage or use.</span>
                <input value={action} onChange={(event) => setAction(event.target.value)} disabled={locked} />
              </label>
              <label className="field">
                Resource
                <span className="field-help">What this rule applies to, such as credential:… or tool:*.</span>
                <input value={resource} onChange={(event) => setResource(event.target.value)} disabled={locked} />
              </label>
            </>
          )}
          <label className="field">
            Effect
            <select value={effect} onChange={(event) => setEffect(parseGrantEffect(event.target.value))} disabled={locked}>
              <option value="allow">Allow</option>
              <option value="ask">Ask</option>
              <option value="deny">Deny</option>
            </select>
          </label>
          <Button type="submit" disabled={locked || !who || !permissionIndex || (other && (!resource.trim() || !action.trim()))}>
            {adding ? "Adding…" : "Add rule"}
          </Button>
        </form>
      )}
    </div>
  );
}

function RoleRow({
  role,
  readOnly,
  renameRole,
  removeRole,
  onError,
}: {
  role: HubRole;
  readOnly: boolean;
  renameRole: (role: HubRole, name: string) => Promise<void>;
  removeRole: (role: HubRole) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (name === null) return;
    setPending(true);
    onError("");
    try {
      await renameRole(role, name.trim());
      setName(null);
    } catch (cause) {
      onError(`Could not rename the role. ${errorText(cause)} Try again.`);
    } finally {
      setPending(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Remove the ${role.name} role and its access rules?`)) return;
    setPending(true);
    onError("");
    try {
      await removeRole(role);
    } catch (cause) {
      onError(`Could not remove the role. ${errorText(cause)} Try again.`);
      setPending(false);
    }
  }

  if (name !== null) {
    return (
      <TableRow>
        <TableCell colSpan={2}>
          <form className="row wrap" onSubmit={(event) => void save(event)}>
            <input aria-label="Role name" value={name} onChange={(event) => setName(event.target.value)} disabled={pending} autoFocus />
            <Button type="submit" disabled={pending || !name.trim()}>{pending ? "Saving…" : "Save"}</Button>
            <Button type="button" variant="ghost" disabled={pending} onClick={() => setName(null)}>Cancel</Button>
          </form>
        </TableCell>
      </TableRow>
    );
  }
  return (
    <TableRow>
      <TableCell>{role.name}</TableCell>
      <TableCell>
        {role.isSystem ? (
          <span className="muted small-text">Built-in</span>
        ) : (
          <div className="row wrap">
            <Button type="button" variant="ghost" aria-label={`Rename ${role.name}`} disabled={readOnly || pending} onClick={() => setName(role.name)}>Rename</Button>
            <Button type="button" variant="ghost" aria-label={`Remove ${role.name}`} disabled={readOnly || pending} onClick={() => void remove()}>
              {pending ? "Removing…" : "Remove"}
            </Button>
          </div>
        )}
      </TableCell>
    </TableRow>
  );
}

function Roles({
  roles,
  loading,
  denied,
  readOnly,
  canCreate,
  canManage,
  addRole,
  renameRole,
  removeRole,
  onError,
}: {
  roles: HubRole[];
  loading: boolean;
  denied: boolean;
  readOnly: boolean;
  canCreate: boolean;
  canManage: boolean;
  addRole: (name: string) => Promise<void>;
  renameRole: (role: HubRole, name: string) => Promise<void>;
  removeRole: (role: HubRole) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState("");
  const [adding, setAdding] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAdding(true);
    onError("");
    try {
      await addRole(name.trim());
      setName("");
    } catch (cause) {
      onError(`Could not add the role. ${errorText(cause)} Try again.`);
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="panel settings-panel" aria-label="Workspace roles">
      <h2>Workspace roles</h2>
      <p className="field-help">Give a role access rules below. A role takes effect once it is assigned to people.</p>
      {denied && <DeniedNotice section="roles" />}
      {!denied && !loading && roles.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Role</TableHead>
              <TableHead><span className="sr-only">Actions</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {roles.map((role) => (
              <RoleRow key={role.id} role={role} readOnly={readOnly || !canManage} renameRole={renameRole} removeRole={removeRole} onError={onError} />
            ))}
          </TableBody>
        </Table>
      )}
      {!denied && (
        <form onSubmit={(event) => void submit(event)}>
          <label className="field">
            New role
            <input value={name} onChange={(event) => setName(event.target.value)} disabled={readOnly || adding || !canCreate} />
          </label>
          <Button type="submit" disabled={readOnly || adding || !canCreate || !name.trim()}>
            {adding ? "Adding…" : "Add role"}
          </Button>
        </form>
      )}
    </div>
  );
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
  const { snapshot, replaceSecret, revoke, addGrant, removeGrant, addRole, renameRole, removeRole, syncFromGithub, readOnly } = usePortal();
  const { session } = useSession();
  const signOut = useSignOutAfterSending();
  const params = useParams();
  const navigate = useNavigate();
  const tab = parseTab(params.tab);
  const [error, setError] = useState("");
  const repos = snapshot?.repos ?? [];
  const grants = useGrants();
  const principals = usePrincipals();
  const roles = useRoles();
  const deployed = useDeployedWorkflows();
  const credentials = snapshot?.credentials ?? [];
  const secretNames = uniqueSecretDisplayNames(credentials);
  const deniedRepos = snapshot?.denied.repos ?? false;
  const deniedCredentials = snapshot?.denied.credentials ?? false;
  const modelStored = hasDecisionModelCredential(credentials);
  const githubReady = hasActiveGithubCredential(credentials);
  const canCreateRoles = useAllowed("role:*", "create");
  const canManageRoles = useAllowed("role:*", "manage");
  const canCreateGrants = useAllowed("grant:*", "create");
  const canManageGrants = useAllowed("grant:*", "manage");
  const canManageGithub = useGithubManageAccess().data === true;
  const permissions = permissionCatalog(activeGithubCredential(credentials)?.id ?? null);
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
                <p className="field-help">GitHub’s installer. New repos come back here for check setup.</p>
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
            <Roles
              roles={roles.rows}
              loading={roles.loading || roles.unavailable}
              denied={roles.denied}
              readOnly={readOnly}
              canCreate={canCreateRoles}
              canManage={canManageRoles}
              addRole={addRole}
              renameRole={renameRole}
              removeRole={removeRole}
              onError={setError}
            />
            <AccessRules
              grants={grants.rows}
              people={principals.rows}
              roles={roles.rows}
              permissions={permissions}
              canAdd={canCreateGrants}
              canRemove={canManageGrants}
              loading={[grants, principals, roles].some((section) => section.loading || section.unavailable)}
              denied={grants.denied || principals.denied || roles.denied}
              readOnly={readOnly}
              addGrant={addGrant}
              removeGrant={removeGrant}
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
