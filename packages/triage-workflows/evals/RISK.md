# Regression-risk backtest

`bun run eval:risk` walks the first-parent history of each repository at a pinned commit and, for every change older
than 14 days, computes the regression-risk signals from the history before it and whether it regressed: a later commit
whose message says fix, hotfix or revert, within 14 days, rewrote one of its lines (blame on the fix's parent). It prints
each signal's lift (the regressed rate among flagged changes over the base rate) at several thresholds. It reads public
git history only and asks no model.

- **Repositories:** corbitsdev/corbits-triage and honojs/hono, cloned into `evals/.cache/` on first run.
- **Signals:** hot files as the rule reads them (fixes on one changed file, tests, docs and lockfiles left out, in the
  last 30 days); migrations as the rule's default globs; fan-in (files outside the change that reference an export it
  changes), which needs a checkout and so is measured here but not read by the rule.
- **Defaults:** the rule's `hotFileFixes` is the lowest threshold whose lift on hono is well over 2x at a precision a
  maintainer can act on.

Results at corbits-triage 5938a648 and hono 5ca49b07:

| Signal | corbits-triage (76 changes, base 55%) | hono (2236 changes, base 15%) |
| --- | --- | --- |
| hot file ≥ 3 fixes | 1.25x, 17% flagged | 1.93x, 17% flagged |
| hot file ≥ 4 fixes | 1.27x, 13% flagged | 2.25x, 9% flagged |
| hot file ≥ 5 fixes (default) | 1.36x, 11% flagged | 2.49x, 5% flagged |
| fan-in ≥ 5 files | 1.61x, 12% flagged | 2.64x, 5% flagged |
| migration | 1.81x, 1 change | no migrations |

corbits-triage is too young to judge a signal: with a 55% base rate no signal can pass 1.82x.
