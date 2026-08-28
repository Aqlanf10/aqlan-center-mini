"use client";

import { useState } from "react";

/**
 * زر الطباعة — ويسجّل الطبعة قبل أن يطبع.
 *
 * والترتيب مقصود: يُسجَّل أولًا فيُعرف إن كانت إعادة، فتظهر العلامة **على الورقة
 * الخارجة** لا على التي بعدها. ولو سُجّل بعد الطباعة لخرجت النسخة الثانية نظيفة
 * وظهرت العلامة على الثالثة — وهي بالضبط الحالة التي جاءت العلامة لتغطيتها.
 *
 * ويطبع حتى لو تعذّر التسجيل: ورقةٌ بلا علامة أهون من مريض ينتظر سنده.
 */
export function PrintButton({ docType, docId }: {
  docType?: "receipt" | "invoice" | "voucher" | "statement";
  docId?: string | number;
} = {}) {
  const [busy, setBusy] = useState(false);

  const print = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (docType && docId !== undefined) {
        const response = await fetch("/api/print-log", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ docType, docId }),
        });
        const payload = await response.json().catch(() => null);
        if (payload?.reprint) {
          // تُكشف العلامة في الصفحة نفسها، ثم يُنتظر إطار رسم واحد لتخرج معها.
          document.documentElement.dataset.reprint = "true";
          await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
        }
      }
    } catch {
      // يُتجاهل — انظر التعليق أعلاه.
    } finally {
      setBusy(false);
      window.print();
    }
  };

  return (
    <div className="print-actions">
      <button type="button" onClick={() => void print()} disabled={busy}>
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
