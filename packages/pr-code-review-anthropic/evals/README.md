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
  fetched once with `gh api`, with the title and description cleaned as the
  hub sends them (`<id>.shown.json`; an older `<id>.json` holds them raw and is
  not read).

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
reported on it. `--e2e` checks every finding, as every review does, and
scores the finders' union, the consolidated findings (what the review posted
before the check ran on every request), the ones the check confirmed, the
final review, and the review's comments found by both finders and by one. A
stage's precision is its findings that hit a bug over all its findings, so the
consolidated and final rows give precision and recall without the check and
with it from one run.

## Running

Needs `gh` signed in (to fetch cases and check heads out) and
`ANTHROPIC_API_KEY`, or `OPENCODE_API_KEY` for OpenCode Zen.

```sh
bun run eval:review -- --e2e --out e2e.json
```

Each step runs on the model it is deployed with: Opus 5.5 for the diff
finder, Haiku 5.5 for the rest. `--<role>-model` overrides one.

`--cases a,b` runs a subset. Other modes, listed at the top of
`review.eval.ts`: a finder alone with any prompt (`--prompt`) and rescoring
saved finder runs (`--rescore`).

## Baseline

`bun run eval:review -- --e2e --baseline` runs every case and writes
`evals/results/pr-code-review.baseline.json`: the commit, each step's
provider and model, each provider and model's tokens with its price, source
and `pricesAsOf` date, the cost (null where a used price is unknown), every
case's bugs caught and missed and where each finding sat with the bug it hit,
and each stage's totals. It refuses on a dirty working tree or when any case's
repository is not public. The writer and the price table it reads are shared
with the triage judge eval, in `packages/triage-workflows/evals/`. The
committed file is the baseline for the commit it names; rerun and commit it
when a change moves the numbers.

### Numbers (2026-10-21)

Final review, on descriptions cleaned as the hub sends them: 43/52 bugs caught
(diff 22/24, repo 19/26, intent 2/2), 39 false alarms, 3/3 clean cases flagged,
$3.10 for all 25 cases; the Opus diff finder is $2.78 of it. Findings both
finders reported caught 33/52 with 11 false alarms. Every stage's totals are in
the committed file.

## Posting threshold

`bun run eval:review -- --rescore <e2e.json> [--out sweep.json]` replays a saved
`--e2e` run with no model calls. Each final review comment gets its group's top
finder confidence, finder agreement and priority from the saved step outputs;
every cutoff (a confidence for comments one finder reported, one for those both
did, and a highest priority) is scored as the final review is. A comment
without a priority passes only a cutoff that allows any priority. The run is
refused unless keeping every comment scores as the saved run did and every
comment carries a confidence. It prints the precision and recall frontier and
the loosest cutoff at a fixed 85% precision bar, with recall by reach, clean
cases left silent, comments per pull request and pull requests commented on.

On the run behind the 2026-10-21 baseline, the loosest cutoff at 85% posts a
one-finder comment at confidence 0.75 or more and a both-finder comment at 0.6
or more: precision 85.3%, 26/52 bugs caught (diff 15/24, repo 11/26, intent
0/2), 5 false alarms, 3/3 clean cases silent, 1.36 comments per pull request.
On the run before it, on raw descriptions, the same cutoff scores 82.9% and
27/52, so the cutoff is tuned on 25 cases and moves between runs. It has not
been checked on the 42 held-out pull requests: their saved runs carry no finder
confidence.

### Held-out numbers (2026-10-16)

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
