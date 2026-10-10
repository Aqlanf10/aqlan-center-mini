"use client";

import { useCallback, useEffect, useRef, type Dispatch, type KeyboardEvent, type MouseEvent, type SetStateAction } from "react";

/**
 * A disclosure of ordinary links/buttons, retaining native Tab/Enter/Space
 * semantics. React alone owns "open": mirroring the asynchronous native toggle
 * event can reopen a disclosure that was dismissed before that event arrives.
 */
export function useDismissibleDetails(open: boolean, setOpen: Dispatch<SetStateAction<boolean>>) {
  const ref = useRef<HTMLDetailsElement>(null);
  const close = useCallback((restoreFocus = false) => {
    const details = ref.current;
    // Return focus only from this disclosure, never from an action's dialog or
    // an outside control that has already taken focus.
    if (restoreFocus && details?.contains(details.ownerDocument.activeElement)) {
      details.querySelector<HTMLElement>(":scope > summary")?.focus({ preventScroll: true });
    }
    setOpen(false);
  }, [setOpen]);

  useEffect(() => {
    const details = ref.current;
    if (!open || !details) return;
    const document = details.ownerDocument;
    const dismissOutside = (event: Event) => {
      if (!event.composedPath().includes(details)) close();
    };
    // Pointer events cover mouse, pen and touch without a second click handler.
    // Capture sees outside interactions even when another control stops bubbling.
    document.addEventListener("pointerdown", dismissOutside, true);
    document.addEventListener("focusin", dismissOutside, true);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside, true);
      document.removeEventListener("focusin", dismissOutside, true);
    };
  }, [open, close]);

  const onSummaryClick = (event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    setOpen(current => !current);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDetailsElement>) => {
    if (!open || event.key !== "Escape" || event.defaultPrevented
      || !event.currentTarget.contains(event.target as Node)) return;
    event.preventDefault();
    event.stopPropagation();
    close(true);
  };
  const onActionClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const action = target.closest("button, a[href]");
    if (!action || !event.currentTarget.contains(action)
      || action.matches(":disabled, [aria-disabled='true']")) return;
    // Bubble after the existing action, without preventing navigation or
    // redispatching a click. A newly opened dialog retains its own focus.
    close(true);
  };

  return { ref, onSummaryClick, onKeyDown, onActionClick };
}
