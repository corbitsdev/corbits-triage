import { useEffect, useRef, useState, type HTMLAttributes } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { usePrefersReducedMotion } from "@corbits/react-ui";
import { RotateCw } from "lucide-react";

const THRESHOLD = 64;

type PullParts = { scroller: HTMLElement; mark: HTMLElement; icon: SVGElement; reduceMotion: boolean };

/** Finger travel slowed toward twice the threshold, so the mark arms after 128px of travel and never runs away. */
function pullDistance(travel: number) {
  return (travel * THRESHOLD * 2) / (travel + THRESHOLD * 2);
}

/** Follows one finger pulling down from the top of `scroller` and calls `onPulled` when it lets go past the threshold. */
function listenForPull({ scroller, mark, icon, reduceMotion }: PullParts, onPulled: () => void) {
  let finger: { id: number; x: number; y: number } | null = null;
  let distance: number | null = null;

  function show(pulled: number) {
    const progress = Math.min(pulled / THRESHOLD, 1);
    mark.style.transition = "none";
    mark.style.opacity = String(progress);
    if (!reduceMotion) {
      mark.style.transform = `translateY(${pulled}px)`;
      icon.style.transition = "none";
      icon.style.transform = `rotate(${progress * 270}deg)`;
    }
    mark.toggleAttribute("data-armed", pulled >= THRESHOLD);
  }

  function cancel() {
    finger = null;
    distance = null;
    mark.removeAttribute("style");
    mark.removeAttribute("data-armed");
    icon.removeAttribute("style");
  }

  /** On a phone the page scrolls rather than the container, so both must be at the top. */
  function atTop() {
    return scroller.scrollTop === 0 && window.scrollY === 0;
  }

  /** A drag that starts in a text box or a scrolled inner area scrolls that, not the container. */
  function scrollsSomethingElse(target: EventTarget | null) {
    for (let node = target instanceof Element ? target : null; node !== null && node !== scroller; node = node.parentElement) {
      if (node instanceof HTMLTextAreaElement || node.scrollTop > 0) return true;
    }
    return false;
  }

  function trackedTouch(touches: TouchList) {
    if (finger === null) return undefined;
    const id = finger.id;
    return [...touches].find((touch) => touch.identifier === id);
  }

  function onStart(event: TouchEvent) {
    // The tracked finger's own touchend never arrives when its row is removed mid-pull.
    if (finger !== null && trackedTouch(event.touches) === undefined) cancel();
    if (finger !== null || event.touches.length !== 1 || !atTop() || scrollsSomethingElse(event.target)) return;
    const touch = event.touches[0];
    finger = { id: touch.identifier, x: touch.clientX, y: touch.clientY };
  }

  function onMove(event: TouchEvent) {
    const touch = trackedTouch(event.changedTouches);
    if (finger === null || touch === undefined) return;
    const down = touch.clientY - finger.y;
    const sideways = Math.abs(touch.clientX - finger.x) > down;
    if (down <= 0 || !atTop() || (distance === null && sideways)) {
      cancel();
      return;
    }
    event.preventDefault();
    distance = pullDistance(down);
    show(distance);
  }

  function onEnd(event: TouchEvent) {
    if (trackedTouch(event.changedTouches) === undefined) return;
    if (distance === null || distance < THRESHOLD) {
      cancel();
      return;
    }
    finger = null;
    distance = null;
    // The icon keeps its rotation, so the spin carries on from where the finger left it.
    mark.setAttribute("data-refreshing", "");
    mark.removeAttribute("style");
    mark.removeAttribute("data-armed");
    icon.style.removeProperty("transition");
    onPulled();
  }

  scroller.addEventListener("touchstart", onStart, { passive: true });
  scroller.addEventListener("touchmove", onMove, { passive: false });
  scroller.addEventListener("touchend", onEnd);
  scroller.addEventListener("touchcancel", cancel);
  return function stopListening() {
    scroller.removeEventListener("touchstart", onStart);
    scroller.removeEventListener("touchmove", onMove);
    scroller.removeEventListener("touchend", onEnd);
    scroller.removeEventListener("touchcancel", cancel);
    if (finger !== null) cancel();
  };
}

/** A scroll container that refetches every active query when a finger pulls it down from the top. */
export default function PullToRefresh({ children, ...props }: HTMLAttributes<HTMLDivElement>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const markRef = useRef<HTMLDivElement>(null);
  const iconRef = useRef<SVGSVGElement>(null);
  const queryClient = useQueryClient();
  const reduceMotion = usePrefersReducedMotion();
  const [refreshing, setRefreshing] = useState(false);

  useEffect(function watchForPull() {
    const scroller = scrollRef.current;
    const mark = markRef.current;
    const icon = iconRef.current;
    if (scroller === null || mark === null || icon === null || refreshing) return;
    async function refresh() {
      setRefreshing(true);
      await queryClient.refetchQueries({ type: "active" });
      setRefreshing(false);
    }
    return listenForPull({ scroller, mark, icon, reduceMotion }, function refreshOnPull() {
      void refresh();
    });
  }, [queryClient, reduceMotion, refreshing]);

  return (
    <div {...props} ref={scrollRef}>
      <div className="pull-refresh" aria-hidden="true">
        <div className="pull-mark" ref={markRef} data-refreshing={refreshing ? "" : undefined}>
          <RotateCw ref={iconRef} size={16} strokeWidth={1.8} />
        </div>
      </div>
      <p role="status" className="sr-only">{refreshing ? "Refreshing" : ""}</p>
      {children}
    </div>
  );
}
