# The decision model

Triage answers its judgment checks (focused, docs and custom model checks) with a decision model: TypeSafe's Jev, a System One model. Every other check is a rule over GitHub data. This page describes how Triage asks the model, how it reads the answers, the limits it works within, what it costs and how accurate it has measured.

TypeSafe's docs: [index (llms.txt)](https://docs.typesafe.ai/llms.txt), [System One](https://docs.typesafe.ai/concepts/system-one.md), [models and limits](https://docs.typesafe.ai/models.md), [primitives](https://docs.typesafe.ai/primitives.md), [confidence](https://docs.typesafe.ai/confidence.md), [jev-1.13 jagged edges](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md).

## What it is

A System One model does not generate text. A request carries a JSON `state` and a list of typed questions, and each answer is numeric:

- **Noul**: a yes/no question, answered with P(yes).
- **Choice**: one option from a fixed set, answered with the chosen option, a probability per option and a confidence.
- **Score**: ordered, described levels, answered with the chosen level, a probability per level and a confidence. Triage does not use it.

Triage reaches the model through Interchange inference. The agents name the tenant model alias `decision` on the `corbits-system-one` provider (`packages/triage-workflows/src/agents.ts`). The operator picks the endpoint and model behind that alias in the portal's decision model settings (`apps/web/src/lib/decision-models.ts`):

| Preset | Endpoint | Model |
| --- | --- | --- |
| TypeSafe (default) | `https://api.typesafe.ai/v1` | `jev-latest` |
| Vercel AI Gateway | `https://ai-gateway.vercel.sh/typesafe/v1` | `typesafe-ai/jev` |
| OpenCode Zen | `https://opencode.ai/zen/v1` | `jev-1.13` |
| Custom | any | any |

The judge eval pins OpenCode Zen `jev-1.13`. The judge is the only step that infers: a `map` over the rules step's chunks, one System One call per chunk, then a second `map` over focused's follow-up chunks, which is empty unless focused failed (`triage-steps.ts`, `directors.ts`). The request body is `{ state, questions, model }`; no system prompt reaches the model.

## Why Triage uses it

- **Price.** TypeSafe charges $0.042 per million input tokens and nothing for output ([models](https://docs.typesafe.ai/models.md)). Gateway prices may differ.
- **Latency.** TypeSafe states that most queries complete in about 100 ms ([how to build](https://docs.typesafe.ai/concepts/how-to-build-with-system-one.md)). Latency inside Triage is unmeasured.
- **Probabilities.** Answers are probabilities, so code decides where an answer is too weak to act on and leaves it unsure.
- **Typed answers.** There is no model prose to parse, and none reaches GitHub. Comments name files and hunks that code chose.

## How each check asks

Questions are built in `packages/triage-workflows/src/logic/quality.ts`. Every request's state holds:

- the pull request's title, body (up to 4,000 chars), up to 50 commit messages and up to 200 changed paths, lockfiles included. When focused is asked, every path is listed instead while the list fits 8 KB; past that, the first 200 paths come with `pullRequest.directories`, every changed file counted by directory (files and changed lines) at the deepest level that fits 8 KB;
- the judged files that fit the request, each patch split into hunks. Lockfiles (`bun.lock`, `package-lock.json`, `yarn.lock`, `Cargo.lock`, `go.sum` and similar) keep their path but their patch is never sent;
- the repository's docs (`repository.docs`, markdown by path), see [budgets](#budgets-and-limits);
- in requests that ask a custom check, the repository's contribution rules (`repository.rules`), taken out of `repository.docs` so each file is sent once. Custom questions say to judge by them.

Questions point into the state by path, such as `` `pullRequest.files[3].hunks[0]` ``, rather than copying it.

- **Focused**: one Choice per request that holds files, so every file read is judged. The code, tests, docs, types and wiring one change needs across files count as one purpose.
  - When the diff fits one request, it asks about the whole pull request: `one_thing`, `more_than_one_thing` or `cant_tell`.
  - Otherwise each request asks whether its slice of the diff serves the pull request's main purpose or would belong in its own pull request, even if the title or body mentions it: `serves_purpose`, `separate_change` or `cant_tell`. Asking the slice question of a one-request diff too measured worse (70 of 72 against 72), and without "even if the title or body mentions it" it passed a mix whose description named both halves.
  - A pull request with no lines to read, such as one that changes only lockfiles, is not asked; focused does not apply.
  - Only when focused fails, each failing slice's request is sent again with one Noul per file it holds, at most 30 in all: "is the change in this file a separate change from the one the title and body describe?". Those answers never decide focused; they name the files to split out.
- **Docs**: path rules decide in code first. Changing (not removing) any doc file passes docs with no question asked.
  - A doc file is `*.md` or `*.mdx` outside `vendor/`, `node_modules/`, `dist/` and `build/`, legal notices excluded.
  - A test file is under `test/`, `tests/` or `__tests__/`, or named `*.test.*` or `*.spec.*` with a JS or TS extension (`[cm]?[jt]sx?`). It is not asked about.
  - Otherwise each file gets one Noul: does the change in this file make a statement in `repository.docs` wrong or incomplete, or add setup, configuration, permissions or commands the docs must describe? Code combines the answers: any file that needs docs fails the check, and at most 3 files are named.
- **Custom model checks** (`packages/triage-contracts/src/check-pack.ts`):
  - `is-true` with scope `pull-request` (the default): one Noul, `<name>: <claim>`.
  - `is-true` with scope `file` or `hunk`, optionally limited by `when` globs: one Noul per file or hunk in scope, "Does the change in … meet this rule: <claim>?". At most 3 items are named on failure.
  - `score` and `choose` are each reduced to one Noul ("reach at least N out of 10 for …", "best described as … rather than …").

## Writing questions

Rules learned while tuning, which match TypeSafe's [jagged edges](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md):

- **Jev reads literally.** It answers the question written, not the one meant. Put boundary cases in the question or criteria.
- **No conditional booleans.** "If X, does it Y? Answer true when not needed" was answered backwards. Decide the condition in code or ask per file (as docs does), or use a Choice with an explicit not-applicable option.
- **One judgment per question.** Split "and" conditions into separate questions and combine them in code.
- **Phrase it so yes means yes.** Negated or inverted questions do worse.
- **Choice leans toward the first option.** Reorder options and check the answer holds.
- **Keep counting, math, dates and paths in code.** Rule checks cover size, paths, titles and labels.
- **Irrelevant state costs accuracy.** TypeSafe reports accuracy falling as unrelated content grows.

## The unsure band and pass marks

From `logic/render.ts`:

- **Noul**: P ≥ 0.7 decides yes, P ≤ 0.3 decides no; anything between is unconfirmed ("not enough evidence to decide") and asks a maintainer to confirm.
- **Focused**: any slice with `more_than_one_thing` or `separate_change` ≥ 0.6 fails it. Otherwise an unread file leaves it unconfirmed, every slice with `one_thing` or `serves_purpose` ≥ 0.6 passes it, and anything else is unconfirmed. A failure names up to 3 files whose separate-change Noul is ≥ 0.7, most likely first; when none is, it fails without naming files.

Two different numbers come out of the answers:

- **Check score** (`packages/triage-contracts/src/check-output.ts`): per model check, 0–100 and unrounded, how likely the check is fine, with `passAt` 70 (docs, custom) or 60 (focused). It clears `passAt` exactly when the check passes. Docs scores 1 − P(needs docs) of the weakest file; custom checks P(meets the rule); focused the least P(`one_thing` or `serves_purpose`) over its slices. A check with no score reports `met`, `not-applicable` or `could-not-check` with a reason.
- **Merge score**: per pull request, 0–1, the weakest confidence among decided answers. For a Noul that is max(P, 1 − P); for failing docs, P(falls short) of the worst file; for focused, the most separate slice's P(separate) when it fails and the least serving slice's P(serves) when it passes. The pack's merge threshold applies to it. It measures how sure the model was, not how likely the pull request is fine.

## Budgets and limits

| Limit | Value | Source |
| --- | --- | --- |
| Jev context, state + longest question | 32k tokens | [models](https://docs.typesafe.ai/models.md) |
| Jev context, state + all questions | 64k tokens | [models](https://docs.typesafe.ai/models.md) |
| State per request | 90,000 bytes (32k tokens is about 105 KB of diff) | `MAX_SYSTEM_ONE_STATE_BYTES` |
| Questions per request | 256 (no documented cap; 300 were answered) | `MAX_SYSTEM_ONE_QUESTIONS` |
| Repository docs | 24,000 bytes, default branch | `REPO_DOCS_MAX_BYTES` |
| Contribution rules | 8,000 bytes, default branch | `REPO_RULES_MAX_BYTES` |
| Patch read per file | 65,536 chars | `MAX_PATCH_INPUT_CHARS` |
| Patch read per pull request | 270,000 chars | `MAX_PATCH_CHARS` |
| GitHub tool page | 9,000 chars | `PR_FILES_PAGE_CHARS` |

- **Docs.** Docs are read from the default branch in this order: root `README`, then `docs/`, then other root markdown, then nested markdown, each in path order. Reading stops at 24,000 bytes; a doc that crosses the cap is cut and later docs are not seen. The same docs are in every request's state.
- **Contribution rules.** Read under their own 8,000-byte budget, in this order: `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING` and `PULL_REQUEST_TEMPLATE` at the root, then `CONTRIBUTING` and `PULL_REQUEST_TEMPLATE` in `.github/` (including `PULL_REQUEST_TEMPLATE/`), then the same two in `docs/`. An `AGENTS.md` or `CLAUDE.md` inside a package stays an ordinary doc. Only requests that ask a custom check carry them and give up room for them; requests that ask only built-in checks are unchanged.
- **Request splitting.** Files fill each request's state in order up to the budget left after metadata and docs. A file too large for one request keeps its leading hunks there for every check, and focused reads its remaining hunks in the next requests; a hunk too large for any request is cut at line ends across several. Each request asks only about the files it holds; whole-PR questions go in the first, and focused asks in each. If the title, body, commits, path list and docs alone exceed the budget, nothing is asked and the model checks stay unconfirmed ("pull request too large for the decision model (N KB)", the size of that metadata).
- **Oversized patches.** A patch larger than one tool page is read across pages and joined. Reading stops at 65,536 chars for a file, which is then marked cut. Once the pull request's 270,000-char budget is spent, later files are listed without patches.
- **Unread files.** A file with lines changed but no patch to read (GitHub left it out, the per-PR budget was spent, or not even its first hunk fits a request) is unread, and a check that would ask about it stays unconfirmed. Treatment differs by check:
  - Docs asks about a cut file from the hunks that were read; it is not unread for docs. A changed doc file passes docs by rule regardless.
  - Scoped custom checks treat a cut file as unread.
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
- The largest pull request Triage reads: the 270,000-char patch budget fills about four to five requests when the docs take their full 24 KB, at most about $0.015. Hunk-scoped custom checks add one question per hunk, uncapped, so wide diffs can need more requests.
- Focused asks one question in each request that holds files. It adds requests only for slices no other check needs: the rest of a file too large for one request, or files no other check asks about. On the judge eval the largest pull requests (#46, #119, #157, #158) take 2 calls each. With 24 KB of docs and small patches, a pull request of 200 files takes 2 requests, 500 files 4, 1,000 files 8 and 3,000 files 24, under 66 KB of state each.
- A failed focused check sends each failing slice's request again with its file questions: one extra request per failing slice, the same state re-sent whole. On the judge eval's mixes that is one or two extra requests of 34–83 KB each, about $0.0004–0.0011 apiece.

## Measured accuracy

`evals/judge` replays frozen, labelled pull requests of this repository through the production steps (file paging, rules, one call per chunk, focused's follow-up calls, evaluate) against OpenCode Zen `jev-1.13`, with focused and docs enabled.

- **Cases**: 49 in `cases.jsonl`. These are 34 pull requests labelled in `labels.json` (needs docs), 4 variants with their docs removed (body and matching commit messages dropped too), 7 mixes of two unrelated pull requests that focused must fail, and 4 of those mixes again with a title and body describing both halves (`describedMixes`). #190 and #191 are one feature each spread across hub, portal, contracts and workflows, which focused must pass.
- **Allowed misses**: docs 7, focused 2 (`judge.eval.ts`). An unsure answer counts as a miss; the run prints how many were unsure.
- **Recent results**, misses as reported in commit messages and pull requests, out of 58 cases up to `45f34e6`, out of 72 on the row that says so, out of 76 after, and out of 49 once the tests check and its cases were removed:

| Commit | Date | docs | focused |
| --- | --- | --- | --- |
| `e31d6ba` | 2026-10-11 | 8 | 10 |
| `4c7fead`, run 1 | 2026-10-11 | 5 | 1 |
| `4c7fead`, run 2 | 2026-10-11 | 6 | 1 |
| `45f34e6`, 72 cases | 2026-10-12 | 10 | 4 |
| #192, run 1 | 2026-10-12 | 9 | 0 |
| #192, run 2 | 2026-10-12 | 10 | 0 |
| tests removed, 49 cases (CL-10584) | 2026-10-12 | 5 | 0 |

These cover one repository's pull requests. Custom checks and other repositories are unmeasured.

## Adding a decision-model check

1. **Prefer a rule.** If GitHub data decides it, use a rule check: `paths-unchanged`, `paths-together`, `title-pattern`, `branch-pattern`, `label-required`, `diff-excludes`, `min-approvals` or `author`.
2. **Write the question** by the rules above.
3. **Add it to the repository's pack.** Use the checks section of the repository panel in the portal, or write the pack through the hub's stock artifact route: the artifact titled `check-pack/<owner>/<repo>` under `/api/tenants/{tenantId}/artifacts`, with each save a new version. A file-scoped check in `custom`:

   ```json
   {
     "id": "custom-1",
     "name": "Errors are handled",
     "group": "pull-request",
     "kind": "model",
     "shape": "is-true",
     "claim": "Every new call that can fail handles or propagates its error",
     "scope": "file",
     "when": ["src/**/*.ts"]
   }
   ```

4. **For a built-in check**, change `logic/quality.ts` (questions) and `logic/render.ts` (how answers decide).
5. **Measure before and after** with `bun run eval:judge`. It calls OpenCode Zen with `OPENCODE_API_KEY` from the environment (Bun also reads `.env`).
6. **To add cases**, label pull requests in `evals/judge/labels.json` (`needsDocs`, a note; `mixes` for unfocused pairs). Then run `bun evals/judge/snapshot.ts`, which needs an authenticated `gh` CLI. It freezes the pull requests of the repository named in `labels.json` and regenerates `cases.jsonl`. Change the allowances only with a measured reason.

The eval covers focused and docs only.

## Known limits

- **No citations.** Jev cannot point at evidence or name parts in text. Code chooses it: the files whose Noul crossed the band.
- **Not deterministic.** Answers vary slightly between runs, so a case near the band edge can flip between pass, fail and unsure. That is why the eval allows a few misses.
- **No injection guard.** Pull request text and docs are untrusted input in the state. Jev does not treat state as hostile by default, and Triage has no prompt-injection check today.
- **English.** TypeSafe reports its best accuracy in English; other languages are handled less well.
- **No Score primitive.** `score` and `choose` custom checks are reduced to one yes/no question.
- **Narrow test detection.** Test files, which docs does not ask about, are recognised only by the JS/TS-centred patterns above.
