"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

interface MaterialLine {
  id: number;
  itemId: number;
  itemName: string;
  unit: string;
  qty: number;
  source: "auto" | "manual";
  reason: string | null;
  createdBy: string;
}

interface StockItem {
  id: number;
  name: string;
  unit: string;
  balance: number;
  isActive: boolean;
}

function formatQty(qty: number): string {
  return Number.isInteger(qty) ? String(qty) : qty.toFixed(2).replace(/\.?0+$/, "");
}

/**
 * (P4) المواد المصروفة على الزيارة — قسمٌ واحد يجمع:
 *  أ) ما خُصم تلقائيًا من ربط الخدمات بالمواد عند التوقيع،
 *  ب) ما أضافه الطبيب يدويًا لهذه الزيارة (كمية إضافية أو مادة غير مربوطة).
 * الإضافة اليدوية حركة صرف عادية عبر `POST /api/inventory/[id]/movements` بـ visitId —
 * الخادم يربطها بمريض الزيارة، ويرفض الصرف فوق الرصيد، ويسجّلها في التدقيق.
 */
export function VisitMaterials({ visitId, canAdd }: { visitId: number; canAdd: boolean }) {
  const [lines, setLines] = useState<MaterialLine[]>([]);
  const [patientId, setPatientId] = useState<number | null>(null);
  const [items, setItems] = useState<StockItem[]>([]);
  const [open, setOpen] = useState(false);
  const [itemId, setItemId] = useState("");
  const [qty, setQty] = useState("1");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/visits/${visitId}/materials`, { cache: "no-store" });
      const payload = await response.json().catch(() => null);
      if (!response.ok) return;
      setLines(Array.isArray(payload?.lines) ? payload.lines : []);
      setPatientId(typeof payload?.patientId === "number" ? payload.patientId : null);
    } catch {
      // القسم إضافي — تعذّر تحميله لا يعطّل الزيارة.
    }
  }, [visitId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!open || items.length > 0) return;
    void (async () => {
      try {
        const response = await fetch("/api/inventory", { cache: "no-store" });
        if (!response.ok) return;
        const payload = await response.json();
        setItems((payload.items ?? []) as StockItem[]);
      } catch {
        setError("تعذّر تحميل بنود المخزون.");
      }
    })();
  }, [open, items.length]);

  const activeItems = useMemo(() => items.filter((item) => item.isActive), [items]);
  const selected = activeItems.find((item) => item.id === Number(itemId)) ?? null;
  const auto = lines.filter((line) => line.source === "auto");
  const manual = lines.filter((line) => line.source === "manual");

  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || !selected) return;
    const amount = Number(qty);
    if (!Number.isFinite(amount) || amount <= 0) {
      setError("اكتب كمية أكبر من صفر.");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/inventory/${selected.id}/movements`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "out",
          qty: amount,
          visitId,
          patientId,
          reason: note.trim() ? `استهلاك إضافي في الزيارة — ${note.trim()}` : "استهلاك إضافي في الزيارة",
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.message ?? "تعذّر تسجيل الصرف.");
        return;
      }
      setNotice(`تم صرف ${formatQty(amount)} ${selected.unit} من ${selected.name} لهذه الزيارة.`);
      setItems((current) => current.map((item) => item.id === selected.id
        ? { ...item, balance: typeof payload?.balance === "number" ? payload.balance : item.balance - amount } : item));
      setQty("1");
      setNote("");
      setOpen(false);
      await load();
    } catch {
      setError("تعذّر الاتصال بالخادم.");
    } finally {
      setBusy(false);
    }
  };

  const row = (line: MaterialLine) => (
    <li key={line.id} className="flex items-center justify-between gap-2 py-1.5">
      <span className="min-w-0 truncate text-xs font-bold text-slate-700">{line.itemName}</span>
      <span className="shrink-0 text-xs font-extrabold text-navy-900">{formatQty(line.qty)} {line.unit}</span>
    </li>
  );

  return (
    <section className="mb-4 rounded-2xl border border-slate-200 bg-white p-3" aria-label="المواد المصروفة">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-sm font-bold text-navy-900">المواد المصروفة</h3>
        {canAdd ? (
          <button type="button" onClick={() => { setOpen((value) => !value); setError(null); }}
            className="rounded-xl border border-navy-800 bg-white px-3 py-1.5 text-[11px] font-black text-navy-800">
            {open ? "إغلاق" : "+ مادة إضافية"}
          </button>
        ) : null}
      </div>

      {notice ? <p className="mb-2 rounded-lg bg-emerald-50 px-3 py-2 text-[11px] font-bold text-emerald-800">{notice}</p> : null}

      <div className="grid gap-2 sm:grid-cols-2">
        <div className="rounded-xl bg-slate-50 px-3 py-2">
          <p className="text-[10px] font-black text-slate-500">تلقائيًا من الخدمات (عند التوقيع)</p>
          {auto.length > 0 ? <ul className="divide-y divide-slate-100">{auto.map(row)}</ul>
            : <p className="py-1 text-[11px] text-slate-400">لا شيء بعد.</p>}
        </div>
        <div className="rounded-xl bg-sky-50/60 px-3 py-2">
          <p className="text-[10px] font-black text-sky-800">أُضيفت يدويًا لهذه الزيارة</p>
          {manual.length > 0 ? <ul className="divide-y divide-sky-100">{manual.map(row)}</ul>
            : <p className="py-1 text-[11px] text-slate-400">لا شيء.</p>}
        </div>
      </div>

      {open ? (
        <form onSubmit={add} className="mt-3 space-y-2 rounded-xl border border-sky-200 bg-sky-50/40 p-3">
          <p className="text-[10px] font-semibold leading-4 text-slate-500">
            للكمية الإضافية أو المادة غير المربوطة بالخدمة — مواد الخدمات تُخصم تلقائيًا عند التوقيع فلا تكرّرها.
          </p>
          <select value={itemId} onChange={(event) => setItemId(event.target.value)} aria-label="المادة"
            className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm">
            <option value="">— اختر المادة —</option>
            {activeItems.map((item) => (
              <option key={item.id} value={item.id} disabled={item.balance <= 0}>
                {item.name} · المتاح {formatQty(item.balance)} {item.unit}
              </option>
            ))}
          </select>
          <div className="grid grid-cols-3 gap-2">
            <input value={qty} onChange={(event) => setQty(event.target.value)} inputMode="decimal" dir="ltr"
              aria-label="الكمية" className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-bold" />
            <input value={note} onChange={(event) => setNote(event.target.value)} maxLength={200}
              placeholder="ملاحظة (اختياري)" aria-label="ملاحظة الصرف"
              className="col-span-2 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm" />
          </div>
          {error ? <p className="rounded-lg bg-rose-50 px-3 py-2 text-[11px] font-bold text-rose-700">{error}</p> : null}
          <button type="submit" disabled={busy || !selected}
            className="w-full rounded-xl bg-navy-900 py-2.5 text-sm font-extrabold text-white disabled:opacity-40">
            {busy ? "جارٍ الصرف…" : selected ? `صرف لهذه الزيارة — ${selected.name}` : "اختر المادة"}
          </button>
        </form>
      ) : null}
    </section>
  );
}
