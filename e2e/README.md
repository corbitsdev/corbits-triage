# e2e

Live checks against real services. They create real resources and can cost money, so CI never runs them and `bun run test` does not include them; run them by hand.

Each takes its token from `--token-file <path>` or on standard input, and never prints it or passes it in arguments or the environment. Each removes everything it created, and only that.

| Script | Command | Creates |
| --- | --- | --- |
| E2B provisioner | `bun e2e/provisioners/e2b.ts --token-file <E2B API key file>` | About ten E2B sandboxes from the sidecar template, for a few minutes ([e2b.md](../docs/provisioners/e2b.md#proving-it-against-e2b)) |
| Railway provisioner | `bun e2e/provisioners/railway.ts --token-file <Railway workspace token file> --environment <environment id> --commit <pushed commit>` | About ten Railway sandboxes built from that commit ([railway-sandboxes.md](../docs/provisioners/railway-sandboxes.md#proving-it-against-railway)) |
| Extension | `printenv GITHUB_TOKEN \| bun --conditions=intx-src e2e/verify.ts <owner/repo> <number>` from `apps/extension`, after `bun run build` ([README.md](../apps/extension/README.md#test)) | Nothing; reads one pull request and saves a screenshot to `apps/extension/.output/e2e/` |

The two provisioner scripts run the conformance suite from [`@corbits/provisioner-test`](../packages/provisioner-test/README.md), then the provisioner's own cleanup.
