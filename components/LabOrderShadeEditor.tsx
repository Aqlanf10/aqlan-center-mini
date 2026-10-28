"use client";

import { useEffect, useRef, useState } from "react";
import { parseLabTeeth, type LabOrder } from "@/lib/lab";
import { parseLabShadeSpecification } from "@/lib/lab-shades";
import { LabShadeSelector } from "./LabShadeSelector";

/** Mount keyed to the order and principal; never applies a late response to a different patient. */
export function LabOrderShadeEditor({ order, onClose, onSaved }: {
  order: LabOrder; onClose: () => void; onSaved: () => void;
}) {
  const [value, setValue] = useState(order.shadeSpecification ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const active = useRef(true);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    active.current = true;
    dialog.current?.showModal();
    return () => { active.current = false; };
  }, []);
  const selected = Object.keys(parseLabTeeth(order.toothNumbers)).map(Number);
  if (!selected.length && order.toothCode) selected.push(order.toothCode);
  async function save() {
    if (pending.current || order.shadeSpecificationWarning) return;
    const parsed = parseLabShadeSpecification(value, selected);
    if (!parsed.ok) { setError(parsed.error); return; }
    pending.current = true; setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/lab/${order.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update_shade", shadeSpecification: parsed.value,
          expectedShadeSpecification: order.shadeSpecification ?? null }) });
      const result = await response.json();
      if (!active.current) return;
      if (!response.ok) { setError(result.message || "تعذر حفظ ألوان الإرسالية."); return; }
      onSaved();
    } catch { if (active.current) setError("تعذر التأكد من الحفظ. أغلق النافذة وأعد تحميل الإرسالية قبل المحاولة."); }
    finally { pending.current = false; if (active.current) setBusy(false); }
  }
  return <dialog ref={dialog} aria-labelledby="lab-shade-editor-title" dir="rtl"
    onCancel={event => { event.preventDefault(); if (!pending.current) onClose(); }}
    className="max-h-[90vh] w-[min(95vw,52rem)] rounded-2xl p-5 backdrop:bg-black/40">
    <h2 id="lab-shade-editor-title" className="mb-2 text-lg font-bold">تعديل تفاصيل ألوان الإرسالية #{order.id}</h2>
    <p className="mb-3 text-sm text-slate-600">التعديل يخص مناطق الأسنان فقط؛ اللون العام السابق يبقى محفوظًا كما هو. بعد الحفظ أعد إصدار الاستمارة للمعمل.</p>
    {order.shadeSpecificationWarning && <p role="alert">{order.shadeSpecificationWarning}</p>}
    <LabShadeSelector value={value} onChange={setValue} selectedTeeth={selected}
      globalShade={order.shade ?? ""} onGlobalShadeChange={() => {}} globalShadeReadOnly disabled={busy || !!order.shadeSpecificationWarning} />
    {error && <p role="alert" className="my-3 text-sm text-red-700">{error}</p>}
    <div className="mt-4 flex gap-2">
      <button type="button" disabled={busy || !!order.shadeSpecificationWarning} onClick={() => void save()}
        className="rounded-lg bg-navy-900 px-4 py-2 text-white disabled:opacity-50">{busy ? "جارٍ الحفظ…" : "حفظ تفاصيل الألوان"}</button>
      <button type="button" disabled={busy} onClick={onClose} className="rounded-lg border px-4 py-2">إلغاء وإغلاق</button>
    </div>
  </dialog>;
}
