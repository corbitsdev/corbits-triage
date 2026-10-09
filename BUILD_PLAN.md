# BUILD_PLAN.md — CL-10254: Make the suggested reply subtle (Post as-is or Edit the suggestion)

Plans-only artifact. Coder executes this; it authorizes changes to `apps/web` only.

Web app: `apps/web`. Primary surface: the pull request review pane (Inbox). Related Linear siblings: CL-10237 (drafted reply can post from any pile).

---

## 1. Goal and acceptance criteria

Mirrors the issue's outcome checkboxes:

- [ ] The suggested reply shows as a suggestion with two actions: **Post the suggestion** and **Edit the suggestion**.
- [ ] **Edit the suggestion** opens the reply inline (the existing composer machinery).
- [ ] **Post the suggestion** sends the reply to GitHub (reuse the existing `writeGithub` path).
- [ ] The **More** menu no longer sits in the bottom-right of the pane.

Success criteria (done-definition, from the dispatch brief):

1. `BUILD_PLAN.md` exists in the worktree.
2. Plan covers: Post the suggestion, Edit the suggestion, inline editing, Post-to-GitHub, More menu placement, empty-draft case.
3. Plan is compatible with the CL-10237 pane changes (both share `apps/web/src/pages/Inbox.tsx`, `apps/web/src/lib/inbox-pane.ts`, `apps/web/src/inbox.css`).
4. Single docs commit on branch `cl-10254`.
5. No `apps/web` code committed by this planning task.

---

## 2. Current behavior (with file:line references)

All line references are against `apps/web/src` at `main` ee8d009.

- **The suggestion renders as an always-open textarea composer.**
  `SuggestedReply` (`pages/Inbox.tsx:148-171`) renders a textarea bound to `draft.text` plus an "Edited" tag (`Inbox.tsx:161`) and keystroke hints `<kbd>e</kbd> edit · <kbd>⌘</kbd><kbd>⏎</kbd> send` (`Inbox.tsx:163`). It is mounted whenever a reply was drafted (`draft !== null`, `Inbox.tsx:331`).
- **The reply is edited in place whenever the user types.**
  `onChange={setReply}` (`Inbox.tsx:166`) mutates `reply` on every keystroke; `draft.edited` is derived as `text !== item.comment` (`inbox-pane.ts:114`).
- **The reply posts through the primary action / `runPaneAction`.**
  The primary reply action calls `runPaneAction("reply", …)` (`Inbox.tsx:341`, `Inbox.tsx:234-250`), which writes `{ action: "reply", … }` and then `{ action: "labels", … }` (`inbox-pane.ts:161-167`). Draft gating: `runPaneAction` throws when `draft.text` is empty (`inbox-pane.ts:163`).
- **The More menu is anchored bottom-right in the action bar.**
  The primary button + More button live in `.bar` (`Inbox.tsx:339-356`); `.bar` is `position:absolute; left:0; right:0; bottom:0` and `.bar .menu.up { right: 0 }` (`inbox.css:178-181`). The menu opens upward from the bottom-right corner.
- **The empty-draft case already renders nothing.**
  `replyDraft` returns null when `item.comment === null` (`inbox-pane.ts:112-115`).

---

## 3. Proposed minimal change

### 3.1 Suggestion view (collapsed, subtle)

Replace the always-open textarea in `SuggestedReply` with a *suggestion card* that shows the drafted text as read-only content and two actions:

- **Post the suggestion** → posts via the existing reply path.
- **Edit the suggestion** → opens the inline reply editor.

Concretely, split `SuggestedReply` into two states in `pages/Inbox.tsx`:

- A collapsed **suggestion** block that renders `draft.text` as text (short, single-paragraph preview, `white-space: pre-wrap`) with a `Post the suggestion` `<button>` and an `Edit the suggestion` `<button>`. No textarea, no live `onChange`, no `Edited` build-up while collapsed.
- An **editing** block that reuses the existing textarea/composer: mount the `textarea` bound to `setReply` only while editing (a new local `editing` boolean in `Pane`, `pages/Inbox.tsx:203`), styled with the existing `.compose` class and the same `onReplyKey` (⌘⏎ sends). When the user opens edit, focus `replyRef.current` and mirror the existing `e` shortcut behavior (`Inbox.tsx:292-295`).

Behavior rules:

- The `Edited` tag shows **only while the editor is open and the text differs from the verdict** (`text !== item.comment`, via `replyDraft.edited`), not in the collapsed card.
- The keystroke hint `<kbd>⌘</kbd><kbd>⏎</kbd> send` stays only inside the open editor; the "e edit" global hint is dropped from the suggestion header so the pane reads as a suggestion, not a composer.

### 3.2 Post the suggestion → GitHub

Reuse `runPaneAction("reply", item, draft, …)` exactly as today (`inbox-pane.ts:153-167`): it writes `{ action: "reply", repo, number, body: draft.text }` then applies `labels` when present. The collapsed **Post the suggestion** button calls `run("reply")` via the primary-action path (`Inbox.tsx:341`). No new GitHub write code. Gate stays on `canRun(kind, gate)` (`inbox-pane.ts:149-151`) so read-only / running / no-number / busy states disable it, and `runPaneAction`'s empty-reply throw already guards the empty case (`inbox-pane.ts:163`).

### 3.3 Inline editing

While editing, `composer` machinery is **not** used for the reply (the reply keeps its existing textarea + `setReply` model; the `composer` state is only for `comment`/`changes`). Editing toggles `editing` on in `Pane` and mounts the existing textarea. Posting from the editor is the same primary reply action. Closing edit without posting is a `Cancel` affordance that unmounts the textarea and returns to the collapsed suggestion (text stays in `reply` state; if it differs from the verdict it remains as an unposted edit — covered in 4).

### 3.4 More menu placement

The third acceptance item ("More menu no longer sits in the bottom-right") is satisfied structurally by moving the reply actions out of the primary-bar flow and by not introducing a bottom-right-anchored menu for the reply. The pane's `.bar` keeps the primary action button and its More menu **as they exist for the non-reply actions** (Composer paths, Approve/Changes/Merge/Close/Triage). We do **not** relocate or reparent the `.bar` menu in this issue — CL-10237 owns the bar's menu participation. What CL-10254 guarantees: the reply is no longer an always-open bottom-of-pane composer, so there is no bottom-right composer "More" affordance tied to the suggestion. Keep `.bar .menu.up { right: 0 }` unchanged unless CL-10237 changes it.

### 3.5 Empty draft (no suggestion)

No change: `replyDraft` already returns null (`inbox-pane.ts:112`), so `SuggestedReply` is not mounted (`Inbox.tsx:331`). The collapsed suggestion and the Post/Edit actions must not render when `draft === null`. If the pane is in `editing` state and the draft becomes null (new verdict replaces it, `Inbox.tsx:220-223`), reset `editing` to false so no orphaned editor shows.

### 3.6 State changes in Pane

- Add `const [editing, setEditing] = useState(false)` in `Pane` (`pages/Inbox.tsx:203` area).
- `SuggestedReply` gains an `editing: boolean`, `onPost: () => void`, `onEdit: () => void`, `onCancel: () => void` set of props (in addition to the existing `draft`, `replyRef`, `onChange`, `onKeyDown`).

---

## 4. Compatibility with CL-10237

CL-10237 ("drafted reply can post from any pile") changes the same pane so a drafted reply can be posted when:
- the pile has **no** primary action (primary becomes a reply-post when a draft exists),
- via ⌘⏎ anywhere,
- and from the **More** menu.

To stay compatible, CL-10254 will:

- Keep the reply **state model** (`reply` string in `Pane`, `replyDraft`, `draftText`, `runPaneAction("reply")`) untouched so CL-10237's primary/⌘⏎/menu reply-entry points keep working against the same draft.
- Not change `paneActions`/`primaryAction` contract (`inbox-pane.ts:75-102`, `inbox-view.ts:75-88`) — the `reply` `PaneKind` already exists; CL-10254 only changes *where the user clicks* to begin editing, not the action plumbing.
- Keep the textarea bound to `setReply` and the `⌘⏎` handler (`onReplyKey`, `Inbox.tsx:281-283`) so posting "from any pile" (CL-10237) and posting from the edited recommendation (CL-10254) share one path.
- Recommend CL-10254 land **after** CL-10237 or be rebased on it; both touch `SuggestedReply` and `Pane` state. The `editing` boolean must coexist with whatever primary-action state CL-10237 adds (CL-10237 likely only reads `draft`, it need not own `editing`).

Concrete merge note for Coder: treat `SuggestedReply` and the `Pane` `setReply`/`editing` wiring as the shared seam; keep changes additive (new `editing` state + props) and do not reorder/remove CL-10237's primary/menu reply branches.

---

## 5. Edge cases

- **No permission to write (read-only / mobile / no number / running / busy).**
  `canRun("reply", gate)` returns the blocker (`inbox-pane.ts:48-57`, `149-151`). The suggestion card must disable **Post the suggestion** (and ideally **Edit the suggestion**) when `canRun("reply", …)` is false, showing the blocker reason — matching how the primary button disables today (`Inbox.tsx:341`). Reuse the same gate; do not add a second gate.
- **Running PRs.**
  The pane is on a running (`item.running`) PR; the verdict is stale (`inboxStatus` returns "Running", `inbox-view.ts:27-29`). Post/Edit should be disabled while running, consistent with the existing `running` blocker.
- **No draft (empty suggestion).**
  `draft === null` → render nothing (already the case, `inbox-pane.ts:112-115`). Reset `editing` when the draft disappears.
- **Edited drafts (text diverged from verdict).**
  While editing, show the `Edited` tag so the user knows their text no longer matches the verdict. Posting posts `draft.text` (the edited form) exactly as today; the verdict-suggested wording is only the collapsed preview.
- **Cancelling an edit with unsaved changes.**
  The drafted text persists in the `reply` state; `draft.edited` stays true. Recommend the suggestion card surface some "unposted edit" affordance (e.g. an "Edited" indicator on the collapsed card, or leaving Post primary on the edited text) — see 3.1; keep it minimal, decisions finalized during coding with tests.
- **Labels applied on post.**
  `runPaneAction("reply")` applies `item.labels` after the reply (`inbox-pane.ts:165`); this is unchanged and must remain covered by tests.

---

## 6. Test plan

### Unit tests (load-bearing only, per AGENTS.md "Tests")

`apps/web/src/lib/inbox-pane.test.ts`:

- Extend `runPaneAction` coverage: posting the suggestion from the collapsed card still writes `{ action: "reply", … }` then `labels` (existing test at `inbox-pane.test.ts:136-141` stays green — no signature change).
- Add a case that a **read-only / running / no-number** pane reports `canRun("reply", …) === false` (reply is already a `PaneKind`; assert the collapsed Post/Edit are gated by the same blocker as the primary button).

`apps/web/src/lib/inbox-view.test.ts`:

- No change expected unless CL-10237 changed `primaryAction`; keep the existing draft→`reply` / no-draft→`comment` case green (`inbox-view.test.ts:75-81`).

No JSDOM/component tests exist in the repo for `Pane` (only `review-pane`-style view tests are absent; `inbox-pane.test.ts` and `inbox-view.test.ts` are pure-logic). Coder should add a small pure-logic helper if the collapse/edit toggle is extracted (e.g. `isEditing`/`canPostSuggestion` predicates) so it can be unit-tested without a DOM harness; otherwise keep the toggle in-component and rely on manual scenarios.

### Manual scenarios

1. PR with a drafted reply: the pane shows a **suggestion card** (text, no textarea, no "Edited" tag, no keystroke hints); **Post the suggestion** and **Edit the suggestion** render.
2. Click **Post the suggestion** → reply posts to GitHub (confirmed via GitHub activity / `titleText` "Posted to GitHub on #N", `inbox-pane.ts:166`), labels applied.
3. Click **Edit the suggestion** → textarea opens inline, focused, shows `Edited` once text diverges; `⌘⏎` posts; `Cancel` closes back to the collapsed card preserving edits.
4. PR with **no** suggested reply → no suggestion area at all (empty-draft case).
5. Read-only / running PR → Post and Edit disabled.
6. Verify the More menu anchor (`.bar .menu.up`, `right:0`) is unaffected for the non-reply actions, and no new bottom-right menu appears with the suggestion.

### Verification commands

- `bun run check` — typechecks `apps/web`.
- `bun run test` (or `bun test apps/web` for unit scope) — `inbox-pane.test.ts`, `inbox-view.test.ts` pass; no hub/Postgres needed for these files.

---

## 7. Out of scope (other issues' work)

- **Keystroke hints** (`e` edit · `⌘⏎` send) redesign is tracked elsewhere; CL-10254 only removes the hint from the collapsed suggestion header (it stays on the open editor for ⌘⏎). Not further reworked here.
- **Close-from-review-UI** workflow.
- **Inbox layout** rework (grid/two-pane layout, `.bar` restructure).
- **CL-10237** "drafted reply can post from any pile" — covered for compatibility (section 4) but not implemented here.
- Hub/workflow/sidecar changes, vendor changes.

---

## 8. Delivery

- Single commit on branch `cl-10254`, message: `docs(web): plan the subtle suggested reply`. One docs commit, `apps/web` untouched by the planning task.
- After merge, Coder executes this plan as the implementation task.