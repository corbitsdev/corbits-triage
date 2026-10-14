import { useState } from "react";
import { Button } from "@corbits/react-ui";
import { Link } from "react-router-dom";
import { errorText } from "@corbits/common";
import { githubSecrets, namedSecrets } from "../../lib/credential-actions.ts";
import { DeniedNotice } from "../../lib/denied.tsx";
import { githubAppPickerUrl, githubWebhookUrl, GITHUB_APP_PICKER_UNAVAILABLE, openGithubInstallation } from "../../lib/github-manifest.ts";
import { useGithubReturnSync } from "../../lib/github-return-sync.ts";
import { useGithubManageAccess } from "../../lib/github-sync.ts";
import { githubAppSlugFromCredentials, hasActiveGithubCredential, type PortalSnapshot, type RepoRecord } from "../../lib/hub-api.ts";
import { counted } from "../../lib/plural.ts";
import { usePortal } from "../../lib/portal.tsx";
import { CopyField } from "../CopyField.tsx";
import { CredentialRow } from "./CredentialRow.tsx";

function repoName(repo: RepoRecord): string {
  return repo.connected ? repo.name : `${repo.name} (not connected)`;
}

/** The GitHub App: whether it works, where it is installed, the webhook it posts to, and its secrets. */
export function GithubSection({ snapshot }: { snapshot: PortalSnapshot }) {
  const { syncFromGithub } = usePortal();
  const [error, setError] = useState("");
  const canManage = useGithubManageAccess().data === true;
  const { credentials, repos } = snapshot;
  const ready = hasActiveGithubCredential(credentials);
  const secrets = namedSecrets(githubSecrets(credentials));
  const slug = githubAppSlugFromCredentials(credentials);

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

  return (
    <section className="sec" id="github" aria-labelledby="sec-github">
      <header>
        <h2 id="sec-github">GitHub</h2>
        <p>The Triage GitHub App reads pull requests and acts on them on your behalf.</p>
      </header>
      <div>
        {error && <p role="alert" className="error">{error}</p>}
        <div className="sentences">
          <div className="sentence">
            <span className="txt">
              {ready ? <>The GitHub App{slug && <> <b>{slug}</b></>} is connected and installed on {counted(repos.length, "repository", "repositories")}.</> : "The GitHub App is not connected."}
            </span>
            {!ready && <Link className="linkish" to="/connect">Connect it</Link>}
            {ready && canManage && <Button type="button" variant="outline" size="sm" onClick={chooseOnGithub}>Choose repositories on GitHub</Button>}
          </div>
          {snapshot.denied.repos && <DeniedNotice section="repositories" />}
          {repos.length > 0 && (
            <div className="sentence">
              <span className="txt mono small-text">{repos.map(repoName).join(", ")}</span>
              <Link className="linkish" to="/repositories">Open Repositories</Link>
            </div>
          )}
          {secrets.map(({ credential, name }) => <CredentialRow key={credential.id} credential={credential} name={name} replaceable />)}
        </div>
        {snapshot.denied.credentials && <DeniedNotice section="credentials" />}
        <CopyField label="Webhook URL" value={githubWebhookUrl(snapshot.workspace.tenantId)} help="GitHub sends pull request events here. It is the Webhook URL in your GitHub App's settings." />
      </div>
    </section>
  );
}
