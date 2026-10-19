# @corbits/web

The Corbits Triage portal (Vite, React, React Router). It talks to the hub through `@intx/hub-client` and deploys the
workflow packages to it.

## Use

`bun run dev` at the repository root runs the hub and the portal. Here:

```sh
bun run dev        # pack the workflows, then Vite
bun run build      # pack the workflows, typecheck, build
bun run workflows  # pack the workflows into public/packages/ only
```

Build-time variables: `VITE_HUB_URL` (the hub's origin when the portal is hosted apart), `VITE_GITHUB_API_ORIGIN`
(the GitHub API origin, such as an emulator's) and `VITE_WORKSPACE_SLUG` (default `corbits-triage`).

## Test

```sh
bun --conditions=intx-src test apps/web
```

## Docs

- [User Manual](../../docs/Corbits%20Triage%20User%20Manual/Corbits%20Triage%20User%20Manual.md)
- [DESIGN.md](../../DESIGN.md)
- [IMPLEMENTATION.md](../../docs/IMPLEMENTATION.md)
