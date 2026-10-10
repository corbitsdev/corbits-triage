import type { KeyboardEvent } from "react";
import { useDismissablePopover } from "@corbits/react-ui";
import { catalogCheckEnabled } from "@corbits/triage-contracts";
import { checkName, isCatalogId } from "../../lib/pack-prose.ts";
import CheckPopover, { type CheckPopoverProps } from "./CheckPopover.tsx";

type CheckNameProps = Omit<CheckPopoverProps, "onClose"> & { flagged?: boolean };

/** A check's name in a sentence; it opens the check's method and parameters. */
export default function CheckName({ flagged, ...props }: CheckNameProps) {
  const { open, setOpen, rootRef, triggerRef, close } = useDismissablePopover<HTMLSpanElement, HTMLButtonElement>({ closeOnEscape: false });
  const { id, draft } = props;
  const off = isCatalogId(id) && !catalogCheckEnabled(draft.pack, id);

  /** Marks Escape as handled so the panel stays open while only the popover closes. */
  function closeOnEscape(event: KeyboardEvent<HTMLSpanElement>) {
    if (!open || event.key !== "Escape") return;
    event.preventDefault();
    close();
  }

  return (
    <span className="menu-wrap check-name" ref={rootRef} onKeyDown={closeOnEscape}>
      <button type="button" className={flagged ? "chk flagged" : "chk"} ref={triggerRef} aria-expanded={open} onClick={() => setOpen(!open)}>
        {checkName(draft.pack, id)}{off ? <small> off</small> : null}
      </button>
      {open ? <CheckPopover {...props} onClose={close} /> : null}
    </span>
  );
}
