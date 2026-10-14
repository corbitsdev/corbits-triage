import { driver, type DriveStep } from "driver.js";
import driverCss from "driver.js/dist/driver.css?inline";

/*
 * driver.js draws its overlay and popover in GitHub's document, outside Triage's shadow roots, so its stylesheet goes
 * into the page while the tour runs. GitHub's colour variables theme it to the page's light or dark mode.
 */
const THEME = `
.driver-popover.corbits-tour {
  max-width: 320px;
  padding: 16px;
  border: 1px solid var(--borderColor-default, #d1d9e0);
  border-radius: 12px;
  background: var(--overlay-bgColor, var(--bgColor-default, #ffffff));
  color: var(--fgColor-default, #1f2328);
  box-shadow: var(--shadow-floating-small, 0 1px 3px rgb(31 35 40 / 0.12), 0 8px 24px rgb(66 74 83 / 0.12));
  font: 400 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
}
.driver-popover.corbits-tour .driver-popover-title { font: 600 15px/1.35 inherit; color: inherit; }
.driver-popover.corbits-tour .driver-popover-description { margin-top: 6px; color: inherit; }
.driver-popover.corbits-tour .driver-popover-progress-text { color: var(--fgColor-muted, #59636e); font-size: 12px; }
.driver-popover.corbits-tour .driver-popover-footer button {
  padding: 5px 12px;
  border: 1px solid var(--borderColor-default, #d1d9e0);
  border-radius: 6px;
  background: var(--button-default-bgColor-rest, #f6f8fa);
  color: var(--fgColor-default, #1f2328);
  font: 500 13px/1.4 inherit;
  text-shadow: none;
}
.driver-popover.corbits-tour .driver-popover-footer .driver-popover-next-btn {
  border-color: #E98428;
  background: #E98428;
  color: #000000;
}
.driver-popover.corbits-tour .driver-popover-close-btn { color: var(--fgColor-muted, #59636e); }
.driver-popover.corbits-tour button:not(:disabled) { cursor: pointer; }
.driver-popover.corbits-tour button:disabled { cursor: not-allowed; }
.driver-popover.corbits-tour .driver-popover-arrow-side-left.driver-popover-arrow { border-left-color: var(--overlay-bgColor, var(--bgColor-default, #ffffff)); }
.driver-popover.corbits-tour .driver-popover-arrow-side-right.driver-popover-arrow { border-right-color: var(--overlay-bgColor, var(--bgColor-default, #ffffff)); }
.driver-popover.corbits-tour .driver-popover-arrow-side-top.driver-popover-arrow { border-top-color: var(--overlay-bgColor, var(--bgColor-default, #ffffff)); }
.driver-popover.corbits-tour .driver-popover-arrow-side-bottom.driver-popover-arrow { border-bottom-color: var(--overlay-bgColor, var(--bgColor-default, #ffffff)); }
@media (prefers-reduced-motion: reduce) { .driver-popover.corbits-tour, .driver-overlay { animation: none !important; transition: none !important; } }
`;

type Find = () => Element | null | undefined;

export type TourParts = { chip: Find; block: Find; actions: Find; draft: Find; openPanel(): void };

export type Tour = { active(): boolean; start(parts: TourParts): void; refresh(): void };

// GitHub restores a page's scroll after it loads; for this long after a step shows, a scroll that takes its part out of
// view is undone, while the person's own later scrolling is left alone.
const HOLD_MS = 2000;

function outOfView(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  return rect.bottom < 0 || rect.top > innerHeight;
}

export function tour(): Tour {
  let current: ReturnType<typeof driver> | undefined;
  let holdUntil = 0;

  function onScroll() {
    const element = current?.getActiveElement();
    if (!element || Date.now() > holdUntil || !outOfView(element)) return;
    element.scrollIntoView({ block: "center" });
    current?.refresh();
  }

  function step(find: Find, popover: DriveStep["popover"]): DriveStep[] {
    return find() ? [{ element: () => find()!, popover }] : [];
  }

  function steps(parts: TourParts): DriveStep[] {
    const list: DriveStep[] = [
      ...step(parts.chip, { title: "The pull request's score", description: "Triage scores every pull request you open, from what GitHub shows you. Hover for a summary; click to open the side panel.", side: "bottom", align: "start" }),
      ...step(parts.block, { title: "Triage in the sidebar", description: "The state, the next step and each failing or unsure rule, in a line each. It sits here on every pull request.", side: "left", align: "start" }),
      ...step(parts.actions, { title: "Steps to take", description: "Each one comes from a rule. A click applies it as you, signed in to GitHub. A comment posts only when you press Post comment; nothing posts on its own.", side: "left", align: "start" }),
      ...step(parts.draft, { title: "A drafted comment", description: "Where you can comment, Triage puts its best draft in the comment box without posting it. Edit it and press Comment, or Undo to take it back out.", side: "top", align: "start" }),
    ];
    list.push({
      popover: {
        title: "The side panel",
        description: "Every rule with its evidence, the drafts, and your rules and settings. Expand it into a full tab from its header.",
        nextBtnText: "Open the side panel",
        onNextClick: function openPanel() {
          parts.openPanel();
          current?.destroy();
        },
      },
    });
    return list;
  }

  function start(parts: TourParts) {
    if (current?.isActive()) return;
    const style = document.createElement("style");
    style.id = "corbits-triage-tour";
    style.textContent = `${driverCss}\n${THEME}`;
    document.head.append(style);
    current = driver({
      steps: steps(parts),
      showProgress: true,
      progressText: "{{current}} of {{total}}",
      nextBtnText: "Next",
      prevBtnText: "Back",
      doneBtnText: "Done",
      popoverClass: "corbits-tour",
      stagePadding: 6,
      stageRadius: 8,
      overlayOpacity: 0.45,
      // A smooth scroll to a tall part leaves driver.js's popover where the last step had it.
      smoothScroll: false,
      animate: !matchMedia("(prefers-reduced-motion: reduce)").matches,
      onHighlighted: function holdInView() {
        holdUntil = Date.now() + HOLD_MS;
      },
      onDestroyed: function removeStyle() {
        style.remove();
        window.removeEventListener("scroll", onScroll);
        current = undefined;
      },
    });
    window.addEventListener("scroll", onScroll, { passive: true });
    current.drive();
  }

  function refresh() {
    if (current?.isActive()) current.refresh();
  }

  return { active: () => current?.isActive() === true, start, refresh };
}
