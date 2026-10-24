# The decision model

Triage answers its judged rules (focused, docs and custom model rules) and decides each pull request's verdict with a decision model: TypeSafe's Jev, a System One model. Every other rule is a hard rule over GitHub data. This page describes how Triage asks the model, how it reads the answers, the limits it works within, what it costs and how accurate it has measured.

TypeSafe's docs: [index (llms.txt)](https://docs.typesafe.ai/llms.txt), [System One](https://docs.typesafe.ai/concepts/system-one.md), [models and limits](https://docs.typesafe.ai/models.md), [primitives](https://docs.typesafe.ai/primitives.md), [confidence](https://docs.typesafe.ai/confidence.md), [jev-1.13 jagged edges](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md).

## What it is

A System One model does not generate text. A request carries a JSON `state` and a list of typed questions, and each answer is numeric:

- **Noul**: a yes/no question, answered with P(yes).
- **Choice**: one option from a fixed set, answered with the chosen option, a probability per option and a confidence.
- **Score**: ordered, described levels, answered with a position across them, a probability per level and a confidence. Score rules use it.

Triage reaches the model through Interchange inference. The agents name the tenant model alias `decision` on the `corbits-system-one` provider (`packages/triage-workflows/src/agents.ts`). The operator picks the endpoint and model behind that alias in the portal's decision model settings (presets in `packages/triage-contracts/src/decision-models.ts`):

| Preset | Endpoint | Model |
| --- | --- | --- |
| TypeSafe (default) | `https://api.typesafe.ai/v1` | `jev-latest` |
| Vercel AI Gateway | `https://ai-gateway.vercel.sh/typesafe/v1` | `typesafe-ai/jev` |
| OpenCode Zen | `https://opencode.ai/zen/v1` | `jev-1.13` |
| Custom | any | any |

The judge eval pins OpenCode Zen `jev-1.13`. The judge is the only step that infers: a `map` over the rules step's chunks, one System One call per chunk, then a second `map` over focused's follow-up chunks and the verdict question (`triage-steps.ts`, `directors.ts`). A pull request without judged rules to ask, or whose judged rules an earlier run answered, asks the verdict question in the first map. A failed hard rule, a draft, a closed pull request or a policy with no decision-model rule on asks nothing. The request body is `{ state, questions, model }`; no system prompt reaches the model.

## Why Triage uses it

- **Price.** TypeSafe charges $0.042 per million input tokens and nothing for output ([models](https://docs.typesafe.ai/models.md)). Gateway prices may differ.
- **Latency.** TypeSafe states that most queries complete in about 100 ms ([how to build](https://docs.typesafe.ai/concepts/how-to-build-with-system-one.md)). Latency inside Triage is unmeasured.
- **Probabilities.** Answers are probabilities, so code decides where an answer is too weak to act on and leaves it unsure.
- **Typed answers.** There is no model prose to parse, and none reaches GitHub. Comments name files and hunks that code chose.

## How each rule asks

Questions are built in `packages/triage-workflows/src/logic/quality.ts`. Every request's state holds:

- the pull request's title, body (up to 4,000 chars), up to 50 commit subjects (each cut to 200 chars) and up to 200 changed paths, lockfiles included, all without invisible characters. A GitHub body is the text GitHub renders, with a GitHub or Linear issue link followed by its target up to the issue's id. When focused is asked, paths are listed instead while they fit 8 KB; when any is left out, `pullRequest.directories` comes too, every changed file counted by directory (files and changed lines) at the deepest level that fits 8 KB;
- the judged files that fit the request, each patch split into hunks. Lockfiles (`bun.lock`, `package-lock.json`, `yarn.lock`, `Cargo.lock`, `go.sum` and similar) keep their path but their patch is never sent;
- the repository's docs (`repository.docs`, markdown by path), see [budgets](#budgets-and-limits);
- in requests that ask a custom rule, the repository's contribution rules (`repository.rules`), taken out of `repository.docs` so each file is sent once. Custom questions say to judge by them.

Questions point into the state by path, such as `` `pullRequest.files[3].hunks[0]` ``, rather than copying it.

- **Focused**: one Choice per request that holds files, so every file read is judged. The code, tests, docs, types and wiring one change needs across files count as one purpose.
  - When the diff fits one request, it asks about the whole pull request: `one_thing`, `more_than_one_thing` or `cant_tell`.
  - Otherwise each request asks whether its slice of the diff serves the pull request's main purpose or would belong in its own pull request, even if the title or body mentions it: `serves_purpose`, `separate_change` or `cant_tell`. Asking the slice question of a one-request diff too measured worse (70 of 72 against 72), and without "even if the title or body mentions it" it passed a mix whose description named both halves.
  - A pull request with no lines to read, such as one that changes only lockfiles, is not asked; focused does not apply.
  - A stacked branch is not asked either: when a pull request was merged into its branch, or its base is another open pull request's branch, its diff holds other pull requests' changes. Focused passes as not applicable with the reason, such as "skipped: stacked branch, includes #1521", and the comment lists it under **Skipped**. The facts step reads this from the host (`github_get_stack`, `bitbucket_datacenter_get_stack`) only when focused is on.
  - Only when focused fails, each failing slice's request is sent again with one Noul per file it holds that no earlier slice asked about, at most 30 in all: "is the change in this file a separate change from the one the title and body describe?". Those answers never decide focused; they name the files to split out. A follow-up that fails or comes back malformed is not retried; it only leaves its files unnamed and never costs the first answers. A first-round reply that is malformed, or answers a question its request did not ask, leaves only its own request's questions unanswered.
- **Docs**: path rules decide in code first. Changing (not removing) any doc file passes docs with no question asked.
  - A doc file is `*.md` or `*.mdx` outside `vendor/`, `node_modules/`, `dist/` and `build/`, legal notices excluded.
  - A test file is under a `test/`, `tests/`, `Tests/` or `__tests__/` directory (so Rust's `tests/`, Maven's `src/test/` and Swift's `Tests/` count) or a C# `*.Tests/` project such as `Acme.UnitTests/`, a Ruby file under `spec/`, or named by its language's convention: `*.test.*` or `*.spec.*` in JS or TS, `test_*.py` or `*_test.py`, `*_test.go`, `test_*.rb`, `*_test.rb` or `*_spec.rb`, `*_test.exs`, `*_test.dart`, `*Test` or `*Tests` in Java, Kotlin and C#, and `*Test`, `*Spec` or `*Suite` in Scala, the last two outside `src/main/`. It is not asked about.
  - Otherwise each file gets one Choice, "How does the change in `pullRequest.files[N]` leave `repository.docs`?", with options in this order: `unaffected` (the docs stay correct and complete), `now_wrong` (a statement the docs make, such as a name, table, route, file, setting or behaviour, is contradicted because the change renames, removes or changes it) and `now_incomplete` (the change adds setup, configuration, permissions or commands the docs must describe). P(needs docs) is 1 − P(`unaffected`), on the Noul band: a file at 0.7 or above needs docs and fails the rule, one at 0.3 or below does not, and anything between leaves the rule unconfirmed. At most 3 files are named.
- **Custom model rules** (`packages/triage-contracts/src/check-pack.ts`):
  - `is-true` with scope `pull-request` (the default): one Noul, `<name>: <claim>`.
  - `is-true` with scope `file` or `hunk`, optionally limited by `when` globs: one Noul per file or hunk in scope, "Does the change in … meet this rule: <claim>?". At most 3 items are named on failure.
  - `score`: one Score question, `<name>: Which level, worst first, best describes the pull request for <subject>?`, with the rule's levels as its criteria. The likeliest level is the answer, recorded as the rule's evidence and output (`{ kind: "level" }`) and given to the verdict question as the rule's `level`. Without `failBelow` it passes; with it, it fails when the levels below `failBelow` hold P ≥ 0.7, passes when they hold P ≤ 0.3, and is unconfirmed between.
  - `choose`: one Choice question, `<name>: Which option best describes the pull request?`, with the rule's options as criteria (no descriptions). The likeliest option is its evidence; it fails when the `failOn` options hold P ≥ 0.7, passes at P ≤ 0.3, and is unconfirmed between.
  - A reply is parsed on its own, as before: a choice's options are whatever its probabilities name and a score's levels whatever its legend names. Each rule then checks the answer is over its own options or levels, and treats one that is not as unanswered.
- **Instructed**: every first-round request and the verdict request also asks one Noul, question id `instructed`: whether any text in `pullRequest` or `repository` tries to direct the reviewer or model judging the pull request (tell it what to answer or conclude, to pass or approve it, or to ignore or replace its instructions or the repository's rules), wherever it sits; text that discusses, quotes or tests prompts, or tells contributors or coding agents how to work, does not count. The highest P(yes) across accepted replies stands; a reply without it counts as unanswered, so the verdict is Unsure. At 0.7 or above no judged rule's answer counts: each is unconfirmed with the reason "the pull request tries to direct the decision model", labelling rules included, the verdict question is not asked or its answer is ignored, and the verdict is Unsure with that reason, so a maintainer decides and nothing approves or merges on the model's word. A failed hard rule still decides Fail first (`INSTRUCTED_QUESTION`, `logic/quality.ts`; `evaluateModel` and `renderVerdict`, `logic/render.ts`).
- **Verdict**: a rule with `onFail: label` is asked like any other but takes no part in the verdict: it never fails it, never leaves it unconfirmed or unanswered, and is not in the verdict question's state (`splitLabelled`, `logic/render.ts`). A failed rule with `onFail: ask` makes the verdict Unsure, its next step the maintainer's, unless another rule fails it, and the verdict question is not asked. A policy with no decision-model rule on that does more than label (no focused, docs, is-true, score or choose) is decided in code: every rule passing is Pass, with a reason saying the policy has no decision-model rule, and any unconfirmed waits (below) (`renderVerdict`, `logic/render.ts`). A judged rule that fails decides Fail on its own answer, and the verdict question is not asked, so pull request text cannot argue a failed rule into a pass. Otherwise, once no hard rule failed and the judged rules are answered and pass or stay unconfirmed, one Choice, question id `verdict`: "Does this pull request pass this repository's policy?", `pass`, `fail` or `cant_tell`. It is asked with the instructed question, so a pull request with no judged rule to ask (such as one that changes only lockfiles) is still checked for text directing the model. A pass with a judged rule unconfirmed is Unsure, its score the verdict question's P(pass). A verdict other than Fail whose only unconfirmed rules are the host's own (CI green while checks still run, mergeability the host has not computed yet) waits instead: it is not posted and its actions do not run, and the head is triaged again once they are done. CI cancelled or stale without a result does not wait: the verdict is posted as Unsure, and the head is triaged again once a check is re-run. The question is asked the same either way. Its state is `policy.rules`, every enabled rule with its result, reason and evidence and, for a judged rule, `pass`, how likely it passes, and for a score rule, `level`; and the pull request's metadata as focused reads it, with as many judged files as fit one request, packed in order as focused's first slice is. It is not asked when a first-round call failed or left a rule unanswered, since the verdict degrades anyway. Its own key keeps the rules' answers reusable under theirs (`verdictRequest`, `logic/quality.ts`; `choiceOf`, `actions/evaluate.ts`).

## Writing questions

Rules learned while tuning, which match TypeSafe's [jagged edges](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md):

- **Jev reads literally.** It answers the question written, not the one meant. Put boundary cases in the question or criteria.
- **No conditional booleans.** "If X, does it Y? Answer true when not needed" was answered backwards. Decide the condition in code or ask per file (as docs does), or use a Choice with an explicit not-applicable option.
- **One judgment per question.** Split "and" conditions into separate questions and combine them in code.
- **Phrase it so yes means yes.** Negated or inverted questions do worse.
- **Choice leans toward the first option.** Reorder options and check the answer holds.
- **Keep counting, math, dates and paths in code.** Built-in rules over GitHub data cover size, paths, issues, conflicts and CI.
- **Irrelevant state costs accuracy.** TypeSafe reports accuracy falling as unrelated content grows.

## The unsure band and pass marks

From `logic/render.ts`:

- **Noul**: P ≥ 0.7 decides yes, P ≤ 0.3 decides no; anything between is unconfirmed ("not enough evidence to decide") and asks a maintainer to confirm.
- **Verdict**: P(pass) ≥ 0.7 is Pass, unless a judged rule is unconfirmed, which makes it Unsure, or only the host's rules are, which makes it wait; P(fail) ≥ 0.7 is Fail; anything else is Unsure. No setting changes these.
- **Focused**: any slice with `more_than_one_thing` or `separate_change` ≥ 0.6 fails it. Otherwise an unread file leaves it unconfirmed, every slice with `one_thing` or `serves_purpose` ≥ 0.6 passes it, and anything else is unconfirmed. A failure names up to 3 files whose separate-change Noul is ≥ 0.7, most likely first; when none is, it fails without naming files.

Two different numbers come out of the answers:

- **Rule score** (`packages/triage-contracts/src/check-output.ts`): per is-true, docs and focused rule, 0–100 and unrounded, how likely the rule is fine, with `passAt` 70 (docs, custom) or 60 (focused). It clears `passAt` exactly when the rule passes. Docs scores 1 − P(needs docs) of the weakest file; is-true rules P(meets the rule); focused the least P(`one_thing` or `serves_purpose`) over its slices. A score rule reports its `level`, a choose rule its chosen option; a rule with no score reports `met`, `not-applicable` or `could-not-check` with a reason.
- **Verdict score**: per pull request, the verdict question's P(pass), shown out of 100. A verdict a failed hard or judged rule decided has none.

## Budgets and limits

| Limit | Value | Source |
| --- | --- | --- |
| Jev context, state + longest question | 32k tokens | [models](https://docs.typesafe.ai/models.md) |
| Jev context, state + all questions | 64k tokens | [models](https://docs.typesafe.ai/models.md) |
| State per request | 90,000 bytes (32k tokens is about 105 KB of diff) | `MAX_SYSTEM_ONE_STATE_BYTES` |
| Questions per request | 256 (no documented cap; 300 were answered) | `MAX_SYSTEM_ONE_QUESTIONS` |
| Room for files per request | at least 8 KB | `MIN_FILE_ROOM` |
| Requests per pull request | 64 (about 5.8 MB of state, $0.17 at most) | `MAX_JUDGE_REQUESTS` |
| Repository docs | 24,000 bytes, default branch | `REPO_DOCS_MAX_BYTES` |
| Contribution rules | 8,000 bytes, default branch | `REPO_RULES_MAX_BYTES` |
| Patch read per file | 65,536 chars | `MAX_PATCH_INPUT_CHARS` |
| Patch read per pull request | 270,000 chars | `MAX_PATCH_CHARS` |
| GitHub tool page | 9,000 chars | `PR_FILES_PAGE_CHARS` |

- **Docs.** Docs are read from the default branch in this order: root `README`, then `docs/`, then other root markdown, then nested markdown, each in path order. Reading stops at 24,000 bytes; a doc that crosses the cap is cut and later docs are not seen. The same docs are in every request's state.
- **Contribution rules.** Read under their own 8,000-byte budget, in this order: `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING` and `PULL_REQUEST_TEMPLATE` at the root, then `CONTRIBUTING` and `PULL_REQUEST_TEMPLATE` in `.github/` (including `PULL_REQUEST_TEMPLATE/`), then the same two in `docs/`. An `AGENTS.md` or `CLAUDE.md` inside a package stays an ordinary doc. Only requests that ask a custom rule carry them and give up room for them; requests that ask only built-in rules are unchanged.
- **Request splitting.** Files fill each request's state in order up to the budget left after metadata and docs. A file too large for one request keeps its leading hunks there for every rule, and focused and docs read its remaining hunks in the next requests, docs asking about each part (any part needing docs fails it); a hunk too large for any request is cut at line ends across several. Each request asks only about the files it holds; whole-PR questions go in the first, and focused asks in each. If the title, body, commits, path list and docs leave less than 8 KB of the budget for files, nothing is asked and the model rules stay unconfirmed ("pull request too large for the decision model (N KB)", the size of that metadata). The same holds when the split needs more than 64 requests ("… (N requests)").
- **Oversized patches.** A patch larger than one tool page is read across pages and joined. Reading stops at 65,536 chars for a file, which is then marked cut. Once the pull request's 270,000-char budget is spent, later files are listed without patches.
- **Unread files.** A file with lines changed but no patch to read (GitHub left it out, the per-PR budget was spent, or not even its first hunk fits a request) is unread, and a rule that would ask about it stays unconfirmed. Treatment differs by rule:
  - Docs reads a file too large for one request across requests as focused does. A file whose patch was cut while reading is asked about from the hunks that were read and is unread, so it can fail docs but never pass it. A changed doc file passes docs by rule regardless.
  - Scoped custom rules ask about a cut file (its patch cut while reading, or too large for one request) from the hunks that were read and treat it as unread.
  - Focused reads every line of every patch it has. Its only unread files are those whose patch it does not have whole: GitHub left it out, the pull request's 270,000-char budget was spent, or the file passed 65,536 chars. Any unread file leaves focused unconfirmed, listing them, unless another slice already fails it.
  - Binary files and pure renames have no lines and are never unread.

## Reused answers

A re-check of a head the judge already answered, such as after a merge moved
the base branch, does not ask the model again for an unchanged request. Each
verdict keeps the answers it got, keyed by a SHA-256 of the judge's system
prompt and the exact request (`judgeKey`, `logic/quality.ts`). The reconciler
carries them in its catch-up mail only to a deployment on the same workflow
version and decision-model offering, and the facts step accepts them only from
the hub's own triage sender. Rules sends the judge only requests no carried
answer matches; changed content or docs are asked again.

Only well-formed answers clear of the unsure band are kept, up to 16 KB per
verdict (`MAX_JUDGED_BYTES`, `actions/evaluate.ts`); the rest are asked again.

## Cost per pull request

Estimates at TypeSafe's direct price, about 3.3 bytes per token (32k tokens ≈ 105 KB), not measurements:

- A small pull request: one request. With 24 KB of docs and a few KB of diff that is about 9k tokens, about $0.0004.
- One full request: at most 64k tokens, about $0.0027.
- The largest pull request Triage reads: the 270,000-char patch budget fills about four to five requests when the docs take their full 24 KB, at most about $0.015. Hunk-scoped custom rules add one question per hunk, uncapped, so wide diffs can need more requests.
- Focused asks one question in each request that holds files. It adds requests only for slices no other rule needs: the rest of a file too large for one request, or files no other rule asks about. On the judge eval the largest pull requests (#46, #119, #157, #158) take 2 calls each. With 24 KB of docs and small patches, a pull request of 200 files takes 2 requests, 500 files 4, 1,000 files 8 and 3,000 files 24, under 66 KB of state each.
- A failed focused rule sends each failing slice's request again with its file questions: one extra request per failing slice, the same state re-sent whole. On the judge eval's mixes that is one or two extra requests of 34–83 KB each, about $0.0004–0.0011 apiece.

## Measured accuracy

`packages/triage-workflows/evals` replays labelled pull requests of this repository and of a small Go repository (`joho/godotenv`) through the deployed pr-triage definition on Interchange's local runner (`runLocal` with the production step invoker, agents and directors; `evals/run-definition.ts` over the shared `src/run-local.ts`), triggered by the mail the hub sends, with GitHub served from fixtures fetched through `gh` on first use into the gitignored `evals/.cache/`, each at the head and base sha `labels.json` pins so later pushes do not change it, and the judge calling OpenCode Zen `jev-1.13`, with focused and docs enabled. Each judge call is attempted once, as deployed: the judge director answers an inference error as a judge error, so the step's retry never runs. Each case expects the verdict to fail when docs or focused is expected to fail, and to pass otherwise.

- **Cases**: 54 in `cases.jsonl`. These are 38 pull requests labelled in `labels.json` (needs docs), 34 of this repository and 4 of `joho/godotenv`, 5 variants with their docs removed (body and matching commit messages dropped too), 7 mixes of two unrelated pull requests that focused must fail, and 4 of those mixes again with a title and body describing both halves (`describedMixes`). #190 and #191 are one feature each spread across hub, portal, contracts and workflows, which focused must pass.
- **Allowed misses**: docs 7, focused 2, verdict 4 (`judge.eval.ts`). An unsure answer counts as a miss; the run prints how many were unsure.
- **Latest result** (2026-10-20, 54 cases, `packages/triage-workflows/evals/results/pr-triage-judge.baseline.json`): docs 3 misses, focused 0, verdict 4 (the allowance), every miss an unsure answer: #103, #190 and the two docs-removed variants of #186 and #187. Custom rules are unmeasured.

A change to how a rule is asked or decided states the eval's misses before and after in its pull request.

## Adding a decision-model rule

1. **Prefer a built-in rule.** If GitHub data decides it, a built-in rule over GitHub data (size, linked issue, conflicts, CI, forbidden paths) costs no model call. Who opened the pull request, whether it links an issue, its CI and its size are a step's `when` conditions, decided in code after the verdict; they never reach the model.
2. **Write the question** by the rules above.
3. **Add it to the repository's policy.** In the policy file, a yes/no question about the whole pull request is a rule with `check: model`; its `text` is the question's claim:

   ```yaml
   rules:
     - id: errors-are-handled
       check: model
       text: Every new call that can fail handles or propagates its error.
       reason: Two outages came from swallowed errors.
       evidence: ["acme/api#312"]
   ```

   The file's blocks (`code-review`, `security`, `deslop`) and `decide` are read and checked but take no part in the verdict, which comes from `rules` alone. File- or hunk-scoped rules, and score and choose rules, are written in the stored policy's shape, which a policy file without `rules` or a v4 key is read in ([@corbits/triage-contracts](../packages/triage-contracts/README.md)). A file-scoped rule in `custom`:

   ```json
   {
     "id": "errors-are-handled",
     "name": "Errors are handled",
     "group": "pull-request",
     "kind": "model",
     "shape": "is-true",
     "claim": "Every new call that can fail handles or propagates its error",
     "scope": "file",
     "when": ["src/**/*.ts"]
   }
   ```

4. **For a built-in rule**, change `logic/quality.ts` (questions) and `logic/render.ts` (how answers decide).
5. **Measure before and after** with `bun run eval` in `packages/triage-workflows`. It calls OpenCode Zen with `OPENCODE_API_KEY` from the environment (Bun also reads `.env`).
6. **To add cases**, label pull requests in `packages/triage-workflows/evals/labels.json`, keyed by number or, in another repository, `owner/name#number` (`needsDocs`, a note, the `headSha` and `baseSha` it was measured at; `mixes` for unfocused pairs). Then run `bun packages/triage-workflows/evals/generate-cases.ts`, which needs an authenticated `gh` CLI. It fetches the labelled pull requests and regenerates `cases.jsonl`. Change the allowances only with a measured reason.

The eval covers focused, docs and the verdict only.

## Known limits

- **No citations.** Jev cannot point at evidence or name parts in text. Code chooses it: the files whose Noul crossed the band.
- **Not deterministic.** Answers vary slightly between runs, so a case near the band edge can flip between pass, fail and unsure. That is why the eval allows a few misses.
- **Injection is judged, not prevented.** Pull request text and docs are untrusted input in the state, and Jev does not treat state as hostile. The instructed question catches text that addresses the judge; an instruction it scores below 0.7 still reaches the other questions.
- **English.** TypeSafe reports its best accuracy in English; other languages are handled less well.
- **Score and Choice are unmeasured.** No eval case uses a score or choose rule.
