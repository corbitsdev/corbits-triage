# Corbits Triage extension

The extension runs standalone in the browser: it reads GitHub as the signed-in person and runs the triage logic
locally, with no hub. A hub-backed mode is planned.

A WXT browser extension (Chrome side panel, Firefox sidebar, MV3) that scores the GitHub pull request open in the
current tab, using the shared triage logic from `packages/triage-workflows` and a per-repository policy kept in browser
storage.

## Prerequisites

- Bun, and `bun install` at the repository root (it runs `wxt prepare`).
- Chrome, or Firefox 128 or later.

## Build and run

From `apps/extension`:

```sh
bun run build           # Chrome: .output/chrome-mv3
bun run build:firefox   # Firefox: .output/firefox-mv3
bun run dev             # Chrome with the extension loaded and hot reload
```

To load a build by hand in Chrome: open `chrome://extensions`, turn on Developer mode, choose Load unpacked and pick
`apps/extension/.output/chrome-mv3`. Open any `https://github.com/<owner>/<repo>/pull/<number>` page.

## Settings

All optional, in the side panel's settings:

- GitHub token: used only when a page read fails, for 5,000 API calls an hour instead of 60.
- Decision model: a provider preset and key; without one, model rules are left out of the score.

## Tests

End-to-end scripts in `e2e/` drive the Chrome build in Playwright's Chromium on real pull requests. Build first, then
from `apps/extension`:

```sh
bun e2e/navigation.ts [owner/repo]
bun --conditions=intx-src e2e/page-actions.ts <owner/repo> <number>
bun --conditions=intx-src e2e/post-comment.ts <owner/repo> <number> <github token>
bun --conditions=intx-src e2e/injection.ts <owner/repo> <number> <github token>
```

Each script's header says what pull request it needs. `bun run check` at the root typechecks the extension and `e2e/`.
