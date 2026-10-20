import type { ReactNode } from "react";
import { useIsMutating, type MutationKey } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@corbits/react-ui/ui/dialog";

type KeyPopupProps = {
  open: boolean;
  title: string;
  description: string;
  /** The key form's save; while it runs the popup stays open and cannot be dismissed. */
  mutationKey: MutationKey;
  onCancel: () => void;
  /** Puts focus back on the control that opened the popup, once the popup has closed. */
  returnFocus: () => void;
  children: ReactNode;
};

/** Asks for a missing key where it is needed. It stays open while the key saves, even once the caller sees the key stored, so the form can finish. */
export function KeyPopup({ open, title, description, mutationKey, onCancel, returnFocus, children }: KeyPopupProps) {
  const saving = useIsMutating({ mutationKey }) > 0;

  function dismiss(next: boolean) {
    if (!next && !saving) onCancel();
  }

  function focusOpener(event: Event) {
    event.preventDefault();
    returnFocus();
  }

  return (
    <Dialog open={open || saving} onOpenChange={dismiss}>
      <DialogContent className="key-popup" onCloseAutoFocus={focusOpener}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}
