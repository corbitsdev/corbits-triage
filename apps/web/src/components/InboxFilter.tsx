import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { useDismissablePopover } from "@corbits/react-ui";
import type { PrItem } from "../lib/hub-api.ts";
import {
  FACET_LABEL,
  FILTER_FACETS,
  NO_FILTERS,
  activeFilters,
  facetOptions,
  toggleFilter,
  type FilterFacet,
  type InboxFilters,
} from "../lib/inbox-filter.ts";
import { isInteractiveShortcutTarget } from "../lib/queue-workflow.ts";
import { FilterIcon } from "./inbox-icons.tsx";

const FACET_KEY_STEP: Record<string, number> = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };

type FilterMenuProps = {
  /** The rows the list can show before the facet filters, so the counts match the list. */
  items: PrItem[];
  now: number;
  filters: InboxFilters;
  onChange: (filters: InboxFilters) => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
};

function trapTab(event: ReactKeyboardEvent<HTMLElement>) {
  const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>("button, input")].filter((element) => element.tabIndex >= 0);
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}

export function FilterMenu({ items, now, filters, onChange, triggerRef }: FilterMenuProps) {
  const popover = useDismissablePopover<HTMLDivElement, HTMLButtonElement>();
  const { open, setOpen, rootRef, close } = popover;
  const [facet, setFacet] = useState<FilterFacet>("repo");
  const tabRefs = useRef<Partial<Record<FilterFacet, HTMLButtonElement | null>>>({});
  const id = useId();
  const active = activeFilters(filters).length;
  const options = open ? facetOptions(items, filters, facet, now) : [];

  useEffect(function focusFacetOnOpen() {
    if (open) tabRefs.current[facet]?.focus();
  }, [open]);

  useEffect(function openOnShortcut() {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "f" || event.metaKey || event.ctrlKey || event.altKey || isInteractiveShortcutTarget(event.target)) return;
      event.preventDefault();
      setOpen(true);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setOpen]);

  function setTrigger(element: HTMLButtonElement | null) {
    triggerRef.current = element;
    popover.triggerRef.current = element;
  }

  function selectFacet(next: FilterFacet) {
    setFacet(next);
    tabRefs.current[next]?.focus();
  }

  function onFacetKey(event: ReactKeyboardEvent<HTMLButtonElement>) {
    const last = FILTER_FACETS.length - 1;
    const index = FILTER_FACETS.indexOf(facet);
    const step = FACET_KEY_STEP[event.key];
    const next = event.key === "Home" ? 0 : event.key === "End" ? last : step === undefined ? null : (index + step + FILTER_FACETS.length) % FILTER_FACETS.length;
    const target = next === null ? undefined : FILTER_FACETS[next];
    if (target === undefined) return;
    event.preventDefault();
    selectFacet(target);
  }

  return (
    <div className="menu-wrap" ref={rootRef}>
      <button
        ref={setTrigger}
        type="button"
        className="tbtn"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? `${id}-dialog` : undefined}
        aria-label={active > 0 ? `Filter, ${active} active` : undefined}
        onClick={() => setOpen(!open)}
      >
        <FilterIcon />Filter{active > 0 ? <span className="n">{active}</span> : null}
      </button>
      {open ? (
        <>
          <div className="filter-scrim" onClick={close} />
          <div className="pop" id={`${id}-dialog`} role="dialog" aria-modal="true" aria-label="Filter pull requests" onKeyDown={trapTab}>
            <div className="facets" role="tablist" aria-label="Filter by" aria-orientation="vertical">
              {FILTER_FACETS.map((key) => (
                <button
                  key={key}
                  ref={(element) => { tabRefs.current[key] = element; }}
                  type="button"
                  role="tab"
                  id={`${id}-${key}`}
                  aria-selected={key === facet}
                  aria-controls={`${id}-panel`}
                  tabIndex={key === facet ? 0 : -1}
                  className={key === facet ? "on" : undefined}
                  onClick={() => selectFacet(key)}
                  onKeyDown={onFacetKey}
                >
                  {FACET_LABEL[key]}
                  {filters[key].length > 0 ? <b>{filters[key].length}</b> : null}
                </button>
              ))}
            </div>
            <div className="vals" role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${facet}`}>
              {options.map((option) => (
                <label key={option.value}>
                  <input type="checkbox" checked={filters[facet].includes(option.value)} onChange={() => onChange(toggleFilter(filters, facet, option.value))} />
                  <span className="l">{option.label}</span>
                  <span className="c">{option.count}</span>
                </label>
              ))}
            </div>
            <div className="pfoot">
              <span>Filters combine. Pick several in one group to widen it.</span>
              <button type="button" className="linkish" onClick={close}>Done</button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

type FilterPillsProps = {
  filters: InboxFilters;
  onChange: (filters: InboxFilters) => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
};

export function FilterPills({ filters, onChange, triggerRef }: FilterPillsProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const active = activeFilters(filters);
  if (active.length === 0) return null;

  function remove(index: number) {
    const pill = active[index];
    if (pill === undefined) return;
    const pills = listRef.current?.querySelectorAll<HTMLButtonElement>(".pill");
    const neighbour = pills?.[index + 1] ?? pills?.[index - 1];
    onChange(toggleFilter(filters, pill.facet, pill.value));
    (neighbour ?? triggerRef.current)?.focus();
  }

  function clear() {
    onChange(NO_FILTERS);
    triggerRef.current?.focus();
  }

  return (
    <div className="pills" role="group" aria-label="Active filters" ref={listRef}>
      {active.map((pill, index) => (
        <button key={`${pill.facet}:${pill.value}`} type="button" className="pill" aria-label={`Remove filter ${FACET_LABEL[pill.facet]}: ${pill.label}`} onClick={() => remove(index)}>
          {FACET_LABEL[pill.facet]}: <span>{pill.label}</span><b aria-hidden="true">×</b>
        </button>
      ))}
      <button type="button" className="linkish" onClick={clear}>Clear</button>
    </div>
  );
}
