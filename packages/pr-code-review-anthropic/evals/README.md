# Code review eval

Runs the real `pr-code-review` workflow (through `runLocal` and the stock step
invoker) on real pull requests and scores what it reports against validated
answer keys.

## Cases

25 merged or reviewed pull requests from 16 repositories: our own
(`corbits-code`, `corbits-triage`, `interchange`), public review benchmarks
(Sentry, Grafana, Keycloak, Cal.com, Discourse, astropy, scikit-learn, seaborn,
Sphinx) and other open source projects (vLLM, GoFr, Linera). 22 introduce at
least one defect, 52 in all; 3 are clean.

- `cases.json`: each case's repository, pull request number and the base and
  head shas it was labelled at.
- `labels/<id>.json`: the case's answer key: `verdict` (`defect` or `clean`)
  and its `bugs`, each with head-side line `sites`, a `reach` and the
  `evidence` that proves it.
  - `diff`: visible from the changed lines (24 bugs).
  - `repo`: needs code outside the diff (26).
  - `intent`: needs product knowledge beyond the code (2).
- `.cache/` (not in git): each pull request's title, description and diff,
  fetched once with `gh api`.

## How the answer keys were validated

Each key started from the case's original label (its benchmark's, or the fix
that followed the pull request) and was then made complete:

1. A full independent review of the diff and the changed files at head,
   following callers, callees and contracts in the repository, listing every
   defect the change introduces. Style and pre-existing problems are not
   defects.
2. Every original label kept, re-anchored to the lines a fix changes, merged
   with its sibling sites, or rejected with the reason.
3. Every distinct finding any model made on the case in earlier runs
   adjudicated: the same as a known bug, a new real bug (added), or not a bug
   (listed under `rejected` with the line that disproves it). `adjudicated`
   counts them and `complete: true` marks the key done.

A clean case becomes a defect case only with a confirmed added bug.

## Scoring

A bug is caught when a finding on its path overlaps any of its sites within
three lines. A finding that hits no bug is a false alarm, so a complete key
makes false alarms meaningful. A clean case is flagged when anything is
reported on it. `--e2e` scores five stages: the finders' union, after merge,
after converge, the confirmed candidates and the final review.

## Running

Needs `gh` signed in (to fetch cases and check heads out) and
`ANTHROPIC_API_KEY`, or `OPENCODE_API_KEY` for OpenCode Zen.

```sh
bun run eval:review -- --e2e \
  --plan-model claude-haiku-5-5 --diff-finder-model claude-opus-5-5 \
  --repo-finder-model claude-haiku-5-5 --converge-model claude-haiku-5-5 \
  --check-model claude-opus-5-5 --write-model claude-haiku-5-5 --write-effort low \
  --out e2e.json
```

`--cases a,b` runs a subset. Other modes, listed at the top of
`review.eval.ts`: a finder alone with any prompt (`--prompt`) and rescoring
saved finder runs (`--rescore`).

## Current numbers

All 25 cases, the models above, every other step at medium effort:

| Stage | Bugs caught | diff | repo | intent | Findings | False alarms | Clean flagged |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Finders' union | 42/52 | 21/24 | 20/26 | 1/2 | 129 | 47 | 1/3 |
| Merged | 42/52 | 21/24 | 20/26 | 1/2 | 107 | 42 | 1/3 |
| Converged | 42/52 | 21/24 | 20/26 | 1/2 | 92 | 38 | 1/3 |
| Confirmed | 32/52 | 18/24 | 14/26 | 0/2 | 53 | 15 | 0/3 |
| Final review | 32/52 | 18/24 | 14/26 | 0/2 | 53 | 15 | 0/3 |

$4.56 in all, $0.18 a pull request on average, 78 seconds each; the Opus diff
finder is $2.82 of it and the Opus check $1.38. The check drops 10 real bugs
to remove 23 false alarms, and runs vary: the same configuration once gave 32/52
with 4 false alarms.
