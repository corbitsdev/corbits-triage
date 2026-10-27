# Deploy

The hub starts from the variables in `.env.example`. None of them is a judge or a model provider. Those are not required at startup.

Setup in the portal's **Set up Triage** asks for a host connection, a GitHub App or Bitbucket Data Center, and nothing else (Connect a source, then Repositories). A decision model is not a startup variable. Triage does not start until one is saved under Settings → Triage. Judgement rules are the ones that use that model.

How to run the hub, and the portal steps, are in [SELF_HOST.md](SELF_HOST.md). Local setup is in [DEV.md](DEV.md).
