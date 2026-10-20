# @corbits/extension

A browser extension (WXT, Manifest V3, Chrome and Firefox) that checks the GitHub pull request you are viewing against
its repository's policy and shows the result on the pull request page. It reads GitHub with your own token, runs
pr-triage's rules in the browser with the same shared code the hub runs, and writes nothing.

## Use

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

### What it checks

The policy comes from, in order:

1. `.corbits-triage.yml`, else `.corbits-triage.yaml`, on the repository's default branch, read through GitHub's
   contents API. A pull request's own head is never read for it, so a pull request cannot change the rules it is
   checked by. The file is kept for 10 minutes, then revalidated by ETag; files over 64 KB are refused.
2. Rules saved in this browser for the repository, edited in the side panel.
3. The recommended rules.

The block at the top of GitHub's sidebar says which one applied, then lists each rule as Pass, Fail or Waiting with its
evidence. Decision-model rules show as "Not evaluated here" unless a decision model is set in the side panel. The
verdict is named only when the rules decide it without the decision model; then the block also shows the labels,
comment and other steps the policy would post (the hub's, when the policy is the file). A chip beside the title
repeats the verdict, and the Files tab marks the files and lines a failing rule cites.

When the Corbits Triage App has sent a code review to the pull request, the block links to the newest one, names the
account that wrote it, and lists each of its inline comments by title, file and line, linked to the comment; a
comment whose line has since changed is marked outdated, and a review of an earlier commit says so. A review counts
only when it carries code review's marker and was written by a GitHub App's bot account; the App's own login is not
readable with your token, so another App installed on the repository could write one, which the account name shows.
A review that cannot be read is said so without failing the rules.

### Limits

- Every read needs a GitHub token. A fine-grained token with read-only access to public repositories is enough;
  private repositories need read access to their contents and pull requests.
- Author team membership is not read, so a step meant for a team is skipped.
- The token is kept in the extension's `storage.local`, which every part of the extension can read, the content
  script on github.com included. Only the background reads it, and changing or removing it clears every saved check
  and policy file.
- A policy file that extends a shared policy is not checked; only the hub holds the shared policy.

## Test

`bun run check` at the repository root typechecks the extension and `e2e/`. The end-to-end check drives the Chrome
build in Playwright's Chromium on a real pull request; build first, then, here, pipe the token in so it never sits on the
command line:

```sh
printenv GITHUB_TOKEN | bun --conditions=intx-src e2e/verify.ts <owner/repo> <number>
```

It saves a screenshot of the sidebar block to `.output/e2e/settings-extension-pr.png`.

## Docs

- [User Manual](../../docs/Corbits%20Triage%20User%20Manual/Corbits%20Triage%20User%20Manual.md)
- [PRODUCT.md](../../docs/PRODUCT.md)
