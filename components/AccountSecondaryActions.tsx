"use client";

import { useState, type ReactNode } from "react";
import { useDismissibleDetails } from "./useDismissibleDetails";

/** Reuses the patient header's owned, keyboard/outside-dismissible disclosure. */
export function AccountSecondaryActions({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const { ref, onKeyDown, onSummaryClick, onActionClick } = useDismissibleDetails(open, setOpen);
  return <details ref={ref} open={open} onKeyDown={onKeyDown}
    data-testid="account-secondary-actions" className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs">
    <summary onClick={onSummaryClick} aria-expanded={open}
      className="min-h-7 cursor-pointer font-bold text-navy-800">إجراءات الحساب الأخرى</summary>
    <div onClick={onActionClick}>{children}</div>
  </details>;
}
