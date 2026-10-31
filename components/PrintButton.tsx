"use client";

import { useState } from "react";

/**
 * زر الطباعة — ويسجّل الطبعة قبل أن يطبع.
 *
 * والترتيب مقصود: يُسجَّل أولًا فيُعرف إن كانت إعادة، فتظهر العلامة **على الورقة
 * الخارجة** لا على التي بعدها. ولو سُجّل بعد الطباعة لخرجت النسخة الثانية نظيفة
 * وظهرت العلامة على الثالثة — وهي بالضبط الحالة التي جاءت العلامة لتغطيتها.
 *
 * الوصفات لا تفتح الطباعة عند رفض التسجيل؛ السندات المالية تحتفظ بسلوكها.
 */
export function PrintButton({ docType, docId, patientId }: {
  docType?: "receipt" | "invoice" | "voucher" | "statement" | "prescription";
  docId?: string | number;
  patientId?: number;
} = {}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const print = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    let allowed = docType !== "prescription";
    try {
      if (docType && docId !== undefined) {
        const response = await fetch("/api/print-log", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ docType, docId, ...(docType === "prescription" ? { patientId } : {}) }),
        });
        const payload = await response.json().catch(() => null);
        if (docType === "prescription") {
          if (!response.ok || typeof payload?.previous !== "number" || typeof payload?.reprint !== "boolean") {
            setError(payload?.message || "تعذر تسجيل الطباعة؛ لم تُفتح نافذة الطباعة.");
            return;
          }
          allowed = true;
        }
        if (payload?.reprint) {
          // تُكشف العلامة في الصفحة نفسها، ثم يُنتظر إطار رسم واحد لتخرج معها.
          document.documentElement.dataset.reprint = "true";
          await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
        }
      }
    } catch {
      if (docType === "prescription") setError("تعذر التحقق من الطباعة. راجع الاتصال ثم أعد المحاولة.");
    } finally {
      setBusy(false);
      if (allowed) window.print();
    }
  };

  return (
    <div className="print-actions">
      {error && <p role="alert">{error}</p>}
      <button type="button" data-print-document-action onClick={() => void print()} disabled={busy}>
        {busy ? "…" : "اطبع"}
      </button>
    </div>
  );
}

/**
 * علامة «نسخة معاد طباعتها».
 *
 * تُصيَّر دائمًا وتظهر بشرطين: أن يقول الخادم إن المستند طُبع من قبل، أو أن يكشفها
 * زرّ الطباعة عند إعادة. وهي مائلة عبر الورقة كلها لا في زاوية: من ينظر إلى السند
 * بسرعة يجب أن يراها بلا أن يبحث عنها.
 */
export function ReprintMark({ printed = false }: { printed?: boolean }) {
  return (
    <div className={`reprint-mark${printed ? " reprint-mark-on" : ""}`} aria-hidden>
      نسخة معاد طباعتها
    </div>
  );
}
