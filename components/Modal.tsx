"use client";

import { useEffect, useRef, type ReactNode } from "react";

/** Native modal dialogs isolate the background and retain keyboard focus. */
export function Modal({ children, onClose, label, labelledBy, busy = false, initialFocus, alignTop = false }: {
  children: ReactNode;
  onClose: () => void;
  label?: string;
  labelledBy?: string;
  busy?: boolean;
  initialFocus?: string;
  alignTop?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    if (initialFocus) dialog.querySelector<HTMLElement>(initialFocus)?.focus();
    return () => {
      dialog.close();
      if (previous?.isConnected) previous.focus();
    };
  }, [initialFocus]);

  return (
    <dialog
      ref={ref}
      aria-label={label}
      aria-labelledby={labelledBy}
      aria-modal="true"
      aria-busy={busy || undefined}
      className={`fixed inset-0 m-0 h-dvh max-h-none w-full max-w-none overflow-y-auto border-0 bg-transparent p-4 text-navy-900 backdrop:bg-slate-900/60 backdrop:backdrop-blur-sm open:flex justify-center ${alignTop ? "items-start sm:pt-16" : "items-center"}`}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(event) => {
        if (!busy && event.target === event.currentTarget) onClose();
      }}
    >
      {children}
    </dialog>
  );
}
