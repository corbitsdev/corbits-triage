---
version: alpha
name: Corbits Triage
description: Night instrument. A graphite rail wrapping a light working pane, one heat signal for attention.
colors:
  background: "#ffffff"
  foreground: "#2b2627"
  card: "#f2f4f5"
  muted: "#eceff1"
  muted-foreground: "#5c5555"
  border: "#dfe3e6"
  border-strong: "#c3ccd2"
  primary: "#e98428"
  primary-active: "#d4791f"
  primary-foreground: "#2b2627"
  secondary: "#c5d2de"
  success: "#c1d1be"
  ok: "#2f7c40"
  destructive: "#9e2b25"
  ring: "#9a5416"
  heat-wash: "#fbe1c9"
  rail: "#0a0c11"
  rail-mute: "#8b909c"
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
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.sm}"
    height: 40px
    padding: 0 14px
  button-hover:
    backgroundColor: "{colors.muted}"
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.sm}"
    height: 40px
  button-primary-hover:
    backgroundColor: "{colors.primary-active}"
  button-primary-active:
    backgroundColor: "{colors.primary-active}"
  button-disabled:
    backgroundColor: "{colors.muted}"
    textColor: "{colors.muted-foreground}"
  field:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.sm}"
    height: 40px
  rail:
    backgroundColor: "{colors.rail}"
    textColor: "{colors.background}"
    width: 212px
  rail-item-current:
    backgroundColor: "{colors.primary-foreground}"
    textColor: "{colors.primary}"
  rail-meta:
    backgroundColor: "{colors.rail}"
    textColor: "{colors.rail-mute}"
  rail-edge:
    backgroundColor: "{colors.border}"
  room:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
  secondary-text:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
  divider:
    backgroundColor: "{colors.border}"
  field-border:
    backgroundColor: "{colors.border-strong}"
  focus-ring:
    backgroundColor: "{colors.ring}"
  status-ok:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ok}"
  status-bad:
    backgroundColor: "{colors.card}"
    textColor: "{colors.destructive}"
  login-field-border:
    backgroundColor: "{colors.border-strong}"
  login-error:
    backgroundColor: "{colors.rail}"
    textColor: "{colors.destructive}"
  pane:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
  topbar:
    backgroundColor: "{colors.card}"
    height: 52px
  priority-p0:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
  priority-p1:
    backgroundColor: "{colors.heat-wash}"
    textColor: "{colors.primary-foreground}"
  toast:
    backgroundColor: "{colors.rail}"
    textColor: "{colors.background}"
    rounded: "{rounded.md}"
  login-field:
    backgroundColor: "{colors.rail}"
    textColor: "{colors.background}"
    rounded: "{rounded.sm}"
    height: 40px
---

## Overview

Night instrument. A precise operator console for classifying pull requests: a graphite rail that wraps a light working pane, cool-gray type, and one heat signal. It is not a dashboard, not a GitHub clone, not newsprint, and not a generic AI product.

The operator sits in a queue for hours. The room is quiet, dense, and technical. The brand is the real Corbits mark plus materials (graphite, cool paper, heat), never a letter stamp, glass, or personality copy.

## Colors

The palette is the `@corbits/react-ui` theme. Portal CSS reads the library's tokens (`background`, `foreground`, `card`, `muted`, `muted-foreground`, `border`, `border-strong`, `primary`, `primary-active`, `primary-foreground`, `secondary`, `success`, `ok`, `destructive`, `ring`) and defines only what the theme lacks:

- **Heat wash (#fbe1c9):** the soft primary fill behind a human-gated mark or a P1 priority.
- **Rail (#0a0c11) and rail mute (#8b909c):** the graphite mobile nav and its labels.
- **Blue (#607c9a):** the author dot in the inbox.

Primary is attention only: the primary action, the current nav item, P0, and the human-gate mark. Text on primary uses `primary-foreground`, not white. Ok and destructive are status, always paired with a readable label.

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
- **Pull request actions:** Confirm and Dismiss appear only when an approval is pending. Secondary GitHub writes sit in a More menu.
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
