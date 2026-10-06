# Self-host

Run the services per [DEPLOY.md](DEPLOY.md), then set up in the portal:

1. **Sign up.** The portal creates your tenant on first sign-in.
2. **Create the GitHub App** from Connect → **Create GitHub App**, and confirm the prefilled manifest on GitHub. GitHub returns to the hub, which stores the App credentials in the vault; nothing secret reaches the browser.
   To reuse an App instead, expand **Connect an existing GitHub App** and enter its App ID, private key and webhook secret. Set its webhook URL to the one shown, with permissions Pull requests, Issues and Contents: write; Checks and Metadata: read; and events Pull request, Pull request review, Issue comment, Check run, Installation, Installation repositories.
3. **Choose repositories on GitHub**, then **Refresh**. Installation webhooks add the repositories; backlog triage starts for each newly added one.
4. **Save Settings → Inference** with your System One endpoint, model and key. The portal creates the offering and deploys `pr-triage` and `pr-triage-historical`.
5. **Verify.** Open a test PR; it appears on the board once its triage run completes.

Existing installs must accept Contents: write on GitHub for merges to work.

## How GitHub credentials are used

The vault holds the App as `{"appId","privateKey"}` under provider `github`. A trusted sidecar adapter mints short-lived installation tokens at the fetch boundary, so workflow and tool code never see the private key. Pull request actions from the portal (`POST /api/integrations/github-actions/:tenantId`) use the same adapter in the hub after checking the caller's `use` grant on the credential.
