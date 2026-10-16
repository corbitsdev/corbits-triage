# Repository scan eval

`bun run eval:scan` runs the `repo-scan` definition on Interchange's local runner, with the production step invoker,
agents and directors, over GitHub responses recorded in `scan-fixtures/`. It prints, for each repository, how many of
its last 100 closed pull requests were merged and the merged-against-closed counts on each side of every measured
signal.

- **Repositories:** corbitsdev/corbits-triage and honojs/hono.
- **Fixtures:** one gzipped JSON per repository: every GitHub response the run read, slimmed of links, patches, check
  output and repository objects, which the scan does not read. `heads` names the head sha of each pull request, so a
  fixture is pinned to those commits.
- **Refreshing:** `bun run eval:scan --record` reads GitHub live through `gh` (it must be signed in) and rewrites the
  fixtures. A replay that asks for a response the fixture does not hold fails and names it.
- **Reporting:** a pull request that changes the scan states the eval's output before and after.
