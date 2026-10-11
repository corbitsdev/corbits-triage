---
version: alpha
name: Corbits Triage
description: Night instrument. A graphite rail wrapping a light working pane, one heat signal for attention.
colors:
  primary: "#d44510"
  paper: "#e5e7ed"
  pane: "#f6f7f9"
  sheet: "#fdfdfe"
  inset: "#d4d7e0"
  ink: "#12141a"
  ink-soft: "#2e323c"
  ink-mute: "#575d68"
  rule: "#c3c7d1"
  rule-strong: "#959ba8"
  heat: "#d44510"
  heat-hover: "#b83a0c"
  heat-press: "#9c300a"
  heat-ink: "#1c0b06"
  heat-wash: "#ead0c4"
  rail: "#0a0c11"
  rail-text: "#e8eaf0"
  rail-mute: "#8b909c"
  rail-line: "#16181e"
  rail-current: "#2a1511"
  ok: "#1d6b42"
  bad: "#b1352c"
  ring: "#b83a0c"
  night-field: "#141821"
  night-line: "#2a2f3a"
  night-bad: "#f07a6a"
typography:
  page-title:
    fontFamily: Red Hat Display
    fontSize: 2rem
    fontWeight: 650
    lineHeight: 1.1
    letterSpacing: -0.045em
  section-title:
    fontFamily: Red Hat Display
    fontSize: 18px
    fontWeight: 650
    letterSpacing: -0.02em
  card-title:
    fontFamily: Red Hat Display
    fontSize: 16px
    fontWeight: 620
    lineHeight: 1.3
    letterSpacing: -0.02em
  body:
    fontFamily: Red Hat Display
    fontSize: 14px
    lineHeight: 1.45
  lede:
    fontFamily: Red Hat Display
    fontSize: 14px
    lineHeight: 1.45
  supporting:
    fontFamily: Red Hat Display
    fontSize: 13px
    lineHeight: 1.4
  meta:
    fontFamily: Red Hat Display
    fontSize: 12px
  mono:
    fontFamily: Space Mono
    fontSize: 12px
rounded:
  sm: 4px
  md: 8px
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  pane-inset: 24px
  rail: 212px
  rail-collapsed: 64px
  topbar: 52px
components:
  button:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    height: 40px
    padding: 0 14px
  button-hover:
    backgroundColor: "{colors.inset}"
  button-primary:
    backgroundColor: "{colors.heat}"
    textColor: "{colors.heat-ink}"
    rounded: "{rounded.sm}"
    height: 40px
  button-primary-hover:
    backgroundColor: "{colors.heat-hover}"
  button-primary-active:
    backgroundColor: "{colors.heat-press}"
  button-disabled:
    backgroundColor: "{colors.inset}"
    textColor: "{colors.ink-mute}"
  field:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    height: 40px
  rail:
    backgroundColor: "{colors.rail}"
    textColor: "{colors.rail-text}"
    width: 212px
  rail-item-current:
    backgroundColor: "{colors.rail-current}"
    textColor: "{colors.heat}"
  rail-meta:
    backgroundColor: "{colors.rail}"
    textColor: "{colors.rail-mute}"
  rail-edge:
    backgroundColor: "{colors.rail-line}"
  room:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
  secondary-text:
    backgroundColor: "{colors.pane}"
    textColor: "{colors.ink-soft}"
  divider:
    backgroundColor: "{colors.rule}"
  field-border:
    backgroundColor: "{colors.rule-strong}"
  focus-ring:
    backgroundColor: "{colors.ring}"
  status-ok:
    backgroundColor: "{colors.pane}"
    textColor: "{colors.ok}"
  status-bad:
    backgroundColor: "{colors.pane}"
    textColor: "{colors.bad}"
  login-field-border:
    backgroundColor: "{colors.night-line}"
  login-error:
    backgroundColor: "{colors.rail}"
    textColor: "{colors.night-bad}"
  pane:
    backgroundColor: "{colors.pane}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
  topbar:
    backgroundColor: "{colors.pane}"
    height: 52px
  priority-p0:
    backgroundColor: "{colors.heat}"
    textColor: "{colors.heat-ink}"
  priority-p1:
    backgroundColor: "{colors.heat-wash}"
    textColor: "{colors.heat-ink}"
  toast:
    backgroundColor: "{colors.rail}"
    textColor: "{colors.rail-text}"
    rounded: "{rounded.md}"
  login-field:
    backgroundColor: "{colors.night-field}"
    textColor: "{colors.rail-text}"
    rounded: "{rounded.sm}"
    height: 40px
---

## Overview

Night instrument. A precise operator console for classifying pull requests: a graphite rail that wraps a light working pane, cool-gray type, and one heat signal. It is not a dashboard, not a GitHub clone, not newsprint, and not a generic AI product.

The operator sits in a queue for hours. The room is quiet, dense, and technical. The brand is the real Corbits mark plus materials (graphite, cool paper, heat), never a letter stamp, glass, or personality copy.

## Colors

Materials, not decoration:

- **Rail (#0a0c11):** Graphite tool body. The sidebar, toasts, mobile nav, and the login room. It wraps the working pane with an 8px gutter.
- **Pane (#f6f7f9):** The working surface inside the rail. Inside the pane, the `paper` token resolves to `pane`.
- **Paper (#e5e7ed):** The room outside the pane, such as the Connect task.
- **Sheet (#fdfdfe):** Controls and briefing cells lifted off the pane.
- **Inset (#d4d7e0):** Grouped fields, hover and pressed states, code wash.
- **Ink (#12141a):** Primary text, never pure black. `ink-mute` (#575d68) meets 4.5:1 on paper for supporting copy.
- **Rule (#c3c7d1) and rule-strong (#959ba8):** Hairline structure and control borders.
- **Heat (#d44510):** Attention only: the primary action, the current nav item, P0, and the human-gate mark. Text on heat uses `heat-ink`, not white.
- **Ok (#1d6b42) and bad (#b1352c):** Status, always paired with a readable label. Never "reject".
- **Night tokens:** Fields and errors on the graphite login room (`night-field`, `night-line`, `night-bad`).

## Typography

One family carries the UI: **Red Hat Display**, a variable font (300 to 900), self-hosted. System sans is a fallback only.

**Space Mono** is for identifiers only: repository `owner/name`, SHAs, keys, posted comments, and diffs. It is never a technical costume on labels or body text.

The scale runs 28px page title, 18px section title, 14px body and lede, 13px supporting text, and 12px meta, with a 14px root. Mobile page titles drop to 1.75rem. Counts use tabular numerals. Everything is sentence case.

## Layout

- Desktop is a full-bleed instrument: a 212px rail (64px collapsed) plus the pane filling the rest of the viewport. There is no centered content island.
- The pane inset is 24px on a 4px rhythm.
- The top bar is 52px and opaque.
- Lists, lanes, and rows span the pane. Form controls keep a readable measure (about 36rem), left-aligned.
- On a pull request, a 44px icon sliver sits on the pane's right edge and slides open to 240px over the canvas.
- At 720px and below, the rail hides, a 68px graphite bottom nav (icon plus label) takes over, and the document scrolls.
- Login and Connect are centered tasks in a full room, not portal pages.

## Elevation & Depth

Depth comes from material, not shadow: the light pane sits inside the graphite rail. Structure is hairlines, not nested cards. Shadows are rare and reserved for the toast, menus, dialogs, and the open sliver (`0 8px 24px` at 14% graphite). There is no glass and no hard offset shadow.

## Shapes

- Controls use 4px radii; the pane, dialogs, menus, and toasts use 8px.
- Pills appear only on compact chips and counts.
- Human-gated rows carry a 6px heat square, never a colored card border.
- Focus is a 2px heat ring with a 2px offset.

## Components

- **Buttons:** one size (40px desktop, 44px touch) and one radius. Clusters align right. One heat primary per region. A disabled primary uses inset and mute ink, never faded heat.
- **Pull request actions:** Confirm and Dismiss appear only when an approval is pending, and Close as duplicate only for duplicates. Secondary GitHub writes sit in a More menu.
- **Board rows:** title, then a mono identity line with state, owner, and age, then why and next action. Hover is a sheet wash.
- **Fields:** sheet background and strong rule; the border turns heat on focus.
- **Tabs:** selected tabs are underlined in heat.
- **Toast:** rail surface, status role.
- **Empty states:** a left-aligned mute sentence that names the condition.
- **Mark:** the real Corbits SVG at 28px (40px on login). Never a letter tile.
- **Motion:** 180ms `cubic-bezier(0.2, 0.8, 0.2, 1)` on hover, focus, color, and transform. Never animate width, height, or margin. The catching-up pulse is the only looping state.

## Do's and Don'ts

**Do:**

- Use plain GitHub language: repository, pull request, review, webhook, GitHub App.
- Say what was inspected: the pull request, the linked issue, surrounding GitHub data, or the code versus CI.
- Present the score as confidence against the floor.
- Make errors name the failure and the next step.
- Use lucide icons at 1.7 stroke.

**Don't:**

- Put kickers or eyebrows above headings.
- Build page structure from same-size icon, heading, and text card grids, or nest cards.
- Use hero metric or KPI templates.
- Use gradient text, decorative glass, colored borders wider than 1px, or hard offset shadows.
- Use emoji or unicode as icons.
- Name a judge (no "the model", no product codenames) on pull request or check surfaces.
- Use "secure", "intelligent", "cockpit", "instrument", or "control plane" in the UI.
- Collect App ID, private key, client secret, or webhook secret anywhere except the GitHub App connection form.
