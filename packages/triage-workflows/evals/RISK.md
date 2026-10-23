# Regression-risk backtest

`bun run eval:risk` walks the first-parent history of each repository at a pinned commit and, for every change older
than 14 days, computes the regression-risk signals and whether it regressed: a later change titled as a fix or revert
(`fix:`, `fix(scope):`, `bugfix:`, `hotfix`, `revert`, `Revert "…"`), within 14 days, rewrote one of its lines (blame on
the fix's parent). Each file's history is read as the host tools read it: every commit on the branch before the change
that touched the file in the last 30 days, feature-branch commits included, counted by the same subject rule as the
live rule. It prints each signal's lift (the regressed rate among flagged changes over the base rate) on the earlier
half of the history and, held out, on the later half. It reads public git history only and asks no model.

- **Repositories:** corbitsdev/corbits-triage and honojs/hono, cloned into `evals/.cache/` on first run.
- **Signals:** hot files as the rule reads them (tests, docs and lockfiles left out); migrations as the rule's default
  globs; fan-in (files outside the change that reference an export it changes), which needs a checkout and so is
  measured here but not read by the rule.
- **Default:** `hotFileFixes: 4` is the lowest threshold with 2x lift on hono's earlier half. It was set on hono alone
  and must be checked per repository: corbits-triage is too young to judge, and a repository with another commit style
  counts fixes differently.

Results at corbits-triage 5938a648 and hono 5ca49b07 (lift, share flagged):

| Signal | hono earlier (1118, base 11%) | hono later, held out (1118, base 6%) | corbits-triage later (38, base 42%) |
| --- | --- | --- | --- |
| hot file ≥ 3 fixes | 1.90x, 14% | 3.18x, 4% | 1.28x, 34% |
| hot file ≥ 4 fixes (default) | 2.03x, 6% | 3.39x, 2% | 1.43x, 26% |
| hot file ≥ 5 fixes | 2.64x, 3% | 2.42x, 1% | 1.48x, 21% |
| fan-in ≥ 5 files | 3.09x, 7% | 5.93x, 4% | 2.38x, 11% |
| migration | none | none | 2.38x, 1 change |

Flagged counts at the default are small (65 and 25 changes on hono), so the lift is noisy.
