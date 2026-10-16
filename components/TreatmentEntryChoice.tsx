"use client";

import {FileText, History} from "lucide-react";
import workspace from "./InvoiceWorkspace.module.css";

/** Choosing an origin is presentation only. The owning Account component keeps
 * the existing invoice and legacy writers, currencies and idempotency keys. */
export function TreatmentEntryChoice({ canAddLegacy, disabled, onSelect, activeMode }: {
  canAddLegacy: boolean;
  disabled: boolean;
  onSelect: (mode: "invoice" | "legacy") => void;
  activeMode?: "invoice" | "legacy";
}) {
  return <section aria-label="نوع الفاتورة / اتفاق العلاج" data-testid="treatment-entry-choice"
    className={workspace.origin}>
    {!activeMode?<h3>فاتورة / اتفاق علاج</h3>:null}
    <div className={workspace.originTabs}>
      <button type="button" aria-label="علاج جديد" aria-pressed={activeMode==="invoice"} disabled={disabled} onClick={() => { if (!disabled&&activeMode!=="invoice") onSelect("invoice"); }}>
        <FileText size={19} aria-hidden="true"/><span>العلاج الجديد</span>
      </button>
      <button type="button" aria-label="علاج بدأ قبل النظام" aria-pressed={activeMode==="legacy"} disabled={disabled || !canAddLegacy}
        onClick={() => { if (!disabled && canAddLegacy&&activeMode!=="legacy") onSelect("legacy"); }}>
        <History size={19} aria-hidden="true"/><span>علاج بدأ قبل النظام</span>
      </button>
    </div>
    {!activeMode?<p>اختر نوع الاتفاق، ثم أضف الخدمات والأسنان والأسعار في نموذج واحد.</p>:null}
    {!canAddLegacy ? <p>تسجيل العلاج السابق غير متاح بصلاحية الحساب الحالية.</p> : null}
  </section>;
}
