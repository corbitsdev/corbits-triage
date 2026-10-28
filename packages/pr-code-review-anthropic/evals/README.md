# Code review eval

Runs the real `pr-code-review` workflow (through `runLocal` and the stock step
invoker) on real pull requests and scores what it reports against validated
answer keys.

## Cases

Ten pull requests from [ReviewBench](https://github.com/review-bench/ReviewBench)
(MIT), with answer keys converted from its `golden/` files: seven from its
25-pull-request test set, listed in its `corpus/test/test.json`, and three
clean ones from its full corpus.
The set is kept small and hard: the target is a score under 30% for the current
reviewer at 25 to 50 cents a run.

Selection rule, over the test set unless stated, leaving out pull requests that
change more than 1,500 lines so a run stays cheap:

- Security: the three with the most high or medium security findings labelled
  true that need code outside the diff (`mcp-docker-29`,
  `statswales-frontend-626`, `techdebtmcp-135`).
- Correctness: the four with the most high or medium correctness findings
  labelled true and `hard`, all needing code outside the diff; ties go to the
  smaller diff (`disaster-ninja-fe-1230`, `crabtrap-15`, `jadx-collaboration-3`,
  `landalf-88`).
- Clean: every test-set pull request has true golden findings, so false alarms
  are measured on three from outside the test set: the two in the corpus whose
  golden findings are all false (`statista-130`, `cli-microsoft365-7191`) and
  `wspulse-client-ts-18`, whose only true finding is a low testing one.

- `cases.json`: each case's repository, pull request number and the base and
  head shas from its golden file's `pr`.
- `labels/<id>.json`: the case's answer key, with `source: "reviewbench"` and
  the `golden` file it came from. Every true-labelled golden finding in the
  `correctness` or `security` category is a bug: its `sites` are the finding's
  file and `start_line` to `end_line` at head, its `reach` is `diff` for
  `diff-only` and `repo` for the other `context_required` values, its
  `evidence` is the finding's message, and its `severity`, `category` and
  `difficulty` are kept. Other true-labelled findings (style, testing,
  maintainability, documentation and the like) are listed under `ignored`, with
  their sites. Every false-labelled finding is listed under `rejected` with
  ReviewBench's reason. 37 bugs in all, 36 of them needing code outside the
  diff.
- `.cache/` (not in git): each pull request's title, description and diff,
  fetched once with `gh api`, with the title and description cleaned as the
  hub sends them (`<id>.shown.json`).

## Scoring

A bug is caught when a finding on its path overlaps any of its sites within
three lines; findings are not matched on their message. Each bug is caught
once: a finding that hits only bugs earlier findings already caught is a false
alarm, so splitting one defect into several findings costs precision, as
ReviewBench scores it. A finding that catches no bug but hits an `ignored`
finding's site is neither a catch nor a false alarm. Any other finding is a
false alarm, and a clean case is flagged when it has one. `--e2e` checks every
finding, as every review does, and scores the finders' union, the consolidated
findings (what the review posted before the check ran on every request), the
ones the check confirmed, the final review, and the review's comments found by
both finders and by one. A stage's precision is its findings that caught a bug
over its findings that caught a bug or were false alarms, so the consolidated
and final rows give precision and recall without the check and with it from
one run.

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
with the triage judge eval, in `packages/triage-workflows/evals/`. No baseline
is committed yet: the first paid run on these cases records it. Rerun and
commit it when a change moves the numbers.

Every `--e2e` run ends with the final review's score (bugs caught and false
alarms) and its total cost.

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
