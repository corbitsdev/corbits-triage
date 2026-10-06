// SPDX-License-Identifier: GPL-2.0-only
import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { DeniedNotice } from "../lib/denied.tsx";
import { runCredentialAction, uniqueSecretDisplayNames } from "../lib/credential-actions.ts";
import {
  accessWhoOptions,
  canRemoveGrant,
  grantCreateInputFromForm,
  grantResourceLabel,
  grantWhoLabel,
  parseGrantEffect,
  type GrantEffect,
} from "../lib/grant-actions.ts";
import { githubWebhookUrl } from "../lib/github-manifest.ts";
import { githubAppPickerUrl, GITHUB_APP_PICKER_UNAVAILABLE, openGithubInstallation } from "../lib/github-manifest.ts";
import { githubAppSlugFromCredentials, hasActiveGithubCredential, type HubCredential, type HubGrant, type HubPrincipal, type HubRole } from "../lib/hub-api.ts";
import { usePortal } from "../lib/portal.tsx";
import { useGithubReturnSync } from "../lib/github-return-sync.ts";
import { useSession } from "../lib/session.tsx";
import { DecisionModelForm } from "../components/DecisionModelForm.tsx";
import { DECISION_MODEL_INTRO, hasDecisionModelCredential } from "../lib/decision-models.ts";

const TABS = ["Triage", "GitHub", "Integrations", "Model", "Access", "Account"] as const;
type SettingsTab = (typeof TABS)[number];

function tabId(tab: SettingsTab): string {
  return `settings-tab-${tab.toLowerCase()}`;
}

function panelId(tab: SettingsTab): string {
  return `settings-panel-${tab.toLowerCase()}`;
}

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
  readOnly,
  pending,
  onRemove,
}: {
  grant: HubGrant;
  who: string;
  readOnly: boolean;
  pending: boolean;
  onRemove: () => Promise<void>;
}) {
  const resource = grantResourceLabel(grant.resource);
  return (
    <tr>
      <td>{who}</td>
      <td className="mono" aria-label={resource.detail}>{resource.label}</td>
      <td className="mono">{grant.action}</td>
      <td>{sentenceCase(grant.effect)}</td>
      <td>
        {canRemoveGrant(grant) ? (
          <button type="button" className="btn ghost" disabled={readOnly || pending} onClick={() => void onRemove()}>
            {pending ? "Removing…" : "Remove"}
          </button>
        ) : (
          <span className="muted small-text">Built-in</span>
        )}
      </td>
    </tr>
  );
}

function AccessRules({
  grants,
  people,
  roles,
  denied,
  readOnly,
  addGrant,
  removeGrant,
  onError,
}: {
  grants: HubGrant[];
  people: HubPrincipal[];
  roles: HubRole[];
  denied: boolean;
  readOnly: boolean;
  addGrant: (input: ReturnType<typeof grantCreateInputFromForm>) => Promise<void>;
  removeGrant: (grant: HubGrant) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [who, setWho] = useState("");
  const [resource, setResource] = useState("");
  const [action, setAction] = useState("");
  const [effect, setEffect] = useState<GrantEffect>("allow");
  const [adding, setAdding] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const whoOptions = accessWhoOptions(people, roles);
  const peopleOptions = whoOptions.filter((option) => option.group === "People");
  const roleOptions = whoOptions.filter((option) => option.group === "Roles");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAdding(true);
    onError("");
    try {
      await addGrant(grantCreateInputFromForm({ who, resource, action, effect }));
      setWho("");
      setResource("");
      setAction("");
      setEffect("allow");
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
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
      const detail = cause instanceof Error ? cause.message : String(cause);
      onError(`Could not remove the access rule. ${detail} Try again.`);
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <div className="panel settings-panel" aria-label="Who can sign in">
      <h2>Who can sign in</h2>
      <p className="field-help">People who may use this app. This is not who reviews pull requests on GitHub.</p>
      {denied && <DeniedNotice section="access rules" />}
      {!denied && grants.length === 0 && <p className="muted">No access rules.</p>}
      {!denied && grants.length > 0 && (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Who</th>
                <th>Resource</th>
                <th>Action</th>
                <th>Effect</th>
                <th><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {grants.map((grant) => (
                <GrantRow
                  key={grant.id}
                  grant={grant}
                  who={grantWhoLabel(grant, people, roles)}
                  readOnly={readOnly}
                  pending={removingId === grant.id}
                  onRemove={() => remove(grant)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!denied && (
        <form onSubmit={(event) => void submit(event)}>
          <label className="field">
            Who
            <span className="field-help">Person or role this rule applies to.</span>
            <select value={who} onChange={(event) => setWho(event.target.value)} disabled={readOnly || adding}>
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
            <span className="field-help">Watch the board, confirm recommendations, or change settings.</span>
            <input value={action} onChange={(event) => setAction(event.target.value)} disabled={readOnly || adding} placeholder="confirm recommendations" />
          </label>
          <label className="field">
            Resource
            <span className="field-help">What this rule applies to.</span>
            <input value={resource} onChange={(event) => setResource(event.target.value)} disabled={readOnly || adding} />
          </label>
          <label className="field">
            Effect
            <select value={effect} onChange={(event) => setEffect(parseGrantEffect(event.target.value))} disabled={readOnly || adding}>
              <option value="allow">Allow</option>
              <option value="ask">Ask</option>
              <option value="deny">Deny</option>
            </select>
          </label>
          <button type="submit" className="btn primary" disabled={readOnly || adding || !who || !resource.trim() || !action.trim()}>
            {adding ? "Adding…" : "Add rule"}
          </button>
        </form>
      )}
    </div>
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
      const message = cause instanceof Error ? cause.message : String(cause);
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
        <span className={`status-badge${active ? " status-ok" : ""}`}>
          <span aria-hidden="true" />
          {sentenceCase(credential.status)}
        </span>
        <div className="row wrap">
          <button type="button" className="btn" aria-label={`Update secret for ${displayName}`} disabled={readOnly || pending !== null || (editing && !secret)} onClick={updateSecret}>
            {pending === "rotate" ? "Updating…" : "Update secret"}
          </button>
          <button type="button" className="btn ghost" aria-label={`Remove ${displayName}`} disabled={readOnly || pending !== null} onClick={() => void act("revoke")}>
            {pending === "revoke" ? "Removing…" : "Remove"}
          </button>
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
  const { snapshot, replaceSecret, revoke, saveConfig, addGrant, removeGrant, refreshNow, readOnly } = usePortal();
  const { session, signOut } = useSession();
  const params = useParams();
  const navigate = useNavigate();
  const tab = parseTab(params.tab);
  const [error, setError] = useState("");
  const config = snapshot?.config ?? {};
  const savedFloor = String(config.confidenceFloor ?? 0.7);
  const [floor, setFloor] = useState(savedFloor);
  const repos = snapshot?.repos ?? [];
  const grants = snapshot?.grants ?? [];
  const principals = snapshot?.principals ?? [];
  const roles = snapshot?.roles ?? [];
  const credentials = snapshot?.credentials ?? [];
  const secretNames = uniqueSecretDisplayNames(credentials);
  const deniedRepos = snapshot?.denied.repos ?? false;
  const deniedGrants = snapshot?.denied.grants ?? false;
  const deniedCredentials = snapshot?.denied.credentials ?? false;
  const modelStored = hasDecisionModelCredential(credentials);
  const githubReady = hasActiveGithubCredential(credentials);
  const webhookUrl = snapshot ? githubWebhookUrl(snapshot.workspace.tenantId) : "";
  const { arm } = useGithubReturnSync(() => { void refreshNow(); });
  const triageDirty = floor !== savedFloor;

  useEffect(function resetFloor() {
    setFloor(savedFloor);
  }, [savedFloor]);

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
      setError(`Could not open GitHub. ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  async function saveTriage() {
    setError("");
    const confidenceFloor = Number(floor);
    if (!Number.isFinite(confidenceFloor) || confidenceFloor < 0 || confidenceFloor > 1) {
      setError("Confidence floor must be between 0 and 1.");
      return;
    }
    try {
      await saveConfig({ confidenceFloor });
    } catch (cause: unknown) {
      setError(`Could not save settings. ${cause instanceof Error ? cause.message : String(cause)} Check the values, then try again.`);
    }
  }

  function submitTriage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void saveTriage();
  }

  function cancelEdits() {
    if (tab === "Triage") setFloor(savedFloor);
  }

  function saveTab() {
    if (tab === "Triage") void saveTriage();
  }

  const dirty = tab === "Triage" && triageDirty;

  return (
    <div className="main-shell">
      <div className="workspace">
        <header className="workspace-head">
          <div className="page-heading">
            <div>
              <h1>Settings</h1>
            </div>
          </div>
          <div className="segmented" role="tablist" aria-label="Settings sections">
            {TABS.map((item) => (
              <button
                key={item}
                id={tabId(item)}
                role="tab"
                aria-selected={tab === item}
                aria-controls={panelId(item)}
                type="button"
                className={tab === item ? "active" : ""}
                onClick={() => navigate(item === "Triage" ? "/settings" : `/settings/${item.toLowerCase()}`)}
              >
                {item}
              </button>
            ))}
          </div>
        </header>
        <main id="main" className={`scroller${dirty ? " has-dirty" : ""}`}>
          <div className="content-wide">
            {error && <p role="alert" className="error">{error}</p>}
            <div role="tabpanel" id={panelId("Triage")} aria-labelledby={tabId("Triage")} hidden={tab !== "Triage"}>
              <form className="panel settings-panel" onSubmit={submitTriage}>
                <label className="field">
                  Confidence floor
                  <span className="field-help">Pull requests below this score wait for a person.</span>
                  <input value={floor} inputMode="decimal" onChange={(event) => setFloor(event.target.value)} disabled={readOnly} />
                </label>
              </form>
            </div>
            <div role="tabpanel" id={panelId("GitHub")} aria-labelledby={tabId("GitHub")} hidden={tab !== "GitHub"}>
              <div className="panel settings-panel" aria-label="GitHub">
                <h2>Connected App</h2>
                <dl className="facts">
                  <div><dt>Status</dt><dd>{githubReady ? "Connected" : "Not connected"}</dd></div>
                  <div><dt>Installs</dt><dd>{repos.length} repositories</dd></div>
                </dl>
                <h2>Webhook</h2>
                <div className="hook-url"><code>{webhookUrl}</code></div>
                <button type="button" className="btn primary" onClick={() => void chooseOnGithub()}>Choose repositories on GitHub</button>
                <p className="field-help">GitHub’s installer. New repos come back here for check setup.</p>
                {deniedRepos && <DeniedNotice section="repositories" />}
                {repos.length === 0 && !deniedRepos && <p className="muted">No repositories configured.</p>}
                {repos.map((repo) => (
                  <div key={repo.name} className="install-row">
                    <strong className="mono">{repo.name}</strong>
                    <span className={`status-badge${repo.connected ? " status-ok" : ""}`}><span aria-hidden="true" />{repo.connected ? "Connected" : "Not connected"}</span>
                  </div>
                ))}
              </div>
            </div>
            <div role="tabpanel" id={panelId("Integrations")} aria-labelledby={tabId("Integrations")} hidden={tab !== "Integrations"}>
              <section className="integration">
                <h2>GitHub</h2>
                <p className="live-mark"><i />Live</p>
                <p>{githubReady ? `Installed. ${repos.length} repositories.` : "Not connected yet."}</p>
              </section>
              <section className="integration">
                <h2>Slack</h2>
                <p>Not in v1.</p>
                <p className="field-help">Would connect one workspace and post into one channel when a person has to act.</p>
                <button className="btn primary" type="button" disabled>Connect Slack</button>
                <p className="small muted">Not in v1.</p>
              </section>
            </div>
            <div role="tabpanel" id={panelId("Model")} aria-labelledby={tabId("Model")} hidden={tab !== "Model"}>
              <section className="panel settings-panel" aria-label="Decision model">
                <h2>Decision model</h2>
                <p className="field-help">{DECISION_MODEL_INTRO}</p>
                {deniedCredentials && <DeniedNotice section="credentials" />}
                <p className="muted small-text">{modelStored ? "API key stored. Save again to replace it." : "No decision model connected."}</p>
                <DecisionModelForm />
              </section>
            </div>
            <div role="tabpanel" id={panelId("Access")} aria-labelledby={tabId("Access")} hidden={tab !== "Access"}>
              <AccessRules
                grants={grants}
                people={principals}
                roles={roles}
                denied={deniedGrants}
                readOnly={readOnly}
                addGrant={addGrant}
                removeGrant={removeGrant}
                onError={setError}
              />
            </div>
            <div role="tabpanel" id={panelId("Account")} aria-labelledby={tabId("Account")} hidden={tab !== "Account"}>
              <div className="panel settings-panel" aria-label="Account">
                <h2>{session?.email ?? "Signed in"}</h2>
                <p className="muted">Signed in to this app.</p>
                <button type="button" className="btn" onClick={() => void signOut()}>Sign out</button>
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
            </div>
          </div>
        </main>
      </div>
      {dirty && (
        <div className="dirty-bar">
          <button type="button" className="btn" onClick={cancelEdits}>Cancel</button>
          <button type="button" className="btn primary" disabled={readOnly} onClick={saveTab}>Save</button>
        </div>
      )}
    </div>
  );
}
