# @corbits/extension

A browser extension (WXT, Manifest V3, Chrome and Firefox) that checks the GitHub pull request you are viewing against
its repository's `.corbits-triage.yml` and shows the result on the pull request page. It reads GitHub with your own
token and runs pr-triage's own definition in the browser with Interchange's local runner, granted no action, so it
writes nothing. Model checks are not run: the run stops at the first agent step.

## Install

From a packaged zip (`bun run zip` writes them to `.output/`):

- Chrome: unzip `corbits-triage-<version>-chrome.zip`, open `chrome://extensions`, turn on Developer mode, choose
  Load unpacked and pick the unzipped folder.
- Firefox 128 or later: open `about:debugging#/runtime/this-firefox`, choose Load Temporary Add-on and pick
  `corbits-triage-<version>-firefox.zip`. A temporary add-on lasts until Firefox restarts.

From source, after `bun install` at the repository root (it runs `wxt prepare`), here:

```sh
bun run build           # Chrome: .output/chrome-mv3
bun run build:firefox   # Firefox: .output/firefox-mv3
bun run dev             # Chrome with hot reload; dev:firefox for Firefox
```

Load `.output/chrome-mv3` in Chrome, or `.output/firefox-mv3/manifest.json` as a temporary add-on in Firefox. Click
the toolbar button to open the side panel (the sidebar in Firefox), save a GitHub token, and open any
`https://github.com/<owner>/<repo>/pull/<number>` page.

## What it shows

The policy is `.corbits-triage.yml`, else `.corbits-triage.yaml`, on the repository's default branch. A pull
request's own head is never read for it, so a pull request cannot change the rules it is checked by. The file is kept
for 10 minutes, then revalidated by ETag; files over 64 KB are refused.

The block at the top of GitHub's sidebar links the policy file, shows a score (how many of the checks run here
passed), then lists each check as Pass, Fail or Waiting with its evidence. Checks that need the decision model are
listed as Not run here and do not count toward the score. A chip beside the title repeats the score, and the Files tab
marks the files and lines a failing check cites.

When the repository has no policy file, the block says so and links to how to write one. When the pull request carries
the policy's `pauseLabel`, the block says it is paused and checks nothing, as the hub would not triage it.

When the Corbits Triage App has sent a code review to the pull request, the block links to the newest one and lists
its inline comments by title, file and line. A review counts only when it carries code review's marker and was written
by a GitHub App's bot account, which the account name shows.

### Limits

- Every read needs a GitHub token. A fine-grained token with read-only access to public repositories is enough;
  private repositories need read access to their contents and pull requests.
- The token is kept in the extension's `storage.local`. Only the background reads it, and changing or removing it
  clears every saved check and policy file.
- A policy file that extends a shared policy is not checked; only the hub holds the shared policy.

## Test

`bun run check` at the repository root typechecks the extension and `e2e/`; the background is checked on its own
(`tsconfig.background.json`), without the DOM lib, as Interchange's sources type-check only against Bun's fetch types.
`src/run-checks.test.ts` runs the definition on a fixture pull request offline. The end-to-end check drives the Chrome
build in Playwright's Chromium on a real pull request; build first, then, here, pipe the token in so it never sits on
the command line:

```sh
printenv GITHUB_TOKEN | bun --conditions=intx-src e2e/verify.ts <owner/repo> <number>
```

It saves a screenshot of the sidebar block to `.output/e2e/settings-extension-pr.png`.

## Docs

- [User Manual](../../docs/Corbits%20Triage%20User%20Manual/Corbits%20Triage%20User%20Manual.md#browser-extension)
- [PRODUCT.md](../../docs/PRODUCT.md)
