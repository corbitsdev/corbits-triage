# Corbits Triage

Pull request triage for GitHub and Bitbucket Data Center. For each pull
request it checks the repository's rules, decides **Pass**, **Fail** or
**Unsure** with the reasons, and suggests or runs the actions the repository's
policy lists for that verdict. It runs as workflows on a stock
[Interchange](https://github.com/faremeter/interchange) hub, which owns
identity, grants, credentials, runs and audit.

Nothing runs by default: a repository is triaged only once a decision model is
saved, someone turns triage on, and its policy has a rule.

## Get started

You need a GitHub account that can create a GitHub App, an API key for the
[decision model](docs/DECISION_MODEL.md), and one of:

| Way to run it | Needs | Portal |
| --- | --- | --- |
| Docker Compose ([steps](docs/SELF_HOST.md#docker-compose)) | Docker with Compose, about 3 GB free Docker disk | http://localhost:3000 |
| `bun run dev` ([steps](docs/DEV.md)) | Bun 1.4+, Postgres 15+ | http://localhost:5173 |

On this machine GitHub cannot reach the hub, so the GitHub App is created
without a webhook and pull requests are picked up every five minutes. On a
server or Railway, follow [docs/SELF_HOST.md](docs/SELF_HOST.md).

In the folder where you'll set it up, add the Corbits Triage skills to your coding agent, then give it the Setup Prompt:

```sh
npx skills add corbitsdev/corbits-triage
```

**Setup Prompt**

```text
Set up Corbits Triage on this machine with the corbits-triage-install skill. Use Docker if I have it, otherwise my own Postgres. Tell me when you need me to do something.
```

Or by hand:

1. **Run the hub** with Docker Compose or `bun run dev`, following the steps
   linked in the table, and open its portal address. Running code review on
   this machine's Docker gives the hub control of that Docker, which on Linux
   is root on the machine ([Where sidecars run](docs/SELF_HOST.md#where-sidecars-run)).
2. **Connect GitHub.** Sign up; the portal shows **Set up Triage**: create the
   GitHub App, choose repositories, and save a decision model key
   ([Set up in the portal](docs/SELF_HOST.md#set-up-in-the-portal)).
3. **Add a policy file.** Commit `.corbits-triage.yml` to the repository's
   default branch, press **Start a policy file** in the portal to open a pull
   request with starter rules, or give your coding agent the Configure Prompt
   inside the repository. The format is in
   [Policy file](docs/PRODUCT.md#policy-file).

   **Configure Prompt**

   ```text
   Use the corbits-triage-setup skill to write a policy for this repository. Look around first, suggest rules, and ask me what should happen on Pass, Fail and Unsure.
   ```

4. **Turn on triage** for the repository under Repositories. Its open pull
   requests appear in the Inbox with a verdict, a score and the reasons.
   Triage posts its comment and verdict label on GitHub; every other action
   waits for a click in the Inbox until you let Triage take it on its own.

## Other setup paths

- **GitHub emulator.** Try it with no GitHub App or GitHub account under
  `bun run dev` ([steps](docs/DEV.md#github-emulator-no-github-account)); it
  still needs a decision model endpoint.
- **Policy check Action.** [packages/policy-check-action](packages/policy-check-action/action.yml)
  checks the policy file and runs its rules that need no model on every pull
  request, with no hub or secrets ([workflow to copy](docs/Corbits%20Triage%20User%20Manual/Corbits%20Triage%20User%20Manual.md#checking-the-file-in-pull-requests)).
- **Browser extension.** [apps/extension](apps/extension/README.md) checks the
  GitHub pull request you are viewing against its policy and shows each rule's
  result on the page, with your own GitHub token and no hub. Build and load it
  in Chrome or Firefox ([install](apps/extension/README.md#install)).

## Read next

- [User manual](docs/Corbits%20Triage%20User%20Manual/Corbits%20Triage%20User%20Manual.md):
  the portal, screen by screen.
- [docs/PRODUCT.md](docs/PRODUCT.md): rules, verdicts, actions, labels, the
  policy file and code review.
- [docs/SELF_HOST.md](docs/SELF_HOST.md): running the hub and every setting.
- [docs/BITBUCKET_DATACENTER.md](docs/BITBUCKET_DATACENTER.md): connecting
  Bitbucket Data Center.
- [docs/provisioners/README.md](docs/provisioners/README.md): where sidecars
  run, and setting up Docker, E2B or Railway Sandboxes for code review.
- [docs/DECISION_MODEL.md](docs/DECISION_MODEL.md): how judged rules are asked,
  their cost and measured accuracy.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and
  [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md): how it is built.
- [CONTRIBUTING.md](CONTRIBUTING.md), [AGENTS.md](AGENTS.md) and
  [DESIGN.md](DESIGN.md): contributing, code rules and the portal's design.

## License

GPLv2 with the [AI Exception](GPLv2-AI-Exception.md); see [LICENSE.md](LICENSE.md). Contributions require the [CLA](CLA.md); see [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues per [SECURITY.md](SECURITY.md).
