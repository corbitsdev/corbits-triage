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
reported on it. `--e2e` scores the finders' union, the consolidated findings,
those the check kept (all of them unless `--check`), refuted and left
uncertain, the final review, and the review's comments found by both finders
and by one. A bug caught by a refuted finding is one the check wrongly
dropped.

## Running

Needs `gh` signed in (to fetch cases and check heads out) and
`ANTHROPIC_API_KEY`, or `OPENCODE_API_KEY` for OpenCode Zen.

```sh
bun run eval:review -- --e2e \
  --plan-model claude-haiku-5-5 --diff-finder-model claude-opus-5-5 \
  --repo-finder-model claude-haiku-5-5 --consolidate-model claude-haiku-5-5 \
  --write-model claude-haiku-5-5 --write-effort low --out e2e.json
```

`--cases a,b` runs a subset. `--check` turns the check step on, with
`--check-model` and `--check-effort` for it. Other modes, listed at the top of
`review.eval.ts`: a finder alone with any prompt (`--prompt`) and rescoring
saved finder runs (`--rescore`).

## Current numbers

All 25 cases, the models above, no check, every other step at medium effort:

| Stage | Bugs caught | diff | repo | intent | Findings | False alarms | Clean flagged |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Finders' union | 45/52 | 23/24 | 20/26 | 2/2 | 142 | 47 | 2/3 |
| Consolidated | 44/52 | 23/24 | 19/26 | 2/2 | 92 | 34 | 2/3 |
| Final review | 44/52 | 23/24 | 19/26 | 2/2 | 92 | 34 | 2/3 |
| Found by both finders | 28/52 | 16/24 | 11/26 | 1/2 | 42 | 11 | 1/3 |
| Found by one finder | 25/52 | 11/24 | 12/26 | 2/2 | 50 | 23 | 1/3 |

$3.25 in all, $0.13 a pull request on average, 60 seconds each; the Opus diff
finder is $2.86 of it. The earlier pipeline, which dropped findings it could
not ground in the file and ran an Opus check on the rest, caught 32/52 with 15
false alarms and flagged 0/3 clean cases.

On 42 held-out public pull requests with known bugs (none of them among the
25 cases), scored on their core bugs:

| Pipeline | Precision | Recall | F1 | Per pull request | Seconds |
| --- | --- | --- | --- | --- | --- |
| Earlier, with the check | 51.9 | 40.6 | 45.6 | $0.189 | 91 |
| Every finding, no check | 35.8 | 60.9 | 45.1 | $0.136 | 71 |

Of the comments in the second run, those both finders reported score
precision 46.3 and recall 37.6; those one finder reported, 26.7 and 27.1. The
agreement line on each comment carries that signal to the reader instead of a
filter.

## The check

The same models on the 25 cases, the check at medium effort. "Before" is the
same run's consolidated findings, so finder variance between runs drops out.

| Check | Bugs caught before → after | False alarms before → after | Refuted (real bugs among them) | Uncertain | $ per PR |
| --- | --- | --- | --- | --- | --- |
| Old (keep only `real`), Haiku | 44 → 23 | 37 → 9 | 55 dropped | - | 0.13 |
| Disproof only, Haiku | 43 → 40 | 43 → 35 | 12 (4) | 43 | 0.13 |
| Disproof only, Opus | 42 → 42 | 44 → 34 | 12 (3) | 2 | 0.28 |

On the 42 Martian Code Review Bench pull requests outside these cases (Core
profile, Claude Opus 4.5 judge), precision / recall / F1:

| Check | Before | After | Real bugs dropped |
| --- | --- | --- | --- |
| Old, Haiku | 36.7 / 60.2 / 45.6 | 53.6 / 27.8 / 36.6 | 45 |
| Disproof only, Haiku | 37.0 / 60.2 / 45.8 | 37.3 / 56.4 / 44.9 | 4 |
| Disproof only, Opus | 35.7 / 57.1 / 43.9 | 37.7 / 51.9 / 43.7 | 6 |

Recall varies by about four points between runs of the same pipeline.
