# Corbits Triage User Manual

Oct 13, 2026 · @Brian J. Fox

## Contents

1. [What Corbits Triage is](#what-corbits-triage-is)
2. [Getting started](#getting-started)
3. [Setting up a repository: rules, verdicts and actions](#setting-up-a-repository-rules-verdicts-and-actions)
4. [Day to day: the Inbox](#day-to-day-the-inbox)
5. [Settings: people, access and workspace configuration](#settings-people-access-and-workspace-configuration)
6. [The audit log](#the-audit-log)
7. [Glossary and common questions](#glossary-and-common-questions)

## What Corbits Triage is

Corbits Triage is an assistant for people who maintain code on GitHub. It looks at every open pull request in the repositories you choose, checks each one against the rules you set, and tells you whether it looks good to merge. Every pull request gets one of three verdicts: **Pass**, **Fail** or **Unsure**, along with a short list of reasons.

Think of it as a first reader. It does the routine checking (Did the tests pass? Is the change too big? Is there a linked issue? Does it need documentation?) so that you can spend your time on the pull requests that actually need a human opinion.

### Who uses it

- **Maintainers** open the portal, a web page where they see each pull request's verdict, its reasons and a suggested next step.
- **Teams** share one workspace. An admin invites teammates by email and decides who may do what.
- **Pull request authors** never need to log in. They only see what Triage writes on GitHub: labels, comments, review requests and assignments.

### What it never does on its own

Nothing runs until you turn it on. Installing the GitHub App only records your repositories, with triage switched off. A repository is checked only after someone turns on **Triage pull requests in this repository**. Even then, a new workspace automates nothing: Triage suggests actions, and a person clicks to carry them out, until you decide which actions Triage may run by itself, and in which repositories.

### The three parts

1. **The portal** is the website you use. This manual is about the portal.
2. **The hub** is the server that stores your settings, talks to GitHub and runs the checks. You normally never see it.
3. **The decision model** is an AI service that answers the judgment questions rules cannot answer from GitHub data alone, such as "Is this change focused on one thing?" You connect it once in Settings.

## Getting started

You use Corbits Triage through a website called the portal. Your administrator will give you its address. Everything in this section happens in a normal web browser.

### Signing in

Open the portal address. You will see the sign-in screen.

![The sign-in screen: an email field, a password field, a Sign in button and a link to create an account](images/01.png)

Type your email address and password and press **Sign in**. If your organization uses Google sign-in, a **Google** button appears instead of, or below, the password fields. If you forget your password, use the **Forgot password?** link under the password field.

### Creating an account

If you are the first person from your team, click **Sign up for an account**. The form asks for your name, your email address and a password.

![The create-account form with Name, Email and Password fields](images/02.png)

Creating an account also creates a **workspace**, the shared space your whole team will use. Teammates do not create their own workspaces. Instead, you invite them from Settings, and they join yours. If someone has already invited you, open the link in the invitation email instead of creating an account from scratch.

### First-time setup

The first time you sign in to a new workspace, the portal walks you through three steps. Until all three are done, Triage does not look at any pull requests.

![The setup screen listing three steps: Connect GitHub, Repositories and Decision model](images/03.png)

1. **Connect GitHub.** Triage talks to GitHub through a GitHub App. Press **Create GitHub App** and GitHub opens with a prefilled form for you to confirm. GitHub then sends you back to the portal. The App's private key is stored on the Triage server and is never shown in the browser. If your organization already has a GitHub App for Triage, expand **Connect an existing GitHub App instead** and enter its App ID, its slug, its private key file and its webhook secret. The portal shows the webhook URL you must paste into the App's settings on GitHub.

   ![The form for connecting an existing GitHub App, with fields for App ID, App slug, Private key, Webhook secret and the Webhook URL to copy](images/04.png)
2. **Repositories.** Press **Choose repositories on GitHub** and pick which repositories the App may see. GitHub tells Triage which ones you chose. They arrive with triage switched off, so nothing runs yet.
3. **Decision model.** Pick an AI provider from the list, paste the key your provider gave you, and press **Save decision model**. The key is stored in the server's vault and you will not see it again. If your organization runs its own compatible model service, choose **Add my own provider** and enter its address, model name and key.

![The setup screen after the first two steps are done, showing one repository selected and the decision-model choices](images/05.png)

You can also invite teammates from this screen by expanding **Invite people**, or do it later from Settings.

### After setup

Once all three steps are done, the portal takes you to the Inbox. Nothing appears there yet, because triage is still off for every repository. The next section shows how to turn it on, and the one after it shows what you will see.

## Setting up a repository: rules, verdicts and actions

Every repository has its own page under **Repositories** in the menu under your name. That page is where you decide what Triage checks, how it reaches a verdict, and what it does afterward. There is no Save button: every change is saved as you make it. The word beside the repository's name says where things stand: **Saving…** while a change is on its way, **Saved** once it is stored, and **Not saved** if something is unfinished or the save failed.

![The repository page for acme/widgets: Saved beside the name, the triage switch, the Policy card, and the Size and Checks rule cards, each rule with its own switch](images/06.png)

### Turning triage on

The switch labeled **Triage pull requests in this repository** is the master control. While it is off, Triage ignores the repository entirely and the rest of the page is grayed out. Switch on at least one rule first; the page tells you if you have not. When you turn triage on, Triage immediately checks every open pull request, and from then on it reacts to each new pull request event as it happens. The link **Triage open pull requests again** re-checks everything that is currently open, which is useful after you change the rules.

### Policy

The **Policy** card says where the repository's rules and actions are kept. At first they are kept in Corbits Triage. Press **Export to repository** to open a pull request that adds them to the repository as a file called `.corbits-triage.yaml`. Once that file is on the default branch, it is the policy: changes to it are reviewed like any other code, and the rules and actions on this page become read-only.

![The Policy card for a repository whose .corbits-triage.yaml was changed on GitHub: Not in sync, with Use file and Edit on GitHub buttons. The rules below are grayed out because the file decides them](images/07.png)

- **Edit on GitHub** opens the file on GitHub.
- When someone changes the file, the card says **Not in sync** until Triage reads it again. Press **Use file** to read it now.
- If the file has a mistake, the card says why and Triage keeps using the last policy it could read.

A file can also start from a workspace-wide policy with `extends`, and then set only what differs for this repository. This is useful when many repositories should follow the same rules.

### Rules

A rule asks one question about a pull request and answers pass, fail or unconfirmed. The rules are grouped into three cards, and each rule has a switch. The heading shows how many are on. Hover over the small **i** beside a rule for a one-line explanation of how it is checked.

- **Size**: **Flag pull requests over N files changed** and **over N lines changed**. Big changes are hard to review. You choose the limits.
- **Checks**, facts GitHub already knows:
  - **Require a linked issue** from GitHub, Linear or either. The pull request's title, description, commits or branch must mention an issue.
  - **No merge conflicts with the base branch.**
  - **CI must pass.** The repository's automated checks must be green. While they are still running, the rule is unconfirmed rather than passed.
  - **Never accept changes to** certain paths, such as vendored code. Add as many paths as you like.
- **Judgement**, questions the decision model answers from the diff and the documentation. These are optional, and each carries a **decision model** tag:
  - **The change is focused on one thing.**
  - **Docs are updated when behavior changes.**

Two rules always run and have no switch: a draft pull request waits until it is ready for review, and a pull request with changes requested fails.

Below the Judgement rules you can add up to eight rules of your own. Each one is a question for the decision model:

- **+ Is it true that …** asks a yes-or-no question, such as "Is it true that the title says what changed?" The rule fails when the answer is no.
- **+ Score …** asks the decision model to place the pull request on a scale of levels you name, worst first, such as poor, fair, good and great. Choose the level it **fails** below, or **never** to record the score without failing anyone.

![The Judgement card: the two built-in decision-model rules, then an Is it true that rule and a Score rule with the levels poor, fair, good and great and fails below fair](images/08.png)

Rules in the Size and Checks cards only use facts GitHub already knows, so they cost nothing and always give the same answer for the same pull request. Judgement rules cost one model request per pull request.

### How the verdict is decided

The **Then** section starts with one line that sums up the decision.

![The Then section: the line A failed rule decides Fail; otherwise the model decides, and Unsure below 70% sure, then the steps for Pass, Fail and Unsure, each marked Waits for you](images/09.png)

1. If any rule fails, the verdict is **Fail** right away. That includes a Judgement rule the decision model answered no to.
2. If the repository has no Judgement rules, there is nothing left to judge: the verdict is **Pass** when every rule passes, and **Unsure** when a rule could not be confirmed, such as CI that is still running.
3. Otherwise the decision model reads the whole pull request together with every rule's result and answers one question: does this pull request pass this repository's policy? If it is at least 70% sure the answer is yes, the verdict is **Pass**. If it is at least 70% sure the answer is no, the verdict is **Fail**. Anything in between is **Unsure**, which means a person should look. A pull request with a Judgement rule the model could not confirm is never more than Unsure.

Draft and closed pull requests are not decided at all.

### Actions

Below the summary line are three lists of steps, one per verdict: **Pass**, **Fail** and **Unsure**. Press **+ Add a step** to add one. Each step names an action and who it is for.

| Action | What it does |
| --- | --- |
| Approve | Approves the pull request on GitHub. |
| Merge | Merges the pull request. Only on Pass. |
| Close | Closes the pull request. |
| Comment | Posts a comment you write. |
| Request changes | Sends the author a review listing the rules to fix. |
| Request review from… | Asks the code owners, named people or teams to review. |
| Assign to… | Assigns the pull request to the author, the code owners, named people or teams. |
| Add label… | Adds the labels you list. |

The **for** choice limits a step to some authors: **anyone**, **first-timers**, **maintainers**, **external contributors**, **bots**, **a GitHub team…** or **specific people…**. For example, a Fail step can post a friendly comment for first-timers only. By default, Unsure asks the code owners for a review.

Each step shows whether it **Waits for you** or runs on its own. If something is incomplete, such as a comment with no text, the step says **Not saved yet** in red and the rest of your changes are still saved.

Triage only carries out an action on its own when the workspace allows that action in that repository under [Settings → Access](#access). Everything else waits in the Inbox for a person to click. A brand-new workspace automates nothing, so you can watch what Triage suggests before you let it act. Two actions are always held for a person: Close on Unsure, and Merge on anything but Pass.

While a pull request's CI is still running, Triage holds every action, and its comment on GitHub lists them under **Waiting for checks to finish**. They go ahead once the checks are done.

### Labels

The **Labels** card sets the labels Triage keeps on every pull request so that other tools, such as a coding agent, can react to them.

![The Labels card: the verdict labels Triage: Ready, Triage: Not Ready and Triage: Needs Human Review, marked always, and the switch Also label each failed rule with rule: <id>](images/10.png)

- **Label each pull request with its verdict** is always on. Triage puts the verdict's label on the pull request and takes the other two off. The defaults are **Triage: Ready** for Pass, **Triage: Not Ready** for Fail and **Triage: Needs Human Review** for Unsure. You can rename them.
- **Also label each failed rule** adds a label such as `rule: linked-issue` for every rule that failed.

## Day to day: the Inbox

Once triage is on, the **Inbox** is where you will spend most of your time. It lists open pull requests, shows each one's verdict and reasons, and offers the next step as a button. Nothing happens on GitHub until you press one of those buttons, unless you have told Triage otherwise in Settings.

### Finding your way around

The dark strip on the left is the same on every page:

- **Workspace name** at the top. If you belong to more than one workspace, click it to switch.
- **Pulse**: a summary of what changed since your last visit.
- **Inbox**, with two views. **Needs you** shows only pull requests waiting on a person. **All open** shows every open pull request in every repository with triage on.
- **Saved views**: ready-made filters. **First-timers** shows pull requests from people who have never contributed to the repository before.
- **Your name** at the bottom. Click it for Repositories, Settings and Sign out.

Each view has a search box, a **Filter** button and quick filters such as Action, Repo, Waits on and Owner. The three counters in the corner show how many pull requests are new since your last visit, how many were resolved, and how many are stuck.

### Needs you

![The Needs you view: pull requests grouped under Unblock and Merge, each with a Member chip, its title, the reason, its age and a button for the next step. The right pane shows pull request 4, Blocked with two things to fix and one to check](images/11.png)

Pull requests are grouped by what you need to do: **Unblock** for ones that are stuck on something, **Merge** for ones that passed, and so on. Each row shows a chip describing the author (Member, First-timer, Bot), the title, Triage's one-line reason, how long ago it was triaged, and a button for the most likely next step. Click anywhere on a row to open it in the reading pane on the right.

### All open

The **All open** view groups pull requests by repository and adds two chips to every row:

| Chip | Meaning |
| --- | --- |
| PASS, FAIL or UNSURE | The verdict. Green means pass, red means fail, and gray means Triage could not tell. |
| WAITS ON YOU, WAITS ON AUTHOR, WAITS ON NOBODY | Whose move it is. |

A pull request that has not been checked yet shows **Not triaged yet** and **Not evaluated** until its first run finishes, usually within a minute of being opened.

### The reading pane

Clicking a pull request opens it on the right. The pane is built to be read top to bottom.

![The reading pane for a failing pull request: the status line Blocked with 2 things to fix and 1 to check, then each problem (required checks are failing, no linked issue, a rule that was not asked), the description, folded rows for linked issue, files and rules passed, and a bottom bar with Request changes, Close, Approve and More](images/12.png)

1. **The header**: repository and number, the title, the author with their chip, when it was opened, and how many lines were added and removed. The **GitHub** link in the corner opens the same pull request on GitHub.
2. **The status line** in one sentence, such as **Ready to merge**, **Waiting for review**, or **Blocked · 2 things to fix, 1 to check**.
3. **The problems**, if any. Each failed rule is listed under **To fix** with the evidence, such as the name of the failing check. A rule Triage could not evaluate is listed under **Couldn't check**. A pull request with no problems skips straight to the description.
4. **The description** the author wrote.
5. **Folded rows** you can expand: the linked issue, the changed files (with the diff), and the rules that passed. Evidence for a file cites its changed lines and links them at the exact commit Triage judged.
6. **Commits and conversation** opens the full history and comments.

![The reading pane for a passing pull request: the status line Ready to merge, the description, folded rows, and a bottom bar whose first button is Merge into main](images/13.png)

![The rules passed row expanded, listing each rule with its result: not a draft, CI passing, 0 change requests, no conflicts, 0 files against a limit of 30, 0 lines against a limit of 3,000, no forbidden paths, issue linked, focused does not apply, documentation is up to date](images/14.png)

Expanding **rules passed** shows every rule with a short note on why it passed, such as the number of files changed against the limit. This is the quickest way to see what Triage actually checked.

### Taking action

The bar at the bottom of the pane always offers the next step first. For a passing pull request that is **Merge**, for a failing one it is **Request changes**, and for an unsure one it is usually **Comment** or **Approve**. The other actions are beside it, and anything else, including the actions the repository's policy suggested, is under **More**.

![The More menu open at the bottom of the reading pane, listing Edit feedback, Post reply, Approve, Comment and Triage again](images/15.png)

- **Merge** merges the exact commit Triage checked. If the author pushes a new commit in the meantime, the merge is refused and Triage checks the new commit first.
- **Request changes** sends the author a review listing the rules they need to fix. When they fix them, Triage withdraws the request on its own.
- **Approve** approves the pull request on GitHub. Triage never withdraws an approval you made yourself.
- **Comment** posts a comment, and **Reply** answers the author. Edit feedback lets you reword the comment Triage will post before it goes out.
- **Close** closes the pull request.
- **Triage again** re-runs the checks on the current commit.

Anything you do here is also written to the audit log.

### What the author sees

Authors do not use the portal. Depending on the repository's actions, they see a comment from Triage on their pull request with the verdict and reasons, labels such as **Triage: Ready**, **Triage: Not Ready** or **Triage: Needs Human Review**, review requests, and assignments. Triage keeps one comment and edits it in place as the pull request changes, so an author who pushes a fix sees the fresh verdict in the same comment. Only when someone changes the repository's policy and that changes the verdict on the same commit does Triage post a new comment, which says it supersedes the one above.

### Pulse

**Pulse** is the page to open when you come back after a break. It shows what is new, resolved, waiting on you and acted on by you since your last visit, which pull requests have been stuck for more than three days, and a small table per repository: how many pull requests were triaged this week, how many needed a person, how many were acted on, and the typical time to a verdict.

![The Pulse page: four counters for new, resolved, now waiting on you and acted on by you since the last visit, a Stuck section, and a table per repository with triaged, needed you, acted on and median time to verdict](images/16.png)

## Settings: people, access and workspace configuration

**Settings** is reached from the menu under your name at the bottom of the left rail. It is one page with five sections: Triage, GitHub, Decision model, Access and Your account. The links at the top jump to each section. Most teams visit it once during setup and then only to invite people or change what Triage may do on its own.

### Triage

![The top of Settings: Workspace settings with the workspace name, people and repository counts, links to each section, and the Triage section saying Triage is running on 1 of 1 repository, followed by the versions it runs and a Copy button](images/22.png)

Says how many repositories Triage is running on, with a **Choose repositories** link, and shows the version of each Triage component currently running for your workspace. You do not need to change anything here. Press **Copy** when you report a problem, because support will ask which versions you are on.

### GitHub

![The GitHub section: the connected App and its repository, the stored webhook and App secrets with Replace secret and Remove, and the Webhook URL to copy](images/17.png)

This section shows whether the GitHub App is connected and which repositories it is installed on. Press **Choose repositories on GitHub** to add or remove repositories. GitHub's own installer opens, and when you come back, any new repository appears under Repositories with triage switched off. **Open Repositories** goes straight to that page.

Below that are the secrets the App needs: the webhook secret and the App's private key. Each has a **Replace secret** button for rotating it and a **Remove** link. Removing the GitHub App secret disconnects Triage from GitHub, so do that only when you mean to. The **Webhook URL** is what GitHub uses to tell Triage about pull request events. You only need it if you set up the App by hand.

### Decision model

![The Decision model section: Using OpenCode Zen (Jev) with model jev-1.13, the stored inference secret with a Remove link, the choice of providers and an API key field](images/18.png)

This is where the AI decision model lives. The first line says which provider and model are in use. To change it, pick one of the listed providers and paste its API key, or choose **Add my own provider** and enter the address of a compatible service. Keys are kept in the server's vault, so after saving the field goes blank and the key shows as **stored**. To change the key, paste a new one and save again. Every save redeploys Triage's workers, so give it a minute before expecting new verdicts.

### Access

The Access section has three parts: People, who may approve a held action, and what Triage does on its own.

![The People list with the owner and an Email field and Role dropdown for inviting someone, then the grid Who may approve a held action with a row per action and a switch per role](images/19.png)

**People** lists everyone in the workspace with their role. To add a teammate, type their email, choose a role and press **Invite**. They receive a sign-in link that works once and expires after 15 minutes. If your server is not set up to send email, the portal shows you the link to copy and send yourself.

There are three roles:

| Role | What they can do |
| --- | --- |
| Owner | Everything, including workspace settings and inviting people. The person who created the workspace is its owner. |
| Admin | Manage repositories, rules and people. |
| Member | Use the Inbox and carry out the actions their role is allowed below. |

**Who may approve a held action** is a grid with one row per action and one column per role. An owner may always approve. A switch that is on means that role may approve that action when it is waiting in the Inbox.

![What Triage does on its own: a row per action, with Add labels allowed on its own in acme/widgets and every other action waiting for approval](images/23.png)

**What Triage does on its own** is the important one. Each action has a list of repositories where Triage carries it out on GitHub by itself during triage, without waiting for anyone. Pick a repository from **Add repository…**, or **All repositories**, to allow it; press × to take it away. An action with no repositories listed waits for approval everywhere. In a new workspace every list is empty. Allow actions one at a time as you gain confidence, starting with low-risk ones such as adding labels. The repository page then marks those steps as running on their own instead of **Waits for you**.

### Your account

![Your account: signed in as maintainer@example.com with a Sign out button, and the list of signed-in browsers](images/20.png)

Shows the email address you are signed in with, a **Sign out** button and the browsers you are signed in on. Only you see this section.

## The audit log

The audit log is a record of everything that happened in your workspace: who approved what, which actions Triage carried out, which permissions were granted, and when. Open it by adding **/audit** to the end of the portal address, for example `https://triage.example.com/audit`.

![The Audit page: a search box, a repository filter, an Export button and a table with Time, Actor, Action, Target and Detail columns](images/21.png)

The page shows the latest 100 events, newest first. Each row has:

- **Time** the event happened.
- **Actor**: the person or system component that did it. Events the server did on its own show as unknown.
- **Action**: what was done, such as Granted, Approved or Merged.
- **Target**: what it was done to, such as a pull request or an internal account.
- **Detail**: a short description.

Type in the search box to narrow the list by actor, action or pull request. The dropdown limits the list to one repository. **Export** downloads what you are looking at as a file you can keep or send to someone. Many of the earliest entries are permission grants made automatically when Triage set itself up, which is normal.

## Glossary and common questions

### Words you will see

| Word | What it means here |
| --- | --- |
| Pull request | A proposed change to a repository on GitHub, waiting to be reviewed and merged. |
| Repository | One project's code on GitHub, such as acme/widgets. |
| Workspace | Your team's shared space in Triage. One workspace can watch many repositories. |
| Portal | The Triage website. |
| Hub | The Triage server behind the portal. You never use it directly. |
| GitHub App | The connection between Triage and GitHub. Installing it on a repository lets Triage read pull requests and, if you allow it, write labels, comments and reviews. |
| Rule | One question Triage asks about a pull request, answered pass, fail or unconfirmed. |
| Decision model | The AI service that answers questions needing judgment, and that gives the final verdict when the policy has Judgement rules. |
| Verdict | Triage's overall answer for one commit of a pull request: Pass, Fail or Unsure. |
| Score | How sure the decision model is that the pull request passes, from 0 to 1. A score of 0.9 means 90 percent sure. |
| Action | One step in a repository's policy, such as adding a label or requesting a review. |
| Held action | An action that is waiting for a person to approve it in the Inbox. |
| Policy | A repository's rules, verdict steps and labels. Kept in Triage or in the repository's `.corbits-triage.yaml` file. |
| Role | A workspace role (Owner, Admin, Member) that controls what a person may do in Triage. |
| CI | Continuous integration: the automated tests and checks a repository runs on every pull request. |
| Draft | A pull request its author has marked as not ready. Triage waits until it is marked ready. |
| First-timer | Someone opening their first pull request in a repository. |
| Webhook | The channel GitHub uses to tell Triage about new events. |
| Audit log | The record of everything that happened in your workspace. |

### Common questions

**Triage says Unsure. What should I do?** Read the pull request yourself. Unsure means the rules did not catch a problem but the decision model was not confident either way. Approve, request changes or comment as you would normally. If a rule could not run because GitHub had not finished computing something, such as CI, Triage will check again on its own.

**A pull request shows "Not triaged yet" for a long time.** Check that triage is on for its repository, that the GitHub App is still connected under Settings → GitHub, and that a decision model is saved under Settings → Decision model. If all three look right, open the repository and press **Triage open pull requests again**.

**Does Triage ever merge, close or approve on its own?** Only if you allow it. Each action has a list of repositories under **What Triage does on its own** in Settings → Access, and every list starts empty. Close is never run automatically on an Unsure verdict, and Merge never on anything but Pass, even when they are allowed.

**Why did Triage not call the decision model for a failing pull request?** When a rule fails, the answer is already Fail, so the model is not asked the verdict question. A repository with no Judgement rules never asks it at all. This saves money and keeps verdicts predictable.

**The author pushed a fix. Do I need to do anything?** No. Every new commit gets its own verdict, and Triage updates its comment. If you had requested changes through Triage and every failed rule is now fixed, Triage withdraws the request for you.

**Can I try new rules without affecting anyone?** Changes on the repository page take effect as soon as they are saved, and actions that Triage does not run on its own still wait for a person. To have rule changes reviewed first, keep the policy in the repository's `.corbits-triage.yaml` and change it through a pull request.

**Where do I change my password?** Sign out, then use **Forgot password?** on the sign-in screen. A reset link is sent to your email.

**How do I remove someone from the workspace?** An Owner or Admin can change or remove a person's role under Settings → Access.

**Something looks wrong. What should I tell support?** The repository name and pull request number, what you expected, what you saw, and the versions listed under Settings → Triage (use its **Copy** button). The audit log's **Export** button gives support a record of what happened.
