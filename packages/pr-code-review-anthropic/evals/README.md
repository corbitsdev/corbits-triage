# Code review eval

Runs the real `pr-code-review` workflow (through `runLocal` and the stock step
invoker) on real pull requests and scores what it reports against validated
answer keys.

## Cases

Ten pull requests from [ReviewBench](https://github.com/review-bench/ReviewBench)
at commit `228f2a8d`, with answer keys converted from its `golden/` files:
seven from its 25-pull-request test set, listed in its
`corpus/test/test.json`, and three clean ones from its full corpus. The keys
quote ReviewBench's golden messages and reasons under its MIT license,
reproduced in [LICENSE-reviewbench](LICENSE-reviewbench). The set is kept
small and hard: the target is a score under 30% for the current reviewer at 25
to 50 cents a run.

Selection rule, over the test set unless stated, leaving out pull requests
whose `lines_added + lines_removed` in `corpus/manifest.json` is over 1,500 so
a run stays cheap. That field counts each pull request as it is now, not at
its golden shas: `techdebtmcp-135` counts 3 lines, while its diff at the golden
shas adds about 300.

- Security: the three with the most high or medium security findings labelled
  true that need code outside the diff (`mcp-docker-29`,
  `statswales-frontend-626`, `techdebtmcp-135`).
- Correctness: the four with the most high or medium correctness findings
  labelled true and `hard`, all needing code outside the diff; ties go to the
  smaller diff (`disaster-ninja-fe-1230`, `crabtrap-15`, `jadx-collaboration-3`,
  `landalf-88`).
- Clean: no test-set pull request has findings that are all false, so false
  alarms are measured on three from the full corpus, none with a true
  correctness or security finding:
  - `cli-microsoft365-7191`: at least one finding, all false. The only other
    such pull request, `statista-130`, is left out: its diff is mostly a
    deleted licence and its false findings are licence nits.
  - `healthstream-rag-34`: the most high or medium false correctness or
    security findings (three).
  - `wspulse-client-ts-18`: its only true finding is a low testing one.

- `cases.json`: each case's repository, pull request number and the base and
  head shas from its golden file's `pr`, and under `reviewbench` the
  ReviewBench commit and golden file the case was built from.
- `labels/<id>.json`: the case's answer key, with `source: "reviewbench"` and
  the `golden` file it came from.
  - `bugs`: the true-labelled golden findings in the `correctness` or
    `security` category, with findings whose line ranges overlap in one file
    merged into one bug, so recall counts flagged line ranges: distinct
    defects on overlapping lines count as one bug, so a finding on those lines
    is one catch and a second finding there is a false alarm. A bug's `sites` are its findings' file and `start_line` to `end_line` at
    head, its `reach` is `diff` when any of its findings is `diff-only` and
    `repo` otherwise, and `golden` keeps each finding's message (`evidence`),
    `severity`, `category` and `difficulty`. 24 bugs from 37 findings, 23 of
    them needing code outside the diff.
  - `ignored`: the other true-labelled findings (style, testing,
    maintainability, documentation and the like), with their sites.
  - `rejected`: every false-labelled finding, with ReviewBench's reason.
- `.cache/` (not in git): each pull request's title, description and diff,
  fetched once with `gh api`, with the title and description cleaned as the
  hub sends them (`<id>.shown.json`).

## Scoring

A finding hits a site on its path when it overlaps it within three lines;
findings are not matched on their message. Findings are scored in order:

- A finding that hits a bug no earlier finding caught catches it.
- A finding that hits only bugs already caught is a false alarm, so splitting
  one defect into several findings costs precision.
- A finding that hits no bug uses up the first `ignored` item it hits that no
  earlier finding used, and is neither a catch nor a false alarm.
- Any other finding is a false alarm. A clean case is flagged when it has one.

`--e2e` checks every finding, as every review does, and scores the finders'
union, the consolidated findings (what the review posted before the check ran
on every request), the ones the check confirmed, the final review, and the
review's comments found by both finders and by one. A stage's precision is its
findings that caught a bug over its findings that caught a bug or were false
alarms, so the consolidated and final rows give precision and recall without
the check and with it from one run.

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
did, and a highest priority) is scored as the final review is. The run is
refused unless keeping every comment scores as the saved run did and every
comment carries a confidence. It prints the precision and recall frontier and
the loosest cutoff at a fixed 85% precision bar, with recall by reach, clean
cases left silent, comments per pull request and pull requests commented on.
