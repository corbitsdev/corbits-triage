---
name: corbits-triage-install
description: Gets Corbits Triage running on this machine, from starting the hub to connecting GitHub and the first verdict. Use when someone wants to install, run, self-host or try Corbits Triage, with Docker Compose or with their own Postgres. For writing or changing a repository's policy file, use corbits-triage-setup instead.
---

# Install Corbits Triage

Get a Corbits Triage hub running on this machine, connected to GitHub, and triaging one repository. For a server or Railway, follow `docs/SELF_HOST.md` (sections "Railway" or "Any other host") instead.

## Rules for you

- **Some steps only the person can do**: signing up in the portal, creating the GitHub App on GitHub, choosing repositories, and pasting keys into the portal. Tell them what to press and wait. Never drive their browser, read its cookies or sign in as them, and never ask for a key in chat.
- **Never print a secret.** Write the four hub secrets straight into `.env`, never echo them, never paste them into chat or a commit. Tell the person to keep a copy apart from the database (`docs/SELF_HOST.md`, "Backups").
- **Never block on a command that does not end.** Run the hub in the background and check its logs.

## 0. Find the checkout

All paths below are inside a Corbits Triage checkout. If the current directory is not one (it has no `compose.yml` and `skills/corbits-triage-install`), ask where it is, or clone it where the person chooses:

```sh
git clone https://github.com/corbitsdev/corbits-triage
```

Run every command from the checkout's root.

## 1. Choose a path

Ask, suggesting the first that fits (`docs/SELF_HOST.md`, "What you need"):

| Path | Needs | Portal |
| --- | --- | --- |
| Docker Compose (preferred) | Docker with Compose, and about 3 GB free Docker disk for the first build | http://localhost:3000 |
| Their own Postgres | Bun 1.4+ and Postgres 15+ | http://localhost:5173 |

Either way, GitHub cannot reach localhost, so pull requests are picked up every five minutes.

## 2. Set the secrets

Only if `.env` does not exist yet. If it does, keep it: new secrets lock the hub out of what it already stored.

```sh
cp .env.example .env
for k in BETTER_AUTH_SECRET CREDENTIAL_ENCRYPTION_KEY PRINCIPAL_KEY_ENCRYPTION_KEY SIDECAR_CREDENTIAL_ENCRYPTION_KEY; do
  sed -i.bak "s/^$k=.*/$k=$(openssl rand -hex 32)/" .env
done && rm .env.bak
```

## 3. Start the hub

**Docker Compose** (`docs/SELF_HOST.md`, "Docker Compose"). Check that `docker info` succeeds and port 3000 is free, then:

```sh
docker compose up --build -d
```

Compose sets every other variable. The first build takes a few minutes. Run `docker compose logs hub` until it shows `Started server`. A build that stops with `no space left on device` needs more free Docker disk.

**Their own Postgres** (`docs/DEV.md`). Run `bun install`, then create an empty database whose role has a password, as `docs/DEV.md` "2. Database" shows; the database setup refuses a URL without a password. Set `DATABASE_URL` in `.env`:

```
DATABASE_URL=postgres://<user>:<password>@localhost:5432/interchange
```

Start `bun run dev` in the background, writing its output to a log file. It sets up the database first (`migrations applied successfully!`; the Postgres notices printed before it are expected), then starts the hub. Read the log until it shows `Started server`. A warning that rate limiting could not determine a client IP may appear and is harmless.

If the hub or its database setup stops, its logs (`docker compose logs`, or the dev log file) print why.

## 4. Connect GitHub

At the portal address, the person does `docs/SELF_HOST.md` "Set up in the portal" steps 1 to 4: sign up (the first account creates the workspace), press **Create GitHub App** and confirm it on GitHub, choose repositories, and save the decision model key. After signing up the portal shows **Set up Triage** with three steps: Connect a source, Repositories, Decision model. Bitbucket Data Center instead: `docs/BITBUCKET_DATACENTER.md`.

To try it without a GitHub account, use the GitHub emulator on the own-Postgres path instead (`docs/DEV.md`, "GitHub emulator (no GitHub account)"); it still needs a decision model endpoint.

## 5. Add a policy file

Either the person presses **Start a policy file** on the repository and merges the pull request, or you write one with the corbits-triage-setup skill (`skills/corbits-triage-setup`) in that repository. Once it is merged, the hub picks it up within a few minutes; no restart is needed.

## 6. Turn triage on

The person opens the repository under Repositories and turns on **Triage pull requests in this repository**. If the repository has no open pull request, open one so there is something to triage. Done when a verdict appears in the Inbox, which can take up to five minutes.

Code review is optional and needs an isolated place to run: `docs/SELF_HOST.md`, "Where sidecars run".

## Checklist

- [ ] Checkout found; path chosen
- [ ] Secrets set once, never printed; person keeps a copy
- [ ] Hub logs `Started server`; portal opens
- [ ] Person signed up, created the GitHub App, chose repositories, saved the model key
- [ ] Policy file merged
- [ ] Triage on; first verdict in the Inbox
