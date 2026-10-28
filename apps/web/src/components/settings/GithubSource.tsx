import { useState } from "react";
import { Button } from "@corbits/react-ui";
import { Link } from "react-router-dom";
import { errorText } from "@corbits/common";
import { githubAppHeld, githubSecrets, namedSecrets, otherSecrets } from "../../lib/credential-actions.ts";
import { DeniedNotice } from "../../lib/denied.tsx";
import { githubAppPickerUrl, githubWebhookUrl, GITHUB_APP_PICKER_UNAVAILABLE, openGithubInstallation } from "../../lib/github-manifest.ts";
import { useGithubReturnSync } from "../../lib/github-return-sync.ts";
import { useGithubManageAccess } from "../../lib/github-sync.ts";
import { GITHUB_CREDENTIAL_NAME, GITHUB_READ_CREDENTIAL_NAME, githubAppSlugFromCredentials, hasActiveGithubCredential, type PortalSnapshot } from "../../lib/hub-api.ts";
import { counted } from "../../lib/plural.ts";
import { usePortal } from "../../lib/portal.tsx";
import { CopyField } from "../CopyField.tsx";
import { CredentialRow } from "./CredentialRow.tsx";
import { GithubAppRow } from "./GithubAppRow.tsx";

function notReadyText(lapsed: boolean): string {
  return lapsed ? "Triage's access to GitHub has expired, so it cannot triage until it is renewed." : "The GitHub App is not connected.";
}

export function GithubSource({ snapshot }: { snapshot: PortalSnapshot }) {
  const { syncFromGithub, revoke } = usePortal();
  const [error, setError] = useState("");
  const canManage = useGithubManageAccess().data === true;
  const { credentials } = snapshot;
  const ready = hasActiveGithubCredential(credentials);
  const secrets = namedSecrets(githubSecrets(credentials));
  const others = namedSecrets(otherSecrets(credentials));
  const installed = snapshot.repos.filter((repo) => repo.source !== "bitbucket-datacenter" && repo.connected).length;
  const slug = githubAppSlugFromCredentials(credentials);
  const held = githubAppHeld(credentials);
  const readToken = held.find((credential) => credential.name === GITHUB_READ_CREDENTIAL_NAME);
  // Connected, but Triage's access to GitHub ran out; the GitHub App row below says why.
  const lapsed = !ready && credentials.some((credential) => credential.name === GITHUB_CREDENTIAL_NAME && credential.status.toLowerCase() === "expired");

  /** The App's key and read token go with it. */
  async function removeGithubApp(credentialId: string) {
    await revoke(credentialId);
    for (const credential of held) await revoke(credential.id);
  }

  async function syncAfterGithub() {
    try {
      await syncFromGithub();
    } catch (cause) {
      setError(`Could not read your repositories from GitHub. ${errorText(cause)}`);
    }
  }
  const { arm } = useGithubReturnSync(() => { void syncAfterGithub(); });

  function chooseOnGithub() {
    setError("");
    const url = githubAppPickerUrl(slug);
    if (!url) {
      setError(ready ? GITHUB_APP_PICKER_UNAVAILABLE : "Connect the GitHub App first, then choose repositories.");
      return;
    }
    if (!openGithubInstallation(url)) {
      setError("Your browser blocked the GitHub window. Allow popups for this page, then try again.");
      return;
    }
    arm();
  }

  if (!ready && !snapshot.denied.credentials && secrets.length === 0 && others.length === 0) {
    return (
      <div className="gcard source" aria-labelledby="source-github" role="group">
        <div className="sentence">
          <span className="txt" id="source-github"><b>GitHub</b> is not connected.</span>
          <Button asChild variant="outline" size="sm"><Link to="/connect">Connect</Link></Button>
        </div>
      </div>
    );
  }

  return (
    <div className="gcard source" aria-labelledby="source-github" role="group">
      <header>
        <b id="source-github">GitHub</b>
        <span>The Triage GitHub App reads pull requests and acts on them on your behalf.</span>
      </header>
      <div className="source-body">
        {error && <p role="alert" className="error">{error}</p>}
        <div className="sentences">
          <div className="sentence">
            <span className="txt">
              {ready ? <>The GitHub App{slug && <> <b>{slug}</b></>} is connected and installed on {counted(installed, "repository", "repositories")}.</> : notReadyText(lapsed)}
            </span>
            {!ready && !lapsed && <Link className="linkish" to="/connect">Connect it</Link>}
            {ready && canManage && <Button type="button" variant="outline" size="sm" onClick={chooseOnGithub}>Choose repositories on GitHub</Button>}
          </div>
          {secrets.map(({ credential, name }) => (credential.name === GITHUB_CREDENTIAL_NAME
            ? <GithubAppRow key={credential.id} credential={credential} readToken={readToken} name={name} tenantId={snapshot.workspace.tenantId} replaceable={canManage} remove={removeGithubApp} />
            : <CredentialRow key={credential.id} credential={credential} name={name} rotatable />))}
        </div>
        {others.length > 0 && (
          <div>
            <p className="field-help">Other credentials</p>
            <div className="sentences">
              {others.map(({ credential, name }) => <CredentialRow key={credential.id} credential={credential} name={name} rotatable={false} />)}
            </div>
          </div>
        )}
        {snapshot.denied.credentials && <DeniedNotice section="credentials" />}
        <CopyField label="Webhook URL" value={githubWebhookUrl(snapshot.workspace.tenantId)} help="GitHub sends pull request events here. It is the Webhook URL in your GitHub App's settings." />
      </div>
    </div>
  );
}
