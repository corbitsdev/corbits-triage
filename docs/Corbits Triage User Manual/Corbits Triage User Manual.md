# Corbits Triage User Manual

Oct 16, 2026 · @Brian J. Fox

## Contents

1. [What Corbits Triage is](#what-corbits-triage-is)
2. [Getting started](#getting-started)
3. [Setting up a repository: rules, verdicts and actions](#setting-up-a-repository-rules-verdicts-and-actions)
4. [Day to day: Triage](#day-to-day-triage)
5. [Settings: Triage, code review and people](#settings-triage-code-review-and-people)
6. [Audit](#audit)
7. [Glossary and common questions](#glossary-and-common-questions)

## What Corbits Triage is

Corbits Triage is an assistant for people who maintain code on GitHub or Bitbucket Data Center. It looks at every open pull request in the repositories you choose, checks each one against the rules you set, and tells you whether it looks good to merge. Every pull request gets one of three verdicts: **Pass**, **Fail** or **Unsure**, along with a short list of reasons.

Think of it as a first reader. It does the routine checking (Did the tests pass? Is the change too big? Is there a linked issue? Does it need documentation?) so that you can spend your time on the pull requests that actually need a human opinion.

### Who uses it

- **Maintainers** open the portal, a web page where they see each pull request's verdict, its reasons and a suggested next step.
- **Teams** share one workspace. An admin invites teammates by email and decides who may do what.
- **Pull request authors** never need to log in. They only see what Triage writes on the pull request: comments, review requests, and labels and assignments on GitHub or a build status on Bitbucket.

### What it never does on its own

Nothing runs until you turn it on. Connecting GitHub or Bitbucket Data Center only records your repositories, with triage switched off. A repository is checked only after someone turns on **Triage pull requests in this repository**, and only once its policy file is on the default branch. What Triage then does on its own is what that file names, unless your workspace is set to ask first (see [Actions Triage takes on its own](#actions-triage-takes-on-its-own)); closing on Unsure, and merging on anything but Pass, always wait for a person. Code review, too, runs only in repositories whose [policy file](#writing-the-file) turns it on, and Triage posts its review on the pull request with the verdict.

### The three parts

1. **The portal** is the website you use. This manual is about the portal.
2. **The hub** is the server that stores your settings, talks to GitHub or Bitbucket and runs the checks. You normally never see it.
3. **The decision model** is an AI service that answers the judgment questions rules cannot answer from repository data alone, such as "Is this change focused on one thing?" You connect it once in Settings. Triage does not start until it is saved.

### Code review

Code review reads each new commit of a pull request for bugs: mistakes in the changed lines and breakage the change causes elsewhere in the repository. A finding is posted only after a second read of the code confirms it, or when two separate reads both found it and the second read could not rule it out. It is separate from the verdict and optional.

- **Turning it on.** A repository's [policy file](#writing-the-file) turns it on: it then runs after triage, for the groups in `for` and on the verdicts and paths in `when`. A pull request they leave out, or one whose failed rules hold the review back, is not reviewed, and its **Code review** section says **Not reviewed:** and why, such as **Not reviewed: the author is not in the maintainers group**. It needs the workspace's Anthropic API key, saved under [Settings → Code review](#code-review-2).
- **What it costs.** Each commit it reviews is billed to your Anthropic account. It reviews a pull request when it is opened and after every push while it is not a draft, and **Review again**, offered once a pull request has a review, is one more review. A push that leaves the change exactly as it was reviewed, such as a rebase onto a newer base that changed none of the files it touches, is not reviewed again: the new commit keeps the last review, and the section says **Carried over from** the commit it was made for. **Review again** reviews it anyway.
- **Approve, merge and the other actions.** The review's findings never change the verdict: your rules decide it. What the findings change is which of your actions run. An action with `when: { findings: ... }` in the policy file runs only when the review of the latest commit allows it: `{ above: P2 }` lets it run with findings less severe than P2 open (P0 is the most severe, then P1, P2 and P3, so only P3s here), `{ any: false }` with none open, and `{ any: true }` whatever the review found. Without that condition, approve and merge run only once the review found nothing, and every other action runs whatever it found. An action whose condition isn't met waits for you in the Inbox with the reason beside it, Triage's comment says so in one line, such as **Approve held: code review has 1 finding at P2 or above open on this head.**, and Triage takes back an approval it gave an earlier commit. A review that failed or ran past its hour, one that read only part of the change, and a review that never ran because the rules failed or had not settled meet no findings condition. A pull request the policy file chose not to review, by its author, its verdict or its changed files, runs its actions as if code review were off.
- **Where you see it.** While a review runs, the line at the top of Triage's reading pane says **In progress: Waiting on code review**, and until the first review its **Code review** section says **Code review: awaited**. Once it is done it is under **Code review**: each bug with how severe it is, its file and line, and the code it points at. **Review again** reviews the latest commit once more. It reads the whole change, however large. A review that could not is marked **This review did not read the whole change; approve and merge are held until a review does.** and holds approve and merge. A review that stopped before it finished reading the repository says **Stopped early: the reviewer reached its limit for reading the repository.**
- **On the pull request.** Triage posts the review with its verdict. On GitHub it is one review from the Triage App: each finding on a changed line is a comment on that line, and the rest are listed in the review. A finding whose lines run past the changed ones sits on its first changed lines and names the others. A review that stopped early carries the same line in the posted review, and a review that did not read the whole change carries **This review did not read the whole change; approve and merge are held until a review does.** A review too long for GitHub lists what fits and says how many more are in the portal. A review of a newer commit is posted as a new review, and the earlier one stays. On Bitbucket Data Center each finding on a changed line is a comment on that line, then one comment holds the summary and the rest.
- **Sending it yourself.** A finished review that is not on the pull request yet offers **Send to GitHub** or **Send to Bitbucket**. It is sent once per commit: on GitHub the section then says **Sent to GitHub**, and sending it again only tells you it is already there; on Bitbucket sending it again posts only what is missing, then says **Sent to Bitbucket**. It needs the Comment permission for the repository.
- **What it does not do.** It only reads code; it never runs it.

## Getting started

You use Corbits Triage through a website called the portal. Your administrator will give you its address. Everything in this section happens in a normal web browser.

### Signing in

Open the portal address. You will see the sign-in screen.

![The sign-in screen: an email field, a password field, a Continue button, a Continue with Google button and a link to create an account](images/01.png)

Type your email address and password and press **Continue**. If your organization uses Google sign-in, a **Continue with Google** button appears instead of, or below, the password fields. If the sign-in screen shows **Forgot password?**, use it to reset a forgotten password.

To keep the portal on your home screen or desktop, use your browser's **Install** or **Add to Home Screen** option; it then opens in its own window like an app.

### Creating an account

If you are the first person from your team, click **Create an account** below the sign-in box. The form asks for your name, your email address and a password.

![The create-account form with Name, Email and Password fields](images/02.png)

Unless you are the first person to use this Corbits Triage, you then see **Verify your email** until you prove the address is yours. Open the link in the email Corbits Triage sent you, and the portal opens. If the email has not arrived, press **Resend link**; you can ask for a new one once a minute. **Sign out** leaves the screen. If the service cannot send email, the screen asks you to have whoever runs this Corbits Triage verify your address; once they have, reload the page. Signing in with Google never asks for this.

![Verify your email on a server that cannot send email: Ask whoever runs this Triage to verify your address, with a Sign out button](images/46.png)

Creating an account also creates a **workspace**, the shared space your whole team will use. Invite teammates from Settings to join yours. If someone has already invited you, open the invite link they sent instead of creating an account from scratch; on a server that does not send email, sign in first so they can invite you. Someone who signs in without an invitation gets a workspace of their own; inviting them later adds yours, and they switch between the two from the workspace switcher at the bottom left of the sidebar, just above your name. Its last entry, **New workspace**, creates another empty workspace of your own.

### First-time setup

The first time you sign in to a new workspace, the portal walks you through two steps. It asks for a host connection, a GitHub App or Bitbucket Data Center, and nothing else. A decision model is not part of setup.

1. **Connect a source.** A source is where your pull requests live: GitHub or Bitbucket Data Center. Triage talks to GitHub through a GitHub App. Press **Create GitHub App** and GitHub opens with a prefilled form for you to confirm, then asks which account and repositories the App may see. Pick them and GitHub sends you back to the portal, so one trip covers the first two steps. On a Triage server at a localhost address, GitHub cannot reach it, so the App is created without a webhook and Triage picks up pull requests every five minutes; the setup screen says so. The App's private key is stored on the Triage server and is never shown in the browser. If your organization already has a GitHub App for Triage, expand **Connect an existing GitHub App instead** and enter its App ID, its private key file and its webhook secret; GitHub checks the App ID and key before they are saved. The portal shows the webhook URL you must paste into the App's settings on GitHub. A workspace works with the App on one GitHub account: if the App is installed on more than one, Triage keeps the first account's repositories and asks you to remove the App from the others. A workspace set up before this, with the App on several accounts, must sync its repositories once and keep the App on one account.

   ![The form for connecting an existing GitHub App, with fields for App ID, Private key, Webhook secret and the Webhook URL to copy](images/04.png)

   If your team uses Bitbucket Data Center rather than GitHub, expand **Use Bitbucket Data Center instead** and connect your instance as described under [GitHub and Bitbucket Data Center](#github-and-bitbucket-data-center).

   ![Use Bitbucket Data Center instead, expanded: the Instance URL and HTTP access token fields, the note on the Corbits Triage user and its permissions, the Download the Corbits Triage avatar link and the Connect button](images/24.png)
2. **Repositories.** On GitHub, the portal lists the repositories you picked. To change them, or if you connected an existing App, press **Choose repositories on GitHub** (**Choose repositories again** once some are listed) and pick which repositories the App may see. GitHub tells Triage which ones you chose. With Bitbucket Data Center there is nothing to pick: Triage lists every repository the token can see, and you turn triage on for each one under Repositories. Either way they arrive with triage switched off, so nothing runs yet. Press **Open Repositories** to leave setup.

You can also invite teammates from this screen by expanding **Invite people**, or do it later from Settings.

### After setup

Once you press **Open Repositories**, the portal takes you to Repositories, where triage is still off for every repository. The next section shows how to turn it on, and the one after it shows what you will see.

## Setting up a repository: rules, verdicts and actions

Every repository has its own page under **Repositories** in the menu under your name. A repository's rules, and what Triage does with each verdict, live in a file in the repository called `.corbits-triage.yml`. The page reads that file back to you. From top to bottom it holds the triage switch, the **Policy**, **Code review**, **Outcomes** and **Remove repository**. The triage switch takes effect as you flip it; if it cannot, the page says **Could not switch triage** and offers **Try again**.

![The repository page for acme/gadgets beside the Repositories list: the triage switch on, then Policy with Change on GitHub and its rules read back as sentences, from Flag pull requests over 25 files changed to Never accept changes to vendor/**, node_modules/**, then Pass: Comment with the verdict, Label “Triage: Ready”, Approve, for maintainers; Fail: Comment with the verdict, Label “Triage: Not Ready”; Unsure: Comment with the verdict, Label “Triage: Needs Human Review”, Request review from code owners, and Code review below](images/06.png)

### Turning triage on

The switch labeled **Triage pull requests in this repository** is the master control. While it is off, Triage ignores the repository entirely and the rest of the page is grayed out. You can turn it on before the policy has any rule: the page then says **Triage is on. It starts once the policy has a rule.** and nothing is checked until it does. Once the policy has a rule, Triage checks every open pull request, and does so again each time a change to the policy file reaches the default branch. From then on it reacts to each new pull request event as it happens. On GitHub, the link **Triage open pull requests again** re-checks everything that is currently open, which is useful after you change the policy. If Triage is starting or being updated at that moment, the open pull requests are checked as soon as it is running; there is nothing to click again. When the run finishes, each pull request's new result replaces its old one on Triage. Drafts are skipped until they are marked ready for review; one without a result shows **Waiting: draft** and **Draft: Not evaluated** instead of **Not triaged yet** and **Not evaluated**.

When the policy has judgement rules and the workspace has no decision model, the page says **This policy needs a model before its judgement rules can run.** **Add one in Settings** opens Settings → Triage, where you save it. A policy whose rules all run without a model shows no such line, but Triage still does not start on any repository until a model is saved.

### Bitbucket Data Center repositories

Repositories from Bitbucket Data Center are named by project key and repository, such as `TRI/widgets`, and carry a **Bitbucket Data Center** mark under their name in the list. The link in the corner of the repository page opens it on Bitbucket.

![The repository page for TRI/widgets, a Bitbucket Data Center repository: the triage switch on, then Set up the webhook on Bitbucket with the Webhook URL, the Webhook secret and the events to select](images/25.png)

Bitbucket tells Triage about pull request events through a webhook on each repository. When you turn triage on, Triage creates that webhook itself if its token is allowed to. If not, the page shows **Webhook setup** with the webhook URL, a secret and the list of events. A repository admin on Bitbucket then:

1. Opens the repository, then **Repository settings → Webhooks → Create webhook**.
2. Names it **Corbits Triage** and pastes the URL.
3. Pastes the secret.
4. Selects the events listed and leaves the webhook active.
5. Saves.

The secret is shown only this once. Turning triage off removes a webhook Triage created; one set up by hand stays until an admin deletes it.

A few things work differently from GitHub, because Bitbucket works differently:

- **No labels.** Bitbucket Data Center has no labels, so verdict labels and **Add labels** steps have no effect there, and a rule set to `onFail: label` only adds its note to the comment. Triage shows its verdict as a build status named **Corbits Triage** on the pull request's latest commit instead, whatever Triage may do on its own there (see [Requiring Triage before merge](#requiring-triage-before-merge-on-bitbucket)).
- **No assignments.** Bitbucket has no assignees, so **Assign to** steps are not carried out.
- **Bitbucket's own reviews.** Approve, Request changes, Close and Merge become Bitbucket's approve, needs work, decline and merge.
- **CI is checked on a timer.** Bitbucket sends no event when a build finishes, so a pull request waiting for CI is checked within a few minutes of its builds ending. While the **CI must pass** rule is waiting on a build, or failing because of one, Triage looks at the build again after five minutes, then less often, and checks the pull request again once it has changed.

#### Requiring Triage before merge on Bitbucket

Every verdict also sets the **Corbits Triage** build status on the commit it was given on: successful on Pass, failed on Fail, and in progress on Unsure and while Triage waits for CI. When Triage could not read the pull request or the repository's policy, it shows failed with **Triage couldn't run**. Its description names the failed rules, such as **Fail: rule: linked-issue**, and its link opens Triage's comment on the pull request, or the pull request itself when Triage does not comment there.

To block a merge until Triage passes, a repository admin opens **Repository settings → Required builds** (Bitbucket Data Center 7.14 or later) and adds **Corbits Triage**, or turns on **Minimum successful builds** under **Repository settings → Merge checks**. Bitbucket then refuses the merge while the build has failed or is in progress, so an Unsure verdict holds the merge until a later verdict passes or someone allowed to bypass the check merges anyway.

### Policy

A repository's policy is the file `.corbits-triage.yml` (`.corbits-triage.yaml` works too) on its default branch, so changes to it are reviewed like any other code. The **Policy** section reads it back in plain sentences: each rule that is on, then what Triage does on **Pass**, **Fail** and **Unsure**. Rules and actions live only in the file. **Open on GitHub**, or **Open on Bitbucket** for a Bitbucket repository, opens it there, and **Edit** changes it here.

- With no file, Triage runs nothing on the repository. The section shows a **Start a policy file** card with the steps **Review**, **Create pull request**, **Merge** (**Merge on Bitbucket** for a Bitbucket repository) and **Done**. It lists the rules the file starts with: at most 30 files and 3,000 lines changed, no merge conflicts, passing CI, sensitive paths and risk, with no actions. **Create pull request** opens one adding `.corbits-triage.yml`, or shows the one already open; change the rules there before you merge. You can also add the file to the default branch yourself. Triage starts on the repository once the file is there.

  ![The Policy section for acme/widgets: Start a policy file, the steps Review, Create pull request, Merge and Done, the six starter rules with Comment with the verdict and its label on Pass, Fail and Unsure, and Create pull request; the Repositories list marks acme/widgets Add a policy file](images/39.png)

- When a change to the file reaches the default branch, the next triage uses it. Where GitHub or Bitbucket cannot reach Triage to tell it about the change, Triage notices it within a minute.
- If the file has a mistake, Triage runs nothing on the repository until it is fixed. The section says so and lists each problem, and Triage names the repository.
- If the file still has a `security` or `deslop` block, or a `decide` rule with a condition on one, Triage runs the rest of the file and skips them, since those reviews are not available. The section says **Triage runs the rest of the file and skips this:** (or **these:**) and lists each one. **Create pull request to remove it** (or **them**) opens a policy pull request that takes them out; merge it to finish. Until they are gone, Triage refuses other changes to the file from the Repositories page.

#### Editing the file

**Edit** opens the file's text in the Policy section. Change it, then save it one of two ways:

- **Create pull request** opens a pull request changing the file, to review and merge on GitHub or Bitbucket like any other change. Triage uses the new rules once it is merged.
- **Push to main** (named for the repository's default branch) commits the change straight to that branch, so Triage uses it at once. It shows only to owners, admins and others who may manage the workspace's access, and only when the branch lets Triage push to it: on GitHub, a branch that is not protected and has no ruleset needing a pull request or checks; on Bitbucket, a branch with no permission that keeps Triage's account from pushing. When the branch does not, the editor says why below its buttons.

Before either save, Triage reads the text as it would read the file. If the text has a mistake, the editor lists each problem and saves nothing. If the new policy lets Triage approve or merge on its own something that can let unintended code in, such as pull requests from first-time contributors or changes to CI workflows, the editor says so and waits: press **Create pull request anyway** or **Push to main anyway** to go ahead, or **Keep editing**. If someone changed the file since you opened the editor, the save is refused; close the editor with **Cancel**, open it again and redo your change. While a policy pull request is open, **Create pull request** asks you to merge or close it first.

After a save the editor says **Pull request #… opened**, with **Review on GitHub**, or **Pushed to main**. **Done** closes it.

When a repository's first policy file is merged while the page is open, the Policy section says **Done. Your rules now come from .corbits-triage.yml.** above the rules.

The Repositories list marks each repository that still needs a file **Add a policy file**, or **Waiting for merge** while its pull request is open. Triage shows the same words in one line, each repository linking to its page; repositories with no policy file yet are counted in a line of their own that links to Repositories.

![The Repositories list: acme/widgets and corbitsdev/corbits-code marked Waiting for merge, acme/gadgets Needs setup](images/35.png)

![The Needs you view with the line acme/widgets: Waiting for merge · corbitsdev/corbits-code: Waiting for merge above Inbox zero](images/36.png)

#### Writing the file

In the file, each rule is one sentence with how it is checked and why it exists: a one-line `reason` and its `evidence`, such as the pull requests that led to it (`"#44"`) or `maintainer-stated`. For example:

```yaml
rules:
  - check: max-lines-changed
    text: A pull request changes at most 400 lines.
    max: 400
    reason: Large changes were split before review.
    evidence: ["#44", "#57"]
```

A file written before rules carried reasons keeps working as it is.

A coding agent can write the file for you with the skill in [`skills/corbits-triage-setup`](../../skills/corbits-triage-setup/SKILL.md). It reads your last 50 merged pull requests on GitHub and suggests rules from what the repository already does, each with the number behind it, such as size limits at the 90th percentile or a linked-issue rule when most pull requests name an issue. You pick which to keep; it suggests and never decides a stricter policy for you. On Bitbucket Data Center, or with no merged pull requests, the size limits stay at the starter's 30 files and 3,000 lines. It then writes or edits `.corbits-triage.yml` and checks it the same way Triage reads it. When nobody is there to answer, as in an agent run, it writes its suggestions and lists each one under **Waiting on you** in the pull request. To use it, copy the `corbits-triage-setup` folder into your coding agent's skills folder, such as `.claude/skills/` in the repository for Claude Code or `.agents/skills/` for agents that read that path, then ask the agent to set up Corbits Triage.

A file can also start from another repository's policy with `extends: owner/name` (on Bitbucket, `PROJECT/slug`), and then set only what differs for this repository. This is useful when many repositories should follow the same rules: keep them in one repository's `.corbits-triage.yml` and extend it everywhere else. That repository must be connected to the same workspace, and its own file must not use `extends`. A change merged into it applies to every repository extending it from their next verdict.

A file may also name author `groups`, turn on the code review that runs after triage (`code-review`), set `pace` and a `pauseLabel`, and list what to do in `decide` instead of `actions`:

```yaml
groups:
  maintainers: { association: [OWNER, MEMBER, COLLABORATOR] }
code-review: { on: true, for: [maintainers], when: { paths: ["!**/*.md", "!**/*.lock", "!**/package-lock.json", "!**/pnpm-lock.yaml"] }, provider: anthropic }
decide:
  - { if: { triage: fail }, do: request-changes }
  - { if: { triage: pass, all: clean }, do: approve }
  - { if: { code-review: findings }, do: [{ do: request-review, target: { to: codeowners } }] }
```

Triage checks these keys when it reads the file. When the `code-review` block is on, Triage runs that review. Code review always runs on Anthropic with the workspace's Anthropic key; `provider` has no effect. It reviews each pull request's code after triage, for the groups in `for` and on the verdicts and paths in `when`. By default it reviews only once the rules in your file that fail a pull request and need no model have passed. CI counts only when `ci-green` is on. Triage's built-in checks, such as a draft or a requested change, don't hold the review back. A pull request that fails one gets its Fail with those reasons and no review, and one whose CI is still running is reviewed once CI passes. Write `when: { rules: any }` to review whatever those rules say. When triage could not read the pull request, code review waits instead of running. A check's `when: { paths: [...] }` limits it to pull requests where a changed file matches one of the globs. A glob starting with `!` leaves out the files it matches, so the `code-review` example above skips pull requests that change only Markdown docs or lockfiles (`*.lock`, which covers `bun.lock`, plus `package-lock.json` and `pnpm-lock.yaml`). A renamed file counts under its old and new path. When Triage can't read every changed file, the pull request is reviewed, never skipped. An author whose group Triage can't tell is left out by a `for` that does not name `everyone`. A file that turns code review on needs the workspace's Anthropic key ([Settings → Code review](#code-review-2)) and a [place to run](#where-code-review-runs). Triage carries out your `actions`, approve and merge included, and not `decide`. On GitHub, a pull request carrying the `pauseLabel` label starts no triage or check run while it has that label, and removing the label triages it again. On GitHub, while a pull request in a repository with a `pauseLabel` can't be read, it isn't triaged and is tried again later, never run as if unpaused. Through a long GitHub outage it is retried a limited number of times, then triaged on its next event. `pace` is accepted and Triage does not use it.

An action's `when: { author: [...] }`, a check's `for` and a `decide` rule's `author` can name a group. An author is in the first of your groups they match, in the order you wrote them, and in each built-in group (`maintainers`, `external`, `first-timers`, `bots`) their role puts them in. Everyone is in `everyone`. The built-in groups go by the author's role alone, so they still work when Triage can't read teams; only when it can't tell the author's role are they unknown too. For a group you define, Triage can't tell whether the author is in it when it can't tell their role, or when teams it can't read would decide which of your groups is theirs. An action for a group Triage can't tell about doesn't run. `everyone` always matches. Never let Approve or Merge rest on `everyone` alone. In `decide`, `{ all: clean }` means at least one check ran and every check that ran came back clean; checks that were skipped don't count, so when every check was skipped it doesn't match. A rule that approves or merges without naming `triage` only matches a Pass. Code review's findings never change the verdict; an action's `when: { findings: { above: P2 } }`, written beside its `author` condition, decides whether it runs with findings open, on any verdict's list:

```yaml
actions:
  pass:
    - do: approve
      when:
        author: [maintainers]
        findings: { above: P2 }
```

A file that still sets `code-review.clean` is refused, and the message names `when.findings` as its replacement. The next push is checked and reviewed again. A review that couldn't read the whole change is incomplete, and incomplete is never clean. A file that uses `extends` can't hold these keys. Every key is listed in the setup skill's [reference](../../skills/corbits-triage-setup/reference.md#blocks-and-decide).

If the file has a mistake, each problem names its line and what the value must be, such as "Line 12: `code-review.when.triage` must be pass, fail or unsure, or a list of them." A misspelt key says which one you likely meant, such as "`code-reveiw` is not a key; did you mean `code-review`?"

#### Checking the file in pull requests

On GitHub, a mistake in the file can be caught before it reaches the default branch, and each pull request can be checked against the rules that need no model. Add this workflow to the repository as `.github/workflows/corbits-triage-policy.yml`:

```yaml
name: Corbits Triage policy
on: pull_request
jobs:
  corbits-triage-policy:
    runs-on: ubuntu-latest
    permissions:
      checks: read
      contents: read
      pull-requests: read
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
        with:
          persist-credentials: false
      - uses: corbitsdev/corbits-triage/packages/policy-check-action@844696731de693ac70876ddf37cca016b065f25f
```

Each pull request then gets a **Corbits Triage policy / corbits-triage-policy** check, named after the workflow and the job. To run it from a workflow you already have, add the `corbits-triage-policy` job to it; the check is then named after that workflow. A workflow written with the earlier job id, `check`, keeps reporting **Corbits Triage policy / check** until you edit it; when you replace that job with this one, change a branch protection rule or ruleset that requires the old name to the new one. It reads the file exactly as Triage does and fails if Triage could not read it. A `security` or `deslop` block, or a `decide` rule with a condition on one, is marked as a warning, since Triage skips it, and the check passes. Each problem is marked on its line in the pull request's **Files changed**, or on the file as a whole when it has no line.

It also runs the rules that need no model, from the policy on the branch the pull request merges into, such as size, linked issue, merge conflicts and forbidden paths, against the pull request. Each failed rule shows as an error when its failure means Fail, and as a warning otherwise, and the run's summary lists every rule with its result and how many passed. Rules a model answers, such as **focused** or your own written rules, show as skipped, and so does **CI must pass before merge**, since the check is itself still running. A policy that uses `extends` is not checked, and one Triage cannot read shows a warning instead. The check fails when a rule whose failure means Fail fails. It only reads the pull request, never posts to it, and works on pull requests from forks. It needs no Triage account and no secrets, and sets up its own Bun for the job. Both actions are pinned to a full commit SHA, so the job only runs code you chose; to update the check, replace its SHA with a newer commit from `main`.

#### Check locally

Before pushing, you can run the same rules on your own change. From a clone of this repository, run `packages/policy-check-action/src/cli.ts check` inside the repository you are changing (it needs Bun). It reads the policy on the default branch (`--base <branch>` for another) and checks your change twice: **Committed**, your commits since your branch left it, which is what Triage sees once you push, then **Working tree**, which adds staged and unstaged edits and new files, or says there are no uncommitted changes. Each lists every rule with its result, then each failure. Rules a model answers show as skipped, and so do rules that need the pull request on GitHub or Bitbucket: CI, merge conflicts, linked issue, hidden content, regression risk, risk, conventional commits when they cover the title, and your own text rules that read the title or description. It never contacts the host and needs no account. It exits with 1 when a rule whose failure means Fail fails in **Committed** (a failure only in the working tree is a warning), 2 when the policy cannot be read or the change cannot be checked, and 0 otherwise. The rules are the same on both hosts, so it works for Bitbucket Data Center repositories too.

#### Browser extension

The Corbits Triage browser extension, for Chrome and Firefox, shows how a GitHub pull request fares against its repository's policy file without a Triage account. Install it ([how](../../apps/extension/README.md#install)) and open a pull request while signed in to github.com. It reads the pull request and the policy file as you, so private repositories you can see work too, and it changes nothing. A read-only GitHub token saved in its side panel is optional: it is used only for what github.com does not show the extension. When something cannot be read either way, the section says what and checks nothing. Signing in to github.com as a different account, or signing out, clears the results it saved for the previous one.

On any pull request it adds a status beside the title: a ring that spins while Triage runs, then turns green with **Pass** when every check it ran passed or red with **Fail** when any failed, whatever the rule's `onFail`. While only CI is still running it says **Checks running**; anything else not settled yet says **Not settled**. A **Corbits Triage** section at the top of the sidebar lists each failed check with its reason, or how many passed, with **Triage again**. The side panel, opened from the toolbar, the status or the section, shows a score from 0 to 100, lists every check with its evidence and links the policy file on the default branch. **Files changed** marks the files and lines a failing check points to. The extension runs the policy's rules only, not its Judgement rules. Without a saved token, a pull request isn't checked when github.com doesn't give its rendered description or when a commit, such as a merge commit, can't be read; the section says which, and saving a token fixes it. When Corbits Triage has sent a code review to the pull request, the section links to it and lists its comments by file and line; it shows the review only with a saved token. A pull request with the policy's pause label shows **Paused** and is not checked. **Triage again** reads the pull request and the policy file afresh. A repository with no policy file gets a short note linking to [Writing the file](#writing-the-file).

### Rules

A rule asks one question about a pull request and answers pass, fail or unconfirmed. The Policy section shows each rule that is on as one sentence. A file can turn on:

- **Size**: **Flag pull requests over N files changed**, **over N lines changed**, **over N lines changed in one file**, **over N lines added** and **over N lines deleted**. Big changes are hard to review. You choose the limits. Lockfiles, such as `bun.lock` or `package-lock.json`, are left out of the GitHub counts. On Bitbucket Data Center the per-file rule always passes, and lockfile lines stay in the line, addition, and deletion totals. The file count still drops lockfiles. Size rules only label and note the pull request unless the file gives them another `onFail`, since features and refactors cross them.
- **Facts the host already knows**:
  - **Require a linked issue** from GitHub, Linear or either. The pull request's title, description, commits or branch must mention an issue.
  - **Flag merge conflicts with the base branch.**
  - **CI must pass before merge.** The repository's automated checks must be green. While they are still running, the rule is unconfirmed and Triage waits for them. When one was cancelled or went stale without a result, a build cancelled on Bitbucket Data Center included, the rule is unconfirmed and the verdict is Unsure, with the comment naming the checks to re-run; re-running them triages the pull request again. A skipped check counts as passed.
  - **Never accept changes to** certain paths, such as vendored code.
  - **Require a conventional commit title and messages.** The title and the first line of each commit must start with a type, such as `feat: add search` or `fix(api)!: drop v1`. The types are feat, fix, refactor, perf, docs, test, chore, ci, build, style and revert unless the file lists its own, and the file can check only the title or only the commits. Case does not matter. Merges and the `Revert "…"` commits GitHub's revert button makes are skipped, and only the first 100 commits are read. When it fails, Triage names each title or commit that doesn't follow the format.
  - **Flag pull requests that hide text.** Fails when the title, description, a commit message or a file name hides something from a reviewer: two or more invisible characters together, Unicode tag characters other than those that draw the England, Scotland and Wales flags, variation selectors that change nothing a reader sees (one emoji-style selector on its own is allowed), characters that override or isolate text direction, or a link with nothing to click. Right-to-left text and colour codes in pasted terminal output are allowed. On GitHub it also fails when a comment or other hidden markup the author added to the description speaks to an AI, such as "ignore previous instructions", or holds those characters. A comment exactly as the repository's pull request template has it, or, with no template, its organisation's `.github` repository's, is skipped; one the author shortened or added to is checked. When it fails, Triage says what it found and where, such as `commit 2: bidi controls`, never the hidden text. On Bitbucket Data Center only the characters are checked. It knows only common wording: an instruction that is paraphrased, written with look-alike letters or HTML entities, or split across comments passes, and so does a single invisible character between letters. Give it `onFail: ask` so a maintainer decides rather than the author being failed.
  - **Flag changes to files with N+ fixes in the last 30 days, or to migrations.** Fails when a changed file has had at least N commits in the last 30 days whose title starts with a fix, bugfix, hotfix or revert type, such as `fix(api): …` (4 unless the file sets `hotFileFixes`), or a changed file is a migration (`**/migrations/**` or `**/*.sql` unless the file lists its own `migrations`). Tests, Markdown docs and lockfiles are left out. Its evidence names the hottest three files and how many more, such as `src/router.ts: 6 recent fixes` or `db/migrations/0004.sql: migration`. It only labels and notes the pull request unless the file gives it another `onFail`, so a step can hold back an approve or merge on its label. When Triage can't read a file's whole recent history, the rule is unconfirmed rather than passed, and the rest of the pull request is checked as usual. Triage reads the history of at most 300 changed files per pull request, so on a larger one the rule is unconfirmed with **could not read the recent history of some changed files**, unless a changed file is a migration or one it read is hot. The default of 4 was measured on one open-source repository; check it suits yours.
  - **Flag a pull request with the same changes as another open one.** Fails when an open pull request opened before it on the same base branch, drafts left out, has the same latest commit, the same diff or the same commits, and the comment names it, such as "has the same changes as #1612". The one opened first never fails it. Where a host gives no diff to compare, such as a very large pull request, the commits are compared. One whose diff or commits Triage can't read is compared on what it could read. Triage compares at most 100 earlier open pull requests; with more on the branch, when this pull request's own changes can't be read, or when another's list of changed files can't be read, the rule is unconfirmed rather than passed and says which.
  - **Flag changes to sensitive paths.** Checks changed files against the file's named groups of globs, each `high` or `medium`, written as `groups:`, such as `infra: { level: high, paths: ["infra/**", "**/*.tf"] }`. Without `groups` there are four: `schema` (`**/migrations/**`, `**/*.sql`) and `auth` (`**/auth/**`, `**/secrets/**`), which are high, and `ci` (`.github/**`, `**/Dockerfile`, `**/railway.json`, `**/railway.toml`) and `locks` (`**/bun.lock`, `**/package-lock.json`, `**/yarn.lock`, `**/pnpm-lock.yaml`), which are medium, since every dependency bump changes a lockfile. Globs read as in **Never accept changes to**. A change to a group at `failAt` or above, high unless the file says, fails the rule, which asks a maintainer unless the file gives it another `onFail`. Below that, from `labelAt`, medium unless the file says, it passes but labels the pull request `sensitive: medium` and notes it under **Notes:** (on Bitbucket Data Center, only the note). Its evidence names each group with its files, at most five, such as `schema: db/migrations/0004.sql`, then how many more. Regression risk keeps its own migration globs.
  - **Flag high-risk pull requests and label medium-risk ones.** Rates each pull request low, medium or high risk; see [Risk](#risk).
  - **Fail when …**, a text rule of your own, such as "Fail when any commit message contains "Co-Authored-By:"". It names where to look (the title, the description, any commit message, or several of them), whether the rule fails when the text **contains** or **does not contain** its phrases, and the phrases. Case does not matter. A **contains** rule on the description also looks at its hidden parts, such as HTML comments and the addresses behind links, while **does not contain** reads only what a reader sees. Only the first 100 commits are read. When a **contains** rule fails, Triage names each place and the phrases found there, asks for them to be removed, and quotes each matching line once. Text rules count toward the eight rules of your own.
  - **Fail when added code matches …**, a code-pattern rule of your own, such as one that flags `?? 0`. It checks only the lines the pull request adds to TypeScript and JavaScript files (`.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`), so code already on the branch never fails it. On any other language it passes with **nothing checked: no TypeScript or JavaScript code added**, so don't add one to a repository written in Go, Python or similar. Turn on the shipped `convention` preset, which flags invented fallbacks (`?? 0`, `?? []`), nested ternaries, functions called where they are written, `.then`/`.catch` chains, empty `catch` blocks and lint or type suppression comments in both languages, or write your own patterns in [ast-grep](https://ast-grep.github.io/guide/rule-config.html)'s rule format. Your own pattern replaces a preset's pattern with the same `id` in both languages; to keep checking JavaScript, add a `language: javascript` pattern under the same id. A pattern takes ast-grep's own `files` and `ignores` lists to check only some paths or skip some. They follow ast-grep's glob rules: paths are from the repository root, `*` also matches across folders, and dotfiles are matched like any other file. Write each glob as a string; the `{ glob, caseInsensitive }` form is not read. Write a negated class as `[^a]`; a glob with `[!a]`, or one that isn't valid, refuses the policy. The preset's `?? 0` and `?? []` patterns ignore test files (`**/*.test.ts`, `**/*.test.tsx`, `**/*.test.js`, `**/*.test.jsx`, `**/*.test.mjs`, `**/*.test.cjs`). Each match is listed as evidence, as `path:line` and the pattern's message. Vendored and built code at the repository root (`vendor/`, `dist/`, `build/`, `generated/`) and installed code (`node_modules/` anywhere) is skipped, and each skipped file is listed in the evidence. The same folders deeper in the repository, such as `src/build/`, are checked. When the host sends no changed lines for a file that adds code, as GitHub does for a very large or binary one, the pull request's diff is larger than the 2,000,000 characters Triage reads, or a file's content can't be read, every other file is still checked: a match fails the rule, and otherwise it is unconfirmed, naming those files and why. When a pattern is not valid ast-grep, the rule is unconfirmed rather than passing. Triage reads at most 300 files per pull request, so on one that adds code to more, the rule is unconfirmed with a reason such as **code patterns could not be checked: 412 files with added code, more than the 300 read per pull request**. On Bitbucket Data Center, which does not give Triage each file's changed lines, it is unconfirmed whenever a TypeScript or JavaScript file of your own is added, edited, moved or copied. To give some patterns a different `onFail`, put them in a rule of their own. Code-pattern rules count toward the eight rules of your own, and the browser extension leaves them out.
- **Judgement**, questions the decision model answers from the diff and the documentation:
  - **Check the change is focused on one thing.** The decision model is asked whether the pull request does one thing. When it fails, the verdict comment says it mixes unrelated changes and asks the author to split them out, unless the file sets another `onFail`. A pull request based on another open pull request's branch is checked on its own changes, and the comment says so, such as "Stacked on #1573: only this pull request's own changes were checked." On a branch another pull request was merged into, this rule is skipped, and the comment says why, such as "stacked branch, includes #1521".
  - **Check docs are updated when behavior changes.** Changing a documentation file passes it. Otherwise the decision model is asked, file by file, whether the docs stay correct, a statement in them is now wrong, or the change adds setup the docs must describe. When it fails, the verdict comment asks the author to update the documentation and names the files, unless the file sets another `onFail`. The default label, when `onFail` is `label`, is `docs: check`.
  - **Check the change is not already made by another open pull request.** Triage picks up to five open pull requests opened before it on the same base branch, drafts left out, that change one of the same files (lockfiles aside) or share two title words of four or more letters, most shared files first, and the decision model rates each as the same change, overlapping or unrelated, from both titles, this pull request's description and both lists of changed files. It fails when one is likely the same change, and names it, such as "looks like the same change as #1612". With none picked it passes without asking. Its `onFail` is `ask` unless the file sets another, so a maintainer decides. Like the rule above, it is unconfirmed when more than 100 earlier pull requests are open on the branch.
  - **Is it true that …**, a yes-or-no question of your own, such as "Is it true that the title says what changed?" The rule fails when the answer is no.

Two rules always run: a draft pull request waits until it is ready for review, and a pull request with changes requested fails. Once the author pushes a new commit or replies, it still fails but waits on the reviewer, in **Needs you** as ready for re-review, until that reviewer approves or requests changes again.

Each rule's `onFail` says what happens when it fails:

- `fail`, the default for every rule but the size rules, regression risk, the judged duplicate rule, sensitive paths and risk: the verdict is **Fail** and the comment asks the author to fix it.
- `ask`, the default for the judged duplicate rule, sensitive paths and risk: the verdict is **Unsure** and the comment lists the rule under **Asking a maintainer about:**, so the pull request waits for you in **Needs you** instead of on its author.
- `label`, the default for the size rules and regression risk: the verdict does not change. When the rule fails, or the decision model can't tell, Triage adds its label to the pull request and a line under **Notes:** in its comment. Triage's comment and the reading pane leave a `label` rule out of their rule list; it shows only as a note and a label (on Bitbucket Data Center, only the note). The browser extension, the **Corbits Triage policy / corbits-triage-policy** check and the local check still list it. The label follows the rule: once the rule passes, such as a pull request cut back under its size limit, Triage takes the label off. The level labels of sensitive paths and risk (`sensitive: medium`, `sensitive: high`, `risk: medium` and `risk: high`) follow the level: when it changes or drops to low, Triage takes the old one off. A label the policy names for a rule follows that rule, even if a person added it; a label the policy does not name for a rule is never taken off. A label a `labels` step in the policy also names is left alone. The label is `size: large` for the size rules, `docs: check` for the docs rule, `sensitive: high` and `risk: high` for sensitive paths and risk, and the rule's id followed by `: check` for any other, such as `regression-risk: check`; `label:` names a different one, but not one starting `Triage:` or `rule: `, a verdict label, or a level label of sensitive paths or risk other than the rule's own, which Triage takes back itself; a `labels` step may not name a level label either. `onFail: label` suits rules that are hygiene rather than a gate, such as size limits an atomic change has to cross. A top-level `onFail` sets it for every rule in the file that does not set its own. The Policy section shows a rule that does not fail the pull request with what it does instead, such as "(on fail, labels size: large)".

To make a size limit block, give it `onFail: fail` or `onFail: ask`:

```yaml
  - check: max-lines-changed-per-file
    text: Flag pull requests over 500 lines changed in one file.
    max: 500
    onFail: ask
    reason: A very large file change is hard to review line by line.
    evidence: [maintainer-stated]
```

A code-pattern rule that labels instead of failing:

```yaml
  - id: conventions
    check: code-patterns
    text: Added code follows our conventions.
    presets: [convention]
    patterns:
      - id: no-console
        language: typescript # or javascript
        message: Remove console logging.
        ignores: ["scripts/**"] # ast-grep globs; `files` checks only the paths it names
        rule: { pattern: "console.log($$$ARGS)" }
    onFail: label
    reason: Review time goes to design, not style.
    evidence: [maintainer-stated]
```

Size rules and facts the host already knows cost nothing and always give the same answer for the same pull request. Judgement rules call the decision model, a few requests per pull request, each billed by your model provider.

#### Risk

The risk rule counts five signals:

- `sensitive`: a changed file in a medium sensitive-paths group, the rule's own groups or the four defaults, whether or not that rule is on. While sensitive paths is off, a changed file in a high group makes the pull request high risk on its own; while it is on, a high group is left to sensitive paths, so a migration is asked about once, with one reason.
- `size`: more files or lines changed than the size rules allow, 30 files and 3,000 lines unless the file sets `max-files-changed` or `max-lines-changed`.
- `no-tests`: source files changed and no test file did. Source is code in TypeScript, JavaScript, Go, Python, Rust, Java, Kotlin, Ruby, PHP, C# or Swift, outside vendored, built and installed code, `docs/` and `examples/` folders and type declarations (`*.d.ts`); configuration, data such as JSON, SQL, docs and assets are not. A test is a file under a test folder, `e2e/`, `cypress/` or `__snapshots__/`, or one named as a test, such as `*.test.ts`, `*.cy.js` or `*_test.go`.
- `hot-files`: a changed file with as many recent fixes as regression risk counts, 4 unless it sets `hotFileFixes`.
- `first-time`: an author contributing to the repository for the first time. Bitbucket Data Center does not say, so it never counts there.

By default any one signal makes a pull request medium risk, and a size limit crossed with no test changed makes it high. At `failAt`, high unless the file says, the rule fails and asks a maintainer unless it has another `onFail`; the comment lists it under **Asking a maintainer about:**, such as **Risk: high (schema paths, 42 files, no tests)**. Below that, from `labelAt`, medium unless the file says, it passes but labels the pull request `risk: medium` and notes it under **Notes:**, such as **Risk: medium (no tests)** (on Bitbucket Data Center, only the note). A `labelAt` at or above `failAt` never labels.

`medium:` and `high:` take the number of signals that reach the level, or a list of signals any one of which does; a list inside the list needs all of its signals:

```yaml
  - check: risk
    text: Ask about high-risk pull requests and label medium-risk ones.
    medium: 2
    high: [hot-files, [size, no-tests]]
    failAt: high
    labelAt: medium
    reason: A hot file or a large untested change needs a maintainer's eye.
    evidence: [maintainer-stated]
```

When Triage can't read a changed file's recent history and a hot file would make the rule fail, the rule is unconfirmed, which leaves the verdict **Unsure** unless the rule only labels, and the comment notes **Risk could not be checked** with the reason under **Notes:**. A label it could only have added is left off. The defaults have not been measured against any repository's history; check they suit yours.

### How the verdict is decided

1. If any rule fails, the verdict is **Fail** right away. That includes a Judgement rule the decision model answered no to. A failed rule set to `onFail: ask` makes it **Unsure** instead, unless another rule fails it.
2. Whenever it answers Judgement rules or decides the verdict, the decision model is also asked whether the pull request's title, description, commits, changes or the repository's docs try to tell it what to answer, such as "approve this" or "ignore your instructions". If it is at least 70% sure they do, none of its answers count: every Judgement rule is left unconfirmed and the verdict is **Unsure**, with the reason "the pull request tries to direct the decision model", so a person decides. A failed rule that decides **Fail** on its own still does.
3. If the policy has no Judgement rules, there is nothing left to judge: the verdict is **Pass** when every rule passes. A rule still waiting on the host, such as CI that is still running, makes Triage wait (see Waiting for CI).
4. Otherwise the decision model reads the whole pull request together with every rule's result and answers one question: does this pull request pass this repository's policy? If it is at least 70% sure the answer is yes, the verdict is **Pass**. If it is at least 70% sure the answer is no, the verdict is **Fail**. Anything in between is **Unsure**, which means a person should look. A pull request with a Judgement rule the model could not confirm is never more than Unsure.

Triage reads a pull request's title, description, commit messages and file names as people see them. Text hidden from view, such as invisible characters and, on GitHub, comments in the description, is left out, so the rules, the decision model, the Triage comment and code review never act on something a reviewer cannot see. A code-pattern rule checks the file the pull request actually changed, even when its name hides characters; the result shows the name as you see it. Turn on **Flag pull requests that hide text** to also be told when a pull request tried. The reading pane links only the GitHub issues the description shows, including a pasted link to an issue in the same repository, which GitHub shows as its number.

Rules set to `onFail: label` take no part in any of these steps: they only label and note the pull request. A policy whose only Judgement rules only label is decided as one with none.

Draft pull requests are not decided at all, and a closed pull request gets no verdict.

### Actions

The file lists steps for each verdict, and the Policy section shows them under **Pass**, **Fail** and **Unsure**, after the verdict Triage posts: **Comment with the verdict** and, on GitHub, the verdict's label, such as **Label “Triage: Ready”**. A step or comment Triage may not do on its own says **(waits for you on Triage)**, and so does the label when the comment waits; a label Triage may not add while it may comment says **(not added: Triage may not add labels here)**. On Bitbucket a comment posted from Triage sets no build status. A held step is approved on Triage, where **Always, in this repository** also lets Triage do it on its own from then on (see [Taking action](#taking-action)). Each step names an action and who it is for.

| Action | What it does |
| --- | --- |
| Approve | Approves the pull request. |
| Merge | Merges the pull request. Only on Pass. |
| Close | Closes the pull request. |
| Comment | Posts the comment the step gives. |
| Request changes | Sends the author a review listing the rules to fix. |
| Request review from | Asks the code owners, named people or teams to review. |
| Assign to | Assigns the pull request to the author, the code owners, named people or teams. |
| Add labels | Adds the labels the step lists, or one label for each failed rule. |

A step can be limited to some authors, shown after it, such as "Approve, for maintainers": **first-timers**, **maintainers**, **external contributors** or **bots**; one kind of author as GitHub reports it; a GitHub team; or specific people. A step for anyone shows no one. For example, a Fail step can post a friendly comment for external contributors only. In the file, authors are named by GitHub's own author types: `OWNER`, `MEMBER`, `COLLABORATOR`, `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, `FIRST_TIMER`, `NONE` and `MANNEQUIN`, plus `BOT` for bots. A file that names first-timers, maintainers, external or bots still works and means the same authors as before.

A step can also run only when the pull request links an issue (or does not), when its CI is passing, failing, pending or absent, or when it changes more or fewer files or lines than you say. CI that was cancelled counts as pending until a check is re-run. These conditions are written under the step's `when`; the page shows only who a step is for.

When Triage may not post its verdict, the pull request's line says so, such as **Done: Not ready · not posted on GitHub: Triage may not post here on its own; workspace settings list what it does on its own in each repository · waiting on @ada**.

Which actions Triage takes on its own is set once for the whole workspace, under [Settings → Triage](#actions-triage-takes-on-its-own). In a new workspace Triage takes every action the policy file names, a few minutes after triage is turned on, and an action taken out of the file goes back to waiting for you. A workspace set to ask first posts only the verdict on its own, Comment and Add labels (Comment only on Bitbucket, which has no labels), so you can watch what Triage suggests before you let it act; **Always, in this repository** on a held action lets Triage take it on its own there from then on. Turning triage off, or removing the repository, takes back everything Triage did there on its own; turning it on again starts from Comment and Add labels. Two actions are always held for a person: Close on Unsure, and Merge on anything but Pass.

Triage checks a pull request as soon as it changes. When a rule is waiting on the host (CI still running, or the host has not yet worked out whether the pull request can merge), whatever else it could not confirm, or CI is still running and a step reads it (a CI condition, approve or merge), it gives no verdict yet and waits for the host, so you get one result instead of an early Unsure: no action runs, and Triage shows **In progress: Waiting on CI**, and the pull request waits under **Waiting** rather than **Needs you**. The pull request's page notes **New commits since Triage checked** above the earlier result, which stays until the new one lands. On GitHub, where Triage adds labels on its own, a pull request labelled **Triage: Not Ready** or **Triage: Needs Human Review** keeps it, so new commits change no label unless the verdict changes; any other, **Triage: Ready** included, shows **Triage: Waiting for CI**, or no Triage label while the commit has no checks. On Bitbucket the new commit's **Corbits Triage** build status shows **Triage: Waiting for CI**. The verdict replaces it once CI finishes, as soon as any check fails, or after an hour at most; on a host that does not tell Triage when a build finishes, such as Bitbucket, within about five minutes of it finishing. When the **CI must pass** rule is on, a commit still with no checks a few minutes after Triage first saw it is taken as having no CI. **Triage again**, or the host still not having worked out mergeability after Triage's last retry, gives the verdict at once. Where Triage comments on its own, its comment on the pull request reads **Triage: In progress** while it waits, and names what it is waiting for: CI, the decision model's answer or code review. Triage keeps that one comment current, and the verdict replaces it in place once it decides. If the decision model or code review keep Triage waiting three hours after it started on the pull request, it gives the verdict anyway, says what it stopped waiting for, and runs no action on its own, so you decide. If Triage gives the verdict while CI is still running, on **Triage again** or its last retry, it holds every action that depends on CI, and its comment on the pull request lists them under **Waiting for checks to finish**.

An **Unsure** comment lists each rule Triage could not confirm, with checks still running or cancelled under **Waiting on**.

### Labels

Triage keeps a verdict label on every pull request so that other tools, such as a coding agent, can react to it. It puts the verdict's label on the pull request and takes the other two off. The defaults are **Triage: Ready** for Pass, **Triage: Not Ready** for Fail and **Triage: Needs Human Review** for Unsure; the file can rename them. While Triage waits for CI it shows **Triage: Waiting for CI**, and when it could not read the pull request **Triage: Failed to Run** (see [What the author sees](#what-the-author-sees)). A step that labels each failed rule, shown as **Label each failed rule**, adds a label such as `rule: linked-issue` for every rule that failed. The label of a rule set to `onFail: label`, and the `sensitive: medium` and `risk: medium` labels, is added whatever the verdict, after the verdict's own steps, as an **Add labels** action: on its own where Triage adds labels on its own, otherwise waiting for you on Triage. The same action takes off the label of a rule that now passes, and a level label of sensitive paths or risk that no longer applies. A label a `labels` step in the policy also names is left alone.

On Bitbucket Data Center labels have no effect; see [Bitbucket Data Center repositories](#bitbucket-data-center-repositories).

### Code review

Code review reads each new commit of a pull request for bugs, and skips drafts. It runs with triage, so only in a repository where triage is on, and only when the repository's [policy file](#writing-the-file) turns code review on. Once a pull request has a review, **Review again** reviews the latest commit once more, whatever the policy file says.

It needs the workspace's Anthropic key, saved under [Settings → Code review](#code-review-2).

### Where code review runs

Code review checks out the pull request's code, so each review runs in a place of its own, apart from Triage and from other reviews: a Docker container on the server that runs Triage, or on a separate machine such as a VPS ([Docker on another machine](../provisioners/docker-remote.md) says how your server administrator sets that up), or in an [E2B](../provisioners/e2b.md) or [Railway](../provisioners/railway-sandboxes.md) sandbox in the cloud. [Settings → Code review](#code-review-2) says where it runs.

A server with no isolated place set up for Triage has nowhere to run it. Each repository's page then says **Code review needs an isolated place to run**, with **Set one up**, which opens Settings → Code review, and **Review again** is hidden on Triage. Nothing is reviewed until a place is set up.

![The Code review section on a server with no isolated place: Code review needs an isolated place to run, with Set one up](images/38.png)

If [Settings → Code review](#code-review-2) says **Could not read where code review runs**, repository pages leave out their Code review section and **Review again** is hidden on Triage.

### Removing a repository

**Remove repository**, at the bottom of the repository page, asks you to confirm, then stops Triage on that repository and takes it off Repositories. Its pull requests leave Triage. For a Bitbucket Data Center repository it also deletes the webhook Triage created; if the token may not, Triage tells you to delete it by hand.

### Outcomes

The **Outcomes** card shows what happened to the pull requests Triage saw, beside those closed before Triage's first verdict in the repository. Each side gives the median time from opening to **Merge or close**, to the **First response** from someone other than the author, to the **First approval** (approved pull requests only), and the **Longest wait** between two people's touches. **Waiting on reviewer** is the time from Triage's first verdict to the first approval, change request or merge by someone other than the author (a plain comment is not a review), so it shows only on the Triage side. Each figure is the median with its 75th percentile (**P75**) beside it, which shows how long the slower quarter of pull requests took. Above them is how many people were involved. Each side also says how many pull requests it stands on and how many are closed. Triage reads these from the host in the background, so the card appears once they are measured.

When the before-Triage side is missing, the card says why: nothing closed before Triage was switched on, Triage has given no verdict there yet, or the host did not answer. When nothing can be read, the card says that instead: you need a credential for the host, the host did not answer (the numbers return once it does), or the repository is not connected.

## Day to day: Triage

Once triage is on, **Triage** is where you will spend most of your time. It is the page you land on after you sign in, unless the workspace has no repositories yet, which opens Repositories instead. It lists pull requests, shows each one's verdict and reasons, and offers the next step as a button. Beyond what the repository's policy file has Triage do on its own (see [Actions](#actions)), nothing happens on GitHub or Bitbucket until you press one of those buttons.

### Finding your way around

The dark strip on the left is the same on every page:

- **Workspace name** at the top. If you belong to more than one workspace, click it to switch.
- **Triage**: every pull request, with **Needs you**, **Waiting**, **Ready**, **Open** and **All** along the top of the list. **Needs you** shows only pull requests with a decision for you, in repositories with triage on. A pull request with an approval or a held action waiting for you stays there even after triage is turned off. **Waiting** lists the ones waiting on someone else. **Ready** shows the pull requests you can merge now. **Open** shows every open pull request in every repository with triage on, and any with an approval waiting. **All** shows every open pull request across the repositories Triage runs on.
- **Your name** at the bottom. Click it for Repositories, Settings and Sign out.

When a newer version of Corbits Triage is released while the portal is open, a notice at the top says **A new version of Corbits Triage is available.** Press **Reload** to switch to it; the page never reloads on its own.

Until the workspace has a decision model, a card at the top of Triage says **Connect a decision model**, and **Connect** opens Settings → Triage, where you add it.

Each list with pull requests in it has a search box and a **Filter** button. **Needs you** adds quick filters such as Action, Repo and Owner; **Open**, **All** and **Waiting** add Waits on.

On a phone the strip becomes a bar at the bottom of the screen with **Triage**, **Repos** and **Settings**. To refresh a list or an open pull request, pull it down from the top until the round arrow turns dark, then let go; it spins until the latest is in, and your place in the list stays where it was.

### Needs you

![The Needs you view: pull requests grouped under Decide, Review, Unblock and Merge, each row with its state mark and its title, and under the title a number such as gadgets#1520, a short status such as Decide: Focused, Ask to fix: Linked issue or Ready to merge, and its age. The right pane shows acme/gadgets pull request 1520 with its status line and Reply, Request changes and Close in the bottom bar](images/11.png)

Pull requests are grouped by what you need to do: **Unblock** for ones that are stuck on something, **Merge** for ones that passed, and so on. Each row shows a state mark and the pull request's title, and under the title its number, the same one line its pane opens with, and how long ago it was triaged. In **Needs you** that line always starts **Needs you:** and names the decision, such as **Needs you: Ask @ada to fix: Linked issue +2 more**, **Needs you: Decide: Focused (Triage wasn't sure)** or **Needs you: Ready to merge**. A pull request that passed is under **Merge** only once GitHub or Bitbucket has said it would merge it now. Until then it is under **Review** and its line says **Needs you: Can't merge yet:** and why, such as **GitHub hasn't checked for conflicts** or **waiting for a required review**. One the host refuses for any other reason is under **Unblock**, such as **Needs you: Can't merge yet: behind its base branch**. Grouped by Repo, the row shows the author after the line; grouped any other way, the number carries the repository's name, such as `widgets#12`. Click anywhere on a row to open it in the reading pane on the right, where the actions are.

A pull request whose triage run failed, or that Triage recorded it could not check, is under **Failed** and says why, such as **Needs you: Couldn't triage: the run failed · Triage again**; **Triage again** tries once more. A draft's failed run is listed too, and its line ends **use Triage again in More**. When the run on commits newer than the verdict fails, the line reads **Needs you: Triage could not check the new commits · Triage again**. When Triage is not running on GitHub or Bitbucket at all, the list says so once at the top, such as **Triage is not running on GitHub. Settings, under Triage, shows why.**, with **Open Settings**, and leaves that host's pull requests out of **Failed**.

A pull request leaves Needs you while Triage is at work on it: while it runs, waits on CI, or waits on the judgement rules or code review. It comes back once Triage has something for you. Drafts, ones you already acted on, ones on the author's turn after feedback was posted or changes were requested, ones Triage has not triaged yet, and ones whose verdict Triage could not settle stay out too. A pull request with commits newer than its verdict stays only when that verdict asks you something. A pull request with an approval or a held action waiting for you is the exception: it stays, drafts and ones on the author's turn included, until you approve the action or click **Hide for me** in its pane or **Skip** on its page, which hides it in this browser only. An action Triage will take on its own once CI finishes is not waiting for you, so it keeps nothing in Needs you. Click **Waiting** along the top of the list, which shows how many there are, to list the others instead, in the same list and pane, grouped by what they wait on; Needs you and Waiting together are Open. Click **Needs you** to go back. When nothing needs you, the list says **Inbox zero**, with **Show 7 waiting** (or however many there are) to open Waiting.

### Ready

The **Ready** view lists open pull requests you can merge now, oldest first, with the same rows and pane: Triage passed the latest commit, CI passed, there are no conflicts and GitHub or Bitbucket has said it would merge it now. Drafts stay out, and so does any pull request whose merge state is still being checked, that waits for a required review or that the branch's rules hold. **Merge** is the pane's next step. A new commit takes a pull request out until Triage passes it again.

### Open

The **Open** filter groups pull requests by repository, with the same rows. Group by **Waits on** to see whose move it is: you, the author, CI, Triage or nobody. **Needs setup** collects pull requests Triage cannot check until their repository is set up: its policy is refused, missing, unreadable or has no rule on. Once you act on a pull request, its line says where that leaves it, such as **Done: Waiting on @ada to fix: Linked issue** after you request changes, or **Needs you: You approved · ready to merge**.

A pull request Triage has not triaged yet shows **In progress: Checking this pull request** while its first run goes, or **In progress: Waiting on CI** while Triage waits for its checks, and **Waiting: not triaged yet · Triage again** when no run is going, or **Waiting: not triaged yet** on a host where Triage is not running. When Triage recorded why it could not check the pull request, that reason appears in the same place, on the row and in the pane, such as **Needs you: Couldn't triage: the run never started · Triage again**. A draft with no verdict shows **Waiting: draft**, since Triage waits until it is marked ready for review.

### All

**All** lists every open pull request across the repositories Triage runs on, with the same rows and grouping as Open.

### The reading pane

Clicking a pull request opens it on the right. The pane is built to be read top to bottom.

![The reading pane for a failing pull request: the status line Request changes from @ada: Merge conflicts, the problem Merge conflicts with base, the description, folded rows for linked issue, files and Checked and fine, and a bottom bar with Request changes, Close, Approve and the other actions](images/12.png)

1. **The header**: repository and number, the title, the author with their chip, when it was opened, and how many lines were added and removed. The **View on GitHub** or **View on Bitbucket** link in the corner opens the same pull request there. The pull request's own page has the same link. On a pull request Triage opened itself, such as the one adding its policy file, the link reads **Review on GitHub** or **Review on Bitbucket**.
2. **The line** that says, in one sentence, where the run stands. It takes one of three forms:
   - **In progress:** what Triage is doing or waiting on, in the order it comes: **Checking this pull request**, **Waiting on CI**, **Waiting on the judgement rules, then code review**, or **Waiting on code review**. It says this only while Triage has a run going or waiting, and the row says the same.
   - **Needs you:** the one decision that is yours, with what the main button at the bottom does:
     - **Send feedback**: **Ask @ada to fix: Linked issue, Conventional commits +1 more**, naming up to two failed rules and how many more, or **Send feedback to @ada** when no rule failed.
     - **Request changes**: **Request changes from @ada: Linked issue**. When no rule failed it says what GitHub or Bitbucket holds it for, such as **Request changes from @ada: behind its base branch**, or just **Request changes from @ada**.
     - **Approve**: **Review and approve** with every rule met, or **Approve anyway, or ask @ada to fix: Linked issue** when one failed.
     - **Reply**: **Reply to @ada**, or **Reply to @ada · not met: Linked issue** when a rule failed and Triage drafted no feedback.
     - **Merge**: **Ready to merge**, or **Ready to merge · still not met: Linked issue** when a rule failed. A pull request that passed but that GitHub or Bitbucket will not merge yet says why instead, such as **Can't merge yet: waiting for a required review**, **Can't merge yet: behind its base branch**, **Can't merge yet: the branch's rules block the merge** or, on Bitbucket, the reason its merge checks give, and **Merge** stays off until it can. A pull request Triage opened itself is merged rather than approved, so it reads **Ready to merge** too; with no button and a rule failing it reads **Not met: Linked issue**, and when GitHub or Bitbucket holds it with nothing failed, **Blocked:** and why, such as **Blocked: behind its base branch**.

     Some decisions come before the button. A pull request the author updated after your review reads **Re-review: @ada updated it**, then what is still open, such as **· still not met: Linked issue** or **· still to decide: Focused**, or **· all rules met** when nothing is. A rule you need to decide reads **Decide: Focused (Triage wasn't sure)** when the model was unsure, **Decide: Linked issue (your policy asks you)** when the policy asks you about it when it fails, or **(see why below)** for both. A rule that could not be checked reads **Couldn't check Merge conflicts · use Triage again in More**. After you approve, it says only what is still open or what holds the merge, such as **You approved · still not met: Linked issue** or **You approved · ready to merge**. When an action waits for your approval on a pull request that is otherwise the author's, the line names it, such as **Needs you: Approve or hide the held action: Add label bug**.
   - **Done:** what the run ended with: the verdict as its label on the pull request says it (**Ready**, **Not ready** or **Needs human review**), what Triage posted on its own, and whose turn it is, such as **Done: Not ready · added label risk: medium · waiting on @ada to fix: Linked issue**. A merged or closed pull request reads **Done: Merged** or **Done: Closed**, a draft with a verdict **Done: Not ready · draft · waiting on @ada**, and once you approve with nothing left for you, **Done: You approved**. **Reply** stays available if you want to add something. A verdict Triage could not settle reads **Done: Needs human review · Triage could not settle it · Triage again**. When the author pushed commits Triage has not checked, the line adds **newer commits not yet checked**, and **Triage again** when nothing in it is yours. A passing pull request is never merged before Triage checks them, so it reads **Done: Ready to merge · newer commits not yet checked · Triage again**. On the author's turn it reads, for example, **Done: Not ready · waiting on @ada · newer commits not yet checked · Triage again**.
   - **Waiting:** a pull request Triage has not judged and has no run for: **Waiting: draft**, or **Waiting: not triaged yet · Triage again**. It is never in Needs you.

   Under the line are the actions the policy held. One Triage may take on its own but holds while CI runs reads **Will run when CI finishes:** and what it does, such as **Will run when CI finishes: add label risk: medium**; Triage takes it then without you. Any other reads **Held:** and what it does, such as **Held: Merge**, with why it is held under it, and waits for you. The list names what each does: adding a label, a merge off a fail or unsure verdict, which says so, and a held comment or change request, which shows the start of what it posts, such as **Comment "Please split this."**. **Do it** beside each runs it now, **Always, in this repository** leaves it to Triage there from then on (see [Taking action](#taking-action)), and **Hide for me** under the list hides them in this browser only.
3. **The problems**, if any, failed rules first. Each one names the rule, then why, such as **Linked issue: Pull request does not reference an issue.**, with the evidence, such as the name of the failing check. A rule you need to decide is marked with a question mark and named once, such as **Focused: Triage could not tell whether the changed files serve this pull request.**, since the status line above already says **Decide**. A pull request with no problems skips straight to the description.
4. **Code review**: before the first review of a pull request whose policy file turns code review on, it says **Code review: awaited**, and a pull request the policy left out of code review says **Not reviewed:** and why. Once reviewed: what the change does, then each bug it found as a comment from **Code review**, with the commit it reviewed, how severe it is (P0 is the most severe), the file and line, and the code it points at. A bug in a file code review could not read says **Not checked against the file**, here and on GitHub. If the review fails or runs past its hour, the section shows **The last review did not finish** instead of **No findings**. **Review again** reviews the latest commit once more; it is hidden on a draft. A commit that left the change as it was keeps the last review and says **Carried over from** the commit it was made for. Triage posts the review on the pull request with the verdict, inline where the lines are part of the change. A finished review that is not on the pull request yet offers **Send to GitHub**, which then says **Sent to GitHub**, or on Bitbucket Data Center **Send to Bitbucket**, which posts a comment per finding and one summary comment. Either needs the Comment permission for the repository, and is refused once the pull request has newer commits that did not keep the review: review again, then send. Once new commits arrive, each bug Triage posted inline shows what became of its comment: **Resolved** when someone resolved it, **Outdated: its lines changed** when the lines it points at changed, or **Replied to** when someone other than Triage answered it, with how long ago when GitHub or Bitbucket says when. A bug in the review's summary comment, one posted before Triage started keeping track, or one sent with **Send to GitHub** or **Send to Bitbucket** that Triage does not post again itself shows nothing. A closed or merged pull request is not checked again.
5. **The description** the author wrote.
6. **Folded rows** you can expand: the linked issues, the changed files (with the diff), and the rules that passed. Evidence for a file cites its changed lines and links them at the exact commit Triage judged. Linked issues are the GitHub issues the title, description or commits mention, and the Linear issues linked in the description, the commits or a comment from one of Linear's bots. Links hidden in the description are ignored.
7. **Commits and conversation** opens the pull request's page. That page reads the verdict, the evidence, then **Commits** and **Conversation**. See [The pull request page](#the-pull-request-page).

![The reading pane for acme/widgets #2 with its Code review: 3 findings, Sent to GitHub and Review again, the summary, then comments from Code review (Bot, reviewed 60f1fc6): total() skips the first element, P1 at src/total.ts:3, and average() divides by zero for an empty array, P2 at src/total.ts:26–32, each with its quoted line](images/28.png)

![The reading pane for a passing pull request: the status line Ready to merge, the description with its linked issue, folded rows, and a bottom bar whose first button is Merge into main](images/13.png)

![The Checked and fine row expanded, listing each rule with its result: not a draft, CI passing, 0 change requests, no conflicts, issue linked, focused does not apply](images/14.png)

Expanding **Checked and fine** shows every rule with a short note on why it passed, such as CI passing or the number of files changed against the limit. This is the quickest way to see what Triage actually checked.

### The pull request page

**Commits and conversation** in the reading pane opens the pull request on its own page. **Comment** sits at the top and opens a box where you write a comment and send it, and **View on GitHub** or **View on Bitbucket** opens it on the host. On the side are **About**, **Files** and **Issue**.

The page opens with the same one line as the reading pane, such as **In progress: Waiting on CI**, **Needs you: Ready to merge** or **Done: Not ready · waiting on @ada**. Then it reads from top to bottom:

1. **The verdict.** The header shows it beside the repository and number, with whether GitHub or Bitbucket would merge it. Under the title, one line says why, and **Status** states the verdict again.
2. **The evidence.** **Rules** lists what Triage checked and what it found. **Pull request**, **Issue**, **CI** and **Reviews** sit with that.
3. **Commits**, after **Readiness history**. Each commit shows its short id, the first line of its message, who made it and when. When there are none, it says **No commits.**
4. **Conversation.** Each comment shows who wrote it and when, then the comment. When there are none, it says **No comments yet.**

**About** is that reading. **Files** lists the files that changed; choose one to read its changes. **Issue** lists the linked issues, or says **No linked issue.** Choose **About** to come back to the verdict, the evidence, the commits and the conversation.

Under the header, one card follows the repository's policy:

- When the policy held an action, the card names it as the reading pane does, such as **Held: Merge** or **Will run when CI finishes: add label size/xl**, and says why. **Approve** lets Triage do it now, and **Skip** hides it in this browser only. **Merge** and **More** sit on the card, with **Confirm** and **Dismiss** when an approval is waiting.
- When Triage acted on its own but the next step is yours, such as a policy that adds labels and leaves merging to you, the card says what Triage did and why, with **Merge** and **More** beside it.
- When Triage will merge it, or the next step is the author's, the card only says what Triage did and why, such as that it commented because a rule failed, and the page has no **Merge** or **More**.
- An action Triage has not posted yet is listed under **Not posted yet** rather than as done.
- Otherwise there is no card, and **Merge** and **More** sit at the top.

**More** holds **Close pull request**, and **Approve** and **Request changes** unless Triage opened the pull request. A closed or merged pull request offers none of these, and no held action.

### Taking action

The bar at the bottom of the pane always offers the next step first. For a passing pull request that is **Merge**, for a failing one it is **Request changes**, and for an unsure one it is usually **Comment** or **Approve**. **Edit feedback** and every other action sit beside it as buttons. Actions the repository's policy held are listed under the line at the top of the pane (see [The reading pane](#the-reading-pane)). **Do it** beside one approves that one action, once, as you; it shows only when your role may approve that kind of action in the repository. **Always, in this repository** approves it the same way and also lets Triage do that kind of action on its own in the repository from then on: other pull requests holding the same action show it as pending once Triage checks them again, and it no longer waits for you. It shows only to people who may manage the workspace's access, only for an action the repository's policy file names, and never for Close on an Unsure verdict or Merge on anything but Pass, which always wait for a person. Settings lists what Triage now does on its own (see [What Triage does on its own](#what-triage-does-on-its-own)). When the next step is itself an action held for you, such as a held **Merge** on a passing pull request, its button also says **held for you**, and clicking it approves the held action once. On a phone the next step spans the width, with **Edit feedback** and **More**, which holds the other actions, on one row under it.

- **Merge** merges the exact commit Triage checked. If the author pushes a new commit in the meantime, the merge is refused and Triage checks the new commit first. Merge is off while GitHub or Bitbucket would not merge the pull request, here and on the pull request's own page, which shows the reason beside its status, such as **Merge blocked · Waiting for a required review**. If the host refuses a merge anyway, the message gives its reason.
- **Request changes** sends the author a review listing the rules they need to fix. When they fix them, Triage withdraws the request on its own.
- **Approve** approves the pull request on GitHub or Bitbucket. Triage never withdraws an approval you made yourself.
- A pull request Triage opened itself offers **Merge** but not **Approve** or **Request changes**, because GitHub and Bitbucket don't let a pull request's author review it. Review it on GitHub or Bitbucket.
- When GitHub refuses an action, the message gives GitHub's reason, such as **Can not approve your own pull request**.
- **Comment** posts a comment, and **Post reply** answers the author. **Edit feedback** lets you reword the comment Triage will post before it goes out.
- **Close** closes the pull request, such as one Triage found has the same changes as another open pull request, which its comment names.
- **Triage again** re-runs the checks on the current commit.

Anything you do here is also written to the audit log.

### What the author sees

Authors do not use the portal. Depending on the repository's actions, they see a comment from Triage on their pull request with the verdict and reasons, review requests, and on GitHub labels such as **Triage: Ready**, **Triage: Not Ready** or **Triage: Needs Human Review** and assignments. On Bitbucket they see the verdict as the **Corbits Triage** build status instead of a label. **Triage: Ready** comes off as soon as Triage sees a new commit and returns once that commit passes, so it never stands on a commit Triage has not checked. While Triage waits for CI, they see **Triage: Waiting for CI** in its place, or no Triage label when the commit has no checks; **Triage: Not Ready** and **Triage: Needs Human Review** stay until the new verdict. When Triage could not read the pull request, or the repository's policy, it shows **Triage: Failed to Run** in place of any verdict label, or on Bitbucket a failed **Corbits Triage** build status that says **Triage couldn't run**, and posts nothing else. On GitHub it does this only where Triage adds labels on its own; on Bitbucket it always does. It clears on the next run that can read the pull request, which shows the verdict again. Triage keeps one comment and edits it in place as the pull request changes, so an author who pushes a fix sees the fresh verdict in the same comment. Each change Triage asks to split out names what it is not part of: the pull request's title. When new commits change the verdict, the comment also says what the verdict was, how many commits arrived since and which pull requests were merged into the branch. Only when someone changes the repository's policy and that changes the verdict on the same commit does Triage post a new comment, which says it supersedes the one above.

## Settings: Triage, code review and people

**Settings** is reached from the menu under your name at the bottom of the left rail. It is one page with four sections: Triage, Code review, People and Your account. The links at the top jump to each section. At the very bottom, **Versions for support** opens the version of Triage deployed for each connected host, marked **(not running)** when it is not up, with a **Copy** button; support will ask for it when you report a problem. Most teams visit it once during setup and then only to invite people.

### Triage

Everything triage needs, top to bottom: its status, where pull requests come from, each repository's policy file, the decision model, and the actions Triage takes without asking.

![The top of the Triage section of Settings: Triage is running on 0 of 2 repositories, with Choose repositories](images/22.png)

The first line says how many repositories Triage is running on, with a **Choose repositories** link. Until a decision model is added, it says **Triage needs a decision model before it can run. Add one below.** Judgement rules are the ones that use the model. Add it on this page: pick a provider, paste the key and save it. The key is stored in the server's vault and you will not see it again.

When pull requests on a host have waited too long for Triage to start on them, the next line says so, for example **Pull requests on GitHub have waited since 10:42 for Triage to start.** The same line shows at the top of every page, with **See Triage settings**, until Triage starts a pull request on that host again; it stays below the **A new version of Corbits Triage is available.** notice rather than behind it. When the server sends email, the workspace's owners and admins get one email when this begins and another when Triage starts that host's pull requests again. The server's operator sets how long counts as too long, five minutes unless changed.

The next line says how busy this server is, for example **This server runs 3 of up to 8 Triage workflows at once.** Each host's listener takes one of those places, and each pull request being triaged takes another while it runs. When they are all taken and the server has a sandbox set up, the line adds **2 more run in a sandbox because it is full.** Without a sandbox it says **it is full, so a new pull request waits a few minutes for a place, then is tried again on its next update.** Once some are waiting, it says how many instead, for example **3 more wait for one to finish.** The server's operator sets how many there are.

#### Which version runs

Once a source and a decision model are set up, a line below the status says which version of Triage runs, one line per connected host (named when there are two):

- **Triage is starting.** Triage has not started on that host yet. It starts on its own a few minutes after the host is connected or the decision model is saved.
- **Triage runs version 0.1.0-sha-66ee60f0, started 10/26/2026, 9:14:03 AM.** That host runs that version, started then.

Nobody presses anything to keep Triage current. It starts or updates itself on each connected host when the Triage server starts with a new version, when a host is connected or one of its credentials is replaced, and when a model key is saved or removed, so saving the Anthropic key under [Code review](#code-review-2) turns code review on with nothing else to do. Each time, the new version starts, and once it runs the version before it stops, along with the earlier triage and code review workflows it replaces. If the new version does not start within five minutes, it is stopped and the version already running keeps running. A line under the version then says **Updating Triage failed; see the hub log.** The Triage server's log says why. Triage tries again about every ten minutes, and also when a connected host is found with no Triage running, and the line goes away once an update succeeds.

#### GitHub and Bitbucket Data Center

Triage reads pull requests from GitHub, Bitbucket Data Center, or both. Each has a card of its own.

![The GitHub card, with the GitHub App connected and installed on 2 repositories, its secrets and its Webhook URL, then Bitbucket Data Center is not connected, with a Connect button](images/17.png)

A host that is not connected takes one line with a **Connect** button. The **GitHub** card shows whether the GitHub App is connected and how many repositories it is installed on. Press **Choose repositories on GitHub** to add or remove repositories. GitHub's own installer opens, and when you come back, any new repository appears under Repositories with triage switched off.

Below that are the secrets the App needs: the GitHub App and its webhook secret. The webhook secret has a **Rotate secret** button, and owners and admins can **Replace key** on the GitHub App row (see [Rolling credentials](#rolling-credentials)). If Triage cannot renew its access to GitHub, the GitHub App row says why and what to check, and once the access has run out the GitHub source says so; Triage runs again on its own once GitHub answers. Code review reads your code with separate read-only access to your repositories, so it can never change them; if GitHub refuses that access, the row says code review cannot run, while triage carries on. Each has a **Remove** link; removing the GitHub App deletes its private key and disconnects Triage from GitHub, so do that only when you mean to. The **Webhook URL** is what GitHub uses to tell Triage about pull request events. You only need it if you set up the App by hand.

The **Bitbucket Data Center** card reaches an instance with an HTTP access token. To connect one, press **Connect**, enter the **Instance URL**, such as `https://bitbucket.example.com`, paste the **HTTP access token** and press **Connect**. Triage tries the token once and stores it in the server's vault only if the instance accepts it. If your instance is on a private network, the person who runs your Triage server must allow its address first; until then Triage refuses the URL, and a workspace already connected to it stops reading from it.

Create the token for a dedicated Bitbucket user named **Corbits Triage**, not for a person, so that Triage's comments and reviews show under that name. **Download the Corbits Triage avatar** gives you a picture for that user. The token needs:

| Permission | For |
| --- | --- |
| Project read | Listing projects and repositories |
| Repository write | What Triage does on pull requests |
| Repository admin | Creating each repository's webhook. Without it, a repository admin sets the webhook up by hand (see [Bitbucket Data Center repositories](#bitbucket-data-center-repositories)). |

Once connected, the card says **Connected to** the instance and shows the **Webhook URL**, where Bitbucket sends pull request events. Triage creates each repository's webhook when you turn triage on, if the token allows it. **Disconnect** stops triage on every Bitbucket Data Center repository and removes the webhooks Triage created; their rules are kept. If a webhook cannot be removed, the card names the repositories where an admin must delete it by hand. **Replace token** and the webhook secret's **Rotate secret** are described under [Rolling credentials](#rolling-credentials).

#### Repositories

![The Repositories card: acme/widgets with No .corbits-triage.yml and a Start a policy file link, then acme/gadgets with Has .corbits-triage.yml, and Open Repositories](images/40.png)

Lists each connected repository and whether its default branch has a `.corbits-triage.yml` policy file. A repository with triage on and no file has a **Start a policy file** link to its repository page, where the steps are (see [Policy](#policy)). **Open Repositories** is where triage is turned on or off per repository.

#### Decision model

![The Decision model card: Answers your policies' Judgement rules and chooses the verdict, and Judge pull requests with TypeSafe (Jev), Key stored, with Rotate and Remove](images/41.png)

**Judge pull requests with** names the decision model in use, by its provider, or by its address and model name for your own provider. It answers your policies' Judgement rules and chooses the verdict. Setup does not ask for it. A repository whose policy has judgement rules says it needs a model until you save one here.

The row says **Key stored** or **No key**. With no key, its form is open below it: pick one of the listed providers and paste its API key, or choose **Add my own provider** and enter the address of a compatible service. **Rotate** opens a blank form to replace the key, and **Remove** deletes it after you confirm. Keys are kept in the server's vault and never shown again. When Triage cannot read the saved keys, the row says **Triage could not read the saved keys** with the reason, and shows no form.

#### Actions Triage takes on its own

This card decides, for the whole workspace, whether a repository's policy file is enough for Triage to act. Owners and admins see the switch **Take the actions each policy file names without asking**; everyone else sees only which way it is set. It is on in a new workspace, and off in one set up before Triage had this switch, until an owner or admin turns it on.

- **On.** Triage takes every action an enabled repository's policy file names, such as Assign or Merge, on its own, on GitHub and Bitbucket Data Center alike. Once a change to the file is merged, Triage reads it within a few minutes and from then on does what it now names; an action taken out of the file goes back to waiting for you. Closing on Unsure, and merging on anything but Pass, still wait for you. A file Triage refuses changes nothing until it is fixed.
- **Off.** Triage posts its verdict on its own, the comment and on GitHub its label, and every other action waits for you on Triage. A pull request that changes a policy file from Triage lists the actions that will wait, such as `assign` and `merge`.

Turning the switch on takes effect for every enabled repository within a few minutes. Turning it off leaves what Triage already does on its own as it is.

#### What Triage does on its own

Owners and admins see one line for each repository with triage on, such as **Triage does these on its own: Comment, Add labels, Assign.** When it lists none, the line says **Triage asks before every action here.** On a GitHub repository where Triage approves or merges on its own, the line also says **Triage approves or merges on its own, which can let unintended code in:** and names **pull requests from first-time contributors** or **changes to CI workflows**; it is only a caution.

With **Take the actions each policy file names without asking** on (see [Actions Triage takes on its own](#actions-triage-takes-on-its-own)), what is listed comes from the repository's policy file, so the line says **This repository's policy file sets these.** With it off, the list is what people allowed with **Always, in this repository**, and each action has a **Remove** link that makes it wait for a person again.

#### Rolling credentials

Every secret Triage holds can be replaced from Settings without disconnecting anything. After you replace a credential, Triage starts again with the new value a few seconds later; pull requests in progress finish with the old one. If it cannot start again, the new secret is still saved, the version before keeps running, and the line under the version says why (see [Which version runs](#which-version-runs)).

**GitHub App key.** Press **Replace key** on the GitHub App row. In your App's settings on GitHub, generate a new private key, then choose the downloaded `.pem` file and press **Save**; GitHub checks that the key belongs to the connected App before it is saved. Then delete the old key on GitHub. To switch to another App, use **Create GitHub App**.

**GitHub webhook secret.** Press **Rotate secret** on the webhook row. Triage makes a new secret and shows it once: paste it as the webhook secret in your App's settings on GitHub straight away, then press **I pasted it on GitHub**. Pull requests that change before you paste it are picked up automatically.

**Bitbucket Data Center token.** Press **Replace token**, paste a new HTTP access token for the Corbits Triage user with the same permissions and press **Save**. Triage tries it against your instance and keeps the old token if the instance refuses it. Then revoke the old token in Bitbucket.

**Bitbucket Data Center webhook secret.** Press **Rotate secret** on the webhook secret row. Triage saves a new secret and updates every webhook it created to use it. Repositories whose webhook was set up by hand, or whose webhook Triage could not update, are named afterwards: each one's repository page shows the new secret, so update its webhook in Bitbucket from there. Pull requests that change in the meantime are picked up automatically.

**Model keys.** Press **Rotate** on the [decision model](#decision-model) or on the Anthropic key under [Code review](#code-review-2), and paste the new key. The key already stored is not shown.

### Code review

![The Code review section: Review code with Anthropic, No key, with the Anthropic key field and Save key, then Where it runs: Docker on this machine, In use; Docker on another machine (TLS), Not set up, with its .env lines, Copy and Setup guide](images/43.png)

[Code review](#code-review) runs with the provider whose key is stored here, Anthropic. **Review code with Anthropic** says **Key stored** or **No key**. With no key, the Anthropic key field is open: paste the key and press **Save key**. When a key is stored, that field is hidden and the key itself is not shown. **Rotate** opens a blank field for a new key; press **Save key** to replace the stored one. **Remove** deletes it after you confirm. As for the decision model, when Triage cannot read the saved keys, the row says so and shows no field.

When no place is in use, the top of this section says **Code review needs an isolated place to run** and names the place recommended, the first in **Where it runs**, with the lines to add to the Triage server's `.env`, **Copy**, and its **Setup guide**. Once a place says **In use**, that notice is gone.

Below it, **Where it runs** lists every isolated place this server can run code review, such as **Docker on this machine**, **Docker on another machine (TLS)** **E2B sandboxes** and **Railway Sandboxes**, each with a line on why you would choose it. Code review never runs inside Triage itself. It runs in the first place in the list, in the order shown, that is ready. When that place is full, new reviews wait there for room; they do not move to the next place.

Each place says **In use**, **Ready**, **Not set up** or **Failing**; admins also see why it is failing. Under a failing place are the lines to add to the Triage server's `.env`, with **Copy**, and its **Setup guide**; under a place that is not set up, press **How to set it up** to show them. Add them, restart the server, and the place turns **Ready** or **In use**. For **Docker on another machine (TLS)**, the lines carry the certificates themselves, each as one line of base64, so nothing is copied onto the server's disk; its setup guide shows how to make them.

![Where it runs on a server with no place set up: Docker on this machine and Docker on another machine (TLS), both Not set up, each with How to set it up](images/44.png)

If the server cannot say where code review runs, **Where it runs** is replaced by **Could not read where code review runs** with the reason, and repository pages leave out their Code review section. The rest of the portal works as usual; reload the page to try again.

### People

**People** lists everyone in the workspace with their role. To add a teammate, type their email, choose a role and press **Invite**. They receive a sign-in link that works once and expires after 15 minutes. If your server is not set up to send email, you can invite only people who have already signed in, and the portal shows you the link to copy and send yourself.

If your server is not set up to send email, someone who signed up with an email and password shows **Email not verified**, or **Invite pending** while invited, and if you are the first person who used this Corbits Triage, a **Mark verified** button. Press it only if you know the address is theirs: it lets them into the portal, and they can then accept your invite.

There are three roles:

| Role | What they can do |
| --- | --- |
| Owner | Everything, including workspace settings and inviting people. The person who created the workspace is its owner. |
| Admin | Manage repositories, rules and people. |
| Member | Use Triage and approve the held actions their role allows. |

The **Role** column lists every role a person holds.

### Your account

![Your account: signed in as maintainer@example.com with a Sign out button, and the list of signed-in browsers](images/20.png)

Shows the email address you are signed in with, a **Sign out** button and the browsers you are signed in on. Only you see this section.

#### Sign in a device

A command-line tool or coding agent signs in through the portal. Open the link it gives you, or **/device** on the portal, enter the code it shows and press **Continue**. Check the tool's name and code, then press **Approve**, or **Deny** if you didn't start it. An approved device can do everything you can. Sign it out under **Settings → Your account**.

## Audit

The **Audit** page is the record of everything that happened in your workspace: who approved what, which actions Triage carried out, which permissions were granted, and when. Open it by adding **/audit** to the end of the portal address, for example `https://triage.example.com/audit`.

![The Audit page: a search box, a repository filter, an Export button and a table with Time, Actor, Action, Target and Detail columns](images/21.png)

The page shows the latest 100 events, newest first. Each row has:

- **Time** the event happened.
- **Actor**: the person or system component that did it. Events the server did on its own show as unknown.
- **Action**: what was done, such as Granted, Approved or Merged.
- **Target**: what it was done to, such as a pull request or an internal account.
- **Detail**: a short description.

Type in the search box to narrow the list by actor, action or pull request. The dropdown limits the list to one repository. **Export** downloads what you are looking at as a file you can keep or send to someone. Many of the earliest entries are permission grants made automatically when Triage set itself up, which is normal; more appear when a policy file names an action Triage did not take on its own before.

## Glossary and common questions

### Words you will see

| Word | What it means here |
| --- | --- |
| Pull request | A proposed change to a repository on GitHub or Bitbucket Data Center, waiting to be reviewed and merged. |
| Repository | One project's code, such as acme/widgets on GitHub or TRI/widgets on Bitbucket Data Center. |
| Source | Where pull requests live: GitHub or Bitbucket Data Center. Connected under Settings → Triage. |
| Workspace | Your team's shared space in Triage. One workspace can watch many repositories. |
| Portal | The Triage website. |
| Hub | The Triage server behind the portal. You never use it directly. |
| GitHub App | The connection between Triage and GitHub. Installing it on a repository lets Triage read pull requests and, if you allow it, write labels, comments and reviews. |
| HTTP access token | The connection between Triage and Bitbucket Data Center, created for a Bitbucket user named Corbits Triage. |
| Build status | The pass or fail mark Bitbucket shows beside a commit. Triage writes its verdict there as **Corbits Triage**, since Bitbucket has no labels. |
| Rule | One question Triage asks about a pull request, answered pass, fail or unconfirmed. |
| Decision model | The AI service that answers questions needing judgment, and that gives the final verdict when the policy has Judgement rules. Set under Settings → Triage. |
| Verdict | Triage's overall answer for one commit of a pull request: Pass, Fail or Unsure. |
| Score | How sure the decision model is that the pull request passes, from 0 to 1. A score of 0.9 means 90 percent sure. |
| Action | One step in a repository's policy, such as adding a label or requesting a review. |
| Held action | An action that is waiting for a person to approve it on Triage. |
| Policy | A repository's rules, verdict steps and labels, kept in its `.corbits-triage.yml` file. |
| Role | A workspace role (Owner, Admin, Member) that controls what a person may do in Triage. |
| CI | Continuous integration: the automated tests and checks a repository runs on every pull request. |
| Draft | A pull request its author has marked as not ready. Triage waits until it is marked ready. |
| Code review | Triage's optional bug finder, turned on by a repository's policy file. It reads each new commit, lists the bugs it finds in Triage and posts them on the pull request with the verdict. |
| Finding | One bug code review reports, with its severity (P0 is the most severe), file and line. |
| First-timer | Someone opening their first pull request in a repository. |
| Webhook | The channel GitHub or Bitbucket uses to tell Triage about new events. |
| Audit log | The record of everything that happened in your workspace. |

### Common questions

**Triage says Unsure. What should I do?** Read the pull request yourself. Unsure means the rules did not catch a problem but the decision model was not confident either way. Approve, request changes or comment as you would normally. If a rule could not run because the host had not finished computing something, such as CI, Triage will check again on its own.

**A pull request shows "Waiting: not triaged yet".** Check that triage is on for its repository, that its source is still connected under Settings → Triage, and that a decision model key is stored there. If all three look right, open the repository and press **Triage open pull requests again**. On Bitbucket, also check the repository has its **Corbits Triage** webhook.

**Does Triage ever merge, close or approve on its own?** Only when the repository's policy file names that action and either the workspace takes the actions each policy file names, as a new one does (see [Actions Triage takes on its own](#actions-triage-takes-on-its-own)), or someone chose **Always, in this repository** for it. Settings lists what Triage does on its own in each repository, under [What Triage does on its own](#what-triage-does-on-its-own). Close is never run automatically on an Unsure verdict, and Merge never on anything but Pass.

**Why did Triage not call the decision model for a failing pull request?** When a rule fails, the answer is already Fail, so the model is not asked the verdict question. A repository with no Judgement rules never asks it at all. This saves money and keeps verdicts predictable.

**Code review shows nothing for a pull request.** Check that the repository's policy file turns code review on, and that an Anthropic key is stored under Settings → Code review. It runs only after triage, for the groups in `for` and on the verdicts and paths in `when`. By default it reviews only once the rules in your file that fail a pull request and need no model have passed. CI counts only when `ci-green` is on. Triage's built-in checks, such as a draft or a requested change, don't hold the review back. A pull request that fails one gets its Fail with those reasons and no review, and one whose CI is still running is reviewed once CI passes. Write `when: { rules: any }` to review whatever those rules say. Drafts are not reviewed until they are marked ready. A review takes a minute or two; the section says **Reviewing** while it runs. Once there is a review, **Review again** starts a new one. If the Code review section says **Code review needs an isolated place to run**, whoever runs your Triage server sets one up first.

**The author pushed a fix. Do I need to do anything?** No. Every new commit gets its own verdict, and Triage updates its comment. If you had requested changes through Triage and every failed rule is now fixed, Triage withdraws the request for you. If a reviewer requested changes, the pull request moves to **Needs you** for their re-review.

**Can I try new rules without affecting anyone?** Rules change only in the repository's `.corbits-triage.yml`, so every change is reviewed in a pull request, or pushed from the editor where the branch allows it, and applies once it reaches the default branch. To watch what new actions would do first, turn off **Take the actions each policy file names without asking** in Settings → Triage: every action but the verdict then waits for a person.

**Where do I change my password?** Sign out. If the sign-in screen shows **Forgot password?**, use it, and a reset link is sent to your email.

**How do I remove someone from the workspace?** The portal does not change roles; an Owner or Admin changes or removes a person's role through the Triage server's API.

**Something looks wrong. What should I tell support?** The repository name and pull request number, what you expected, what you saw, and the versions under **Versions for support** at the bottom of Settings (use its **Copy** button). The audit log's **Export** button gives support a record of what happened.
