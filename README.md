# Corbits Triage

Pull request triage for GitHub and Bitbucket Data Center. For each pull
request it checks the repository's rules, decides **Pass**, **Fail** or
**Unsure** with the reasons, and suggests or runs the actions the repository's
policy lists for that verdict. It runs as workflows on a stock
[Interchange](https://github.com/faremeter/interchange) hub, which owns
identity, grants, credentials, runs and audit.

Nothing runs by default: a repository is triaged only once someone turns
triage on and its policy has a rule.

## Set up through the portal

1. **Run the hub.** On a server with a public HTTPS domain, follow
   [docs/SELF_HOST.md](docs/SELF_HOST.md); on Railway, its
   [Railway steps](docs/SELF_HOST.md#railway); on a plain VPS, its
   [Plain VPS steps](docs/SELF_HOST.md#plain-vps). To try it on your machine:

   ```sh
   cp .env.example .env   # paste a different `openssl rand -hex 32` into each of the four secrets at its top
   docker compose up --build -d
   docker compose logs -f hub   # Ctrl-C once it logs Started server
   ```

   Compose sets every other variable, so the rest of `.env` can stay as it is.
   Once the hub logs `Started server`, the portal is at http://localhost:3000.
   A `docker_sidecars_off` line is expected: triage needs no Docker, only
   [code review](docs/SELF_HOST.md#where-sidecars-run) does. To run code
   review on this machine's Docker, start it with
   `docker compose -f compose.yml -f compose.docker.yml up --build -d`. That
   gives the hub control of that Docker, which on Linux is root on the
   machine: whoever takes over the hub takes over the machine. GitHub cannot deliver webhooks to
   localhost, so pull requests are picked up every five minutes
   and a policy file change is read after a restart. To work on the code
   instead, see [docs/DEV.md](docs/DEV.md).
2. **Connect GitHub.** Sign up, press **Create GitHub App**, choose
   repositories, and save a decision model key
   ([Set up in the portal](docs/SELF_HOST.md#set-up-in-the-portal)).
3. **Add a policy file.** Commit `.corbits-triage.yml` to the repository's
   default branch, or press **Start a policy file** in the portal to open a
   pull request with starter rules. The format is in
   [Policy file](docs/PRODUCT.md#policy-file).
4. **Turn on triage** for the repository under Repositories. Its open pull
   requests appear in the Inbox with a verdict, a score and the reasons.
   Triage posts its comment and verdict label on GitHub; every other action
   waits for a click in the Inbox until you let Triage take it on its own.

## Other setup paths

- **Setup skill.** [skills/corbits-triage-setup](skills/corbits-triage-setup/SKILL.md)
  lets a coding agent write and check `.corbits-triage.yml`. Copy the folder
  into your agent's skills folder (such as `.claude/skills/` or
  `.agents/skills/`) and ask it to set up Corbits Triage.
- **Policy check Action.** [packages/policy-check-action](packages/policy-check-action/action.yml)
  checks the policy file on every pull request that changes it, with no hub
  or secrets ([workflow to copy](docs/Corbits%20Triage%20User%20Manual/Corbits%20Triage%20User%20Manual.md#checking-the-file-in-pull-requests)).
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
