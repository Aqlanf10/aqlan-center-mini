"use client";

import { useCallback, useEffect, useState } from "react";

interface Attachment {
  id: number;
  title: string;
  mimeType: string;
  sizeBytes: number;
  uploadedBy: string;
  uploadedAt: string;
}

/**
 * (P3-6) مرفقات سند الصرف — صورة الإيصال أو فاتورة المورّد بجانب السند.
 *
 * تظهر على الشاشة وحدها (print-actions) فلا تدخل الورقة المطبوعة. الرفع يمرّ من
 * فحوص الخادم نفسها التي تمرّ منها الأشعة، والمرفق لا يُحذف: شاهدٌ مالي.
 */
export function VoucherAttachments({ expenseId }: { expenseId: number }) {
  const [items, setItems] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/expenses/${expenseId}/attachments`, { cache: "no-store" });
      const payload = await response.json().catch(() => null);
      if (response.ok && Array.isArray(payload?.attachments)) setItems(payload.attachments as Attachment[]);
    } catch {
      // الشاشة تعمل بلا القائمة — والرفع يُظهر خطأه بنفسه.
    }
  }, [expenseId]);

  useEffect(() => { void load(); }, [load]);

  const upload = async (file: File | null) => {
    if (!file || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const body = new FormData();
      body.set("file", file);
      body.set("title", file.name);
      const response = await fetch(`/api/expenses/${expenseId}/attachments`, { method: "POST", body });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setMessage(payload?.message ?? "تعذّر رفع الملف.");
        return;
      }
      setMessage("أُرفق الإيصال بالسند.");
      await load();
    } catch {
      setMessage("تعذّر الاتصال بالخادم.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="print-actions" style={{ maxWidth: "105mm", margin: "12px auto 0", fontSize: "13px" }} dir="rtl">
      <strong>مرفقات السند (صورة الإيصال أو فاتورة المورّد)</strong>
      {items.length === 0 ? (
        <p style={{ color: "#64748b", margin: "6px 0" }}>لا مرفقات بعد.</p>
      ) : (
        <ul style={{ margin: "6px 0", paddingInlineStart: "18px" }}>
          {items.map((item) => (
            <li key={item.id}>
              <a href={`/api/expense-attachments/${item.id}`} target="_blank" rel="noopener">{item.title}</a>
              <span style={{ color: "#64748b" }}> — {item.uploadedBy}</span>
            </li>
          ))}
        </ul>
      )}
      <label style={{ display: "inline-block", cursor: busy ? "wait" : "pointer", fontWeight: 700 }}>
        📎 {busy ? "جارٍ الرفع…" : "إرفاق صورة أو PDF"}
        <input
          type="file"
          accept="image/*,application/pdf"
          capture="environment"
          disabled={busy}
          onChange={(event) => { void upload(event.target.files?.[0] ?? null); event.target.value = ""; }}
          style={{ display: "none" }}
        />
      </label>
      {message ? <p role="status" style={{ margin: "6px 0 0" }}>{message}</p> : null}
    </div>
  );
}
