# Corbits Triage

Pull request triage for GitHub repositories. For each pull request it gathers
facts from GitHub, runs the repository's rules, reaches a verdict, and
suggests or runs the repository's actions. It runs as workflows on a stock
[Interchange](https://github.com/faremeter/interchange) hub, which owns
identity, grants, credentials, runs and audit.

Nothing runs by default: a repository is triaged only after someone sets up
its rules and enables it.
Enabling a repository switches on Comment and Labels; every other action stays off
until you switch it on. Turning triage off and on again switches Comment and Labels back on.

## Quickstart

Requires Bun 1.4+ and Postgres 15+.

```sh
bun install
createdb interchange   # or any empty database; the hub migrates it on boot
cp .env.example .env   # four secrets, and DATABASE_URL if not the default
bun run dev
```

When it works, the hub listens on http://localhost:3000 and the portal on
http://localhost:5173. Open the portal and follow
[Set up in the portal](docs/SELF_HOST.md#set-up-in-the-portal): create an
account, the GitHub App and the decision model, then turn on triage for a
repository. Its open pull requests appear in the Inbox with a verdict, a
score and the reasons for it. A repository can keep its policy in
`.corbits-triage.yaml` on its default branch; the hub syncs it on push (see
[Policy file](docs/PRODUCT.md#policy-file)).

To run it for real, build the root `Dockerfile` and follow
[docs/SELF_HOST.md](docs/SELF_HOST.md).

## Read next

- [docs/PRODUCT.md](docs/PRODUCT.md): what it does, the kinds of rules,
  steps, labels, and what is not finished.
- [docs/DECISION_MODEL.md](docs/DECISION_MODEL.md): how decision-model rules
  are asked and judged, budgets, cost and measured accuracy.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): components, the triage
  pipeline, tenancy and data.
- [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md): stack, paths, environment,
  scripts.
- [docs/SELF_HOST.md](docs/SELF_HOST.md): requirements, every setting, the
  GitHub App, the model key and email.
- [docs/DEPLOY.md](docs/DEPLOY.md): Docker Compose, Railway, a separately
  hosted portal, known limitations.
- [docs/DEV.md](docs/DEV.md): local setup and the GitHub emulator.
- [DESIGN.md](DESIGN.md): the portal's design tokens and rules.
- [AGENTS.md](AGENTS.md): how the code is built and its boundaries.

## License

GPLv2 with the [AI Exception](GPLv2-AI-Exception.md); see [LICENSE.md](LICENSE.md). Contributions require the [CLA](CLA.md); see [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues per [SECURITY.md](SECURITY.md).
