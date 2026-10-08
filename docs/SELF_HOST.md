# Self-host

Run the services per [DEPLOY.md](DEPLOY.md), then set up in the portal:

1. **Sign up.** The portal creates your tenant on first sign-in.
2. **Create the GitHub App** from Connect → **Create GitHub App**, and confirm the prefilled manifest on GitHub. GitHub returns to the hub, which stores the App credentials in the vault; nothing secret reaches the browser.
   To reuse an App instead, expand **Connect an existing GitHub App** and enter its App ID, private key and webhook secret. Set its webhook URL to the one shown, with permissions Pull requests, Issues and Contents: write; Checks and Metadata: read; and events Pull request, Pull request review, Issue comment, Check run, Installation, Installation repositories.
3. **Choose repositories on GitHub**, then **Refresh**. The repositories are recorded with triage disabled; nothing runs yet.
4. **Add decision model.** Pick TypeSafe (Jev) or Vercel AI Gateway (Jev) and paste an API key, or **Add my own provider** with a System One–compatible base URL (requests go to it + `/systemone`), model and key. The key goes to the hub's credential vault. Saving deploys `pr-triage` and `pr-triage-historical`; triage is not live until then.
5. **Set up checks and enable triage.** Open each repository, save its checks (Use recommended or Customize), then click **Enable triage**. That triages its open pull requests, and new pull request events are triaged from then on. **Triage again** re-runs it.
6. **Verify.** Open a test PR; it appears on the board once its triage run completes.

Existing installs must accept Contents: write on GitHub for merges to work.

## How GitHub credentials are used

The vault holds the App as `{"appId","privateKey"}` under provider `github`. A trusted sidecar adapter mints short-lived installation tokens at the fetch boundary, so workflow and tool code never see the private key. Pull request actions from the portal (`POST /api/integrations/github-actions/:tenantId`) use the same adapter in the hub after checking the caller's `use` grant on the credential.
