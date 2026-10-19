---
name: corbits-triage-install
description: Helps a person install and run Corbits Triage, from choosing where the hub runs to the first verdict. Use when someone wants to install, self-host, deploy or try Corbits Triage, on their machine with Docker Compose, on Railway, or on a server of their own.
---

# Install Corbits Triage

Get a Corbits Triage hub running, connected to GitHub, and triaging one repository. The steps live in the docs; follow the section linked at each step and don't improvise around it. Paths are relative to a Corbits Triage checkout (`git clone https://github.com/corbitsdev/corbits-triage`).

## Rules for you

- **Some steps only the person can do**: logging in to a host's CLI or dashboard (such as `railway login`), signing up in the portal, confirming the GitHub App on GitHub, choosing repositories, and pasting model or provider keys into the portal. Tell them what to press and wait. Never drive their browser, read its cookies or sign in as them.
- **Never print a secret.** Generate the four hub secrets straight into `.env` or the host's variables (`"$(openssl rand -hex 32)"`), never echo them, never paste them into chat or a commit. Tell the person to keep a copy apart from the database ([Backups](../../docs/SELF_HOST.md#backups)).
- Never ask for a model key in chat; the person enters it in the portal.

## 1. Choose where it runs

Ask, suggesting the first that fits:

| Choice | When | Guide |
| --- | --- | --- |
| This machine, Docker Compose | Trying it. GitHub can't reach localhost, so pull requests are picked up every five minutes. | [Docker Compose](../../docs/SELF_HOST.md#docker-compose) |
| Railway | A real deployment with no server to manage. | [Railway](../../docs/SELF_HOST.md#railway) |
| A server of their own (VPS) with Docker Compose 2.24+ | A real deployment on their own machine. `.env` holds the four secrets and `DOMAIN` only; start with `docker compose -f compose.yml -f compose.tls.yml up --build -d`. | [Plain VPS](../../docs/SELF_HOST.md#plain-vps) |

What each needs: [What you need](../../docs/SELF_HOST.md#what-you-need).

## 2. Configure and start

Follow the chosen guide. Set only what it lists; every variable is in [Configuration](../../docs/SELF_HOST.md#configuration). Optional sign-in limits (`AUTH_ALLOWED_EMAILS`, Google) are in [Sign-in](../../docs/SELF_HOST.md#sign-in).

- **Compose, locally or on a VPS**: check that `docker info` succeeds and the ports are free (3000 locally, 80 and 443 on a VPS). After `cp .env.example .env`, fill the four secrets without printing them:

  ```sh
  for k in BETTER_AUTH_SECRET CREDENTIAL_ENCRYPTION_KEY PRINCIPAL_KEY_ENCRYPTION_KEY SIDECAR_CREDENTIAL_ENCRYPTION_KEY; do
    sed -i.bak "s/^$k=.*/$k=$(openssl rand -hex 32)/" .env
  done && rm .env.bak
  ```

  On a VPS also add `DOMAIN=<domain>` to `.env`, and start only once `dig +short <domain>` returns the server's address, or the certificate request fails.
- **Railway**: there is no `.env`. Ask which repository to deploy from (`corbitsdev/corbits-triage` or their public fork); Railway's GitHub app must have access to it, which the person grants. Pass each secret as its own `NAME="$(openssl rand -hex 32)"` in place of `<hex>`.

The first build takes a few minutes. The hub is up when its logs (`docker compose logs -f hub` or `railway logs --service hub`) show `Started server` and `curl -sI <address>` returns 200. If it exits, it names the missing or malformed variable.

## 3. Hand over to the person

At the hub's address, the person does [Set up in the portal](../../docs/SELF_HOST.md#set-up-in-the-portal) steps 1 to 4: sign up (the first account creates the workspace), press **Create GitHub App** and confirm it on GitHub, choose repositories, and add the decision model key. On a public hub, start the App flow from the public URL. Bitbucket Data Center instead: [BITBUCKET_DATACENTER.md](../../docs/BITBUCKET_DATACENTER.md).

## 4. Add a policy file

Either the person presses **Start a policy file** on the repository and merges the pull request, or you write one with the [corbits-triage-setup](../corbits-triage-setup/SKILL.md) skill in that repository. It applies once merged to the default branch; a local hub reads a change after a restart.

## 5. Turn triage on

The person opens the repository under Repositories and turns on **Triage pull requests in this repository**. Its open pull requests get a verdict in the Inbox, with a comment and verdict label on GitHub. Done when the person sees one; locally that can take up to five minutes.

## Optional: code review

Needs an Anthropic key, which the person saves under Settings → Code review, and an isolated place to run, never the hub's own machine: [Where sidecars run](../../docs/SELF_HOST.md#where-sidecars-run) and [provisioners/README.md](../../docs/provisioners/README.md#which-to-use).

- Compose on the same machine: add `-f compose.docker.yml` to the `docker compose` flags already in use, such as `docker compose -f compose.yml -f compose.docker.yml up --build -d`. Tell the person this gives the hub control of that Docker, which on Linux is root on the machine.
- Railway: [Railway Sandboxes](../../docs/provisioners/railway-sandboxes.md), [E2B](../../docs/provisioners/e2b.md) or [Docker on another machine](../../docs/provisioners/docker-remote.md).

Settings → Code review → **Where it runs** shows which place is ready; then the person switches code review on for the repository ([Code review](../../docs/PRODUCT.md#code-review)).

## Checklist

- [ ] Host chosen
- [ ] Secrets set, never printed; person keeps a copy
- [ ] Hub logs `Started server`; its address returns 200
- [ ] Person signed up, created the GitHub App, chose repositories, added the model key
- [ ] Policy file merged
- [ ] Triage on; first verdict in the Inbox
- [ ] (Optional) code review place ready
