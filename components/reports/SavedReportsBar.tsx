"use client";

import { useCallback, useEffect, useState } from "react";

interface SavedReportItem {
  id: number;
  name: string;
  reportId: string;
  sectionId: string;
  queryString: string;
  isFavorite: boolean;
}

async function payload(response: Response): Promise<Record<string, unknown>> {
  return response.json().catch(() => ({})) as Promise<Record<string, unknown>>;
}

export function SavedReportsBar({
  currentName,
  reportId,
  sectionId,
  queryString,
}: {
  currentName: string;
  reportId: string;
  sectionId: string;
  queryString: string;
}) {
  const [saved, setSaved] = useState<SavedReportItem[]>([]);
  const [name, setName] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch("/api/reports/saved", { cache: "no-store" });
    if (!response.ok) return;
    const data = await payload(response);
    setSaved(Array.isArray(data.saved) ? data.saved as SavedReportItem[] : []);
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function saveCurrent() {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/reports/saved", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim() || currentName,
          reportId,
          sectionId,
          queryString,
        }),
      });
      const data = await payload(response);
      if (!response.ok) throw new Error(String(data.message ?? "تعذّر حفظ التقرير."));
      setName("");
      setOpen(false);
      setMessage("تم حفظ التقرير.");
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "تعذّر حفظ التقرير.");
    } finally {
      setBusy(false);
    }
  }

  async function toggleFavorite(item: SavedReportItem) {
    const response = await fetch("/api/reports/saved", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: item.id, isFavorite: !item.isFavorite }),
    });
    if (response.ok) await load();
  }

  async function remove(item: SavedReportItem) {
    if (!window.confirm(`حذف التقرير المحفوظ «${item.name}»؟`)) return;
    const response = await fetch(`/api/reports/saved?id=${item.id}`, { method: "DELETE" });
    if (response.ok) await load();
  }

  async function copyCurrentLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setMessage("تم نسخ رابط التقرير بفلاتره.");
    } catch {
      setMessage("تعذّر نسخ الرابط.");
    }
  }

  return (
    <section className="mb-4 rounded-2xl border border-slate-200 bg-white p-3 shadow-xs print:hidden">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-xs font-black text-navy-900">تقاريري المحفوظة</p>
          <p className="text-[10px] text-slate-500">احفظ التقرير بفلاتره وافتحه بنفس الصورة من أي جهاز.</p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => void copyCurrentLink()}
            className="rounded-xl border border-slate-200 px-3 py-1.5 text-[11px] font-bold text-slate-700 hover:bg-slate-50"
          >
            نسخ رابط التقرير
          </button>
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            className="rounded-xl bg-navy-900 px-3 py-1.5 text-[11px] font-bold text-white hover:bg-navy-800"
          >
            + حفظ التقرير الحالي
          </button>
        </div>
      </div>

      {open ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl bg-slate-50 p-2">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={80}
            placeholder={currentName}
            aria-label="اسم التقرير المحفوظ"
            className="min-w-[14rem] flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs outline-none focus:border-brand-blue"
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => void saveCurrent()}
            className="rounded-xl bg-brand-blue px-4 py-2 text-xs font-black text-white disabled:opacity-50"
          >
            {busy ? "جارٍ الحفظ…" : "حفظ"}
          </button>
        </div>
      ) : null}

      {message ? <p className="mt-2 text-[10px] font-bold text-slate-600">{message}</p> : null}

      {saved.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {saved.map((item) => (
            <div key={item.id} className="flex items-center overflow-hidden rounded-xl border border-slate-200 bg-white">
              <button
                type="button"
                title={item.isFavorite ? "إزالة من المفضلة" : "إضافة إلى المفضلة"}
                onClick={() => void toggleFavorite(item)}
                className="px-2 py-1.5 text-sm leading-none"
                aria-label={item.isFavorite ? "إزالة من المفضلة" : "إضافة إلى المفضلة"}
              >
                {item.isFavorite ? "★" : "☆"}
              </button>
              <a
                href={`/reports?section=${encodeURIComponent(item.sectionId)}&${item.queryString}`}
                className="max-w-[15rem] truncate border-x border-slate-100 px-2.5 py-1.5 text-[11px] font-bold text-navy-800 hover:bg-navy-50"
                title={item.name}
              >
                {item.name}
              </a>
              <button
                type="button"
                onClick={() => void remove(item)}
                className="px-2 py-1.5 text-[10px] font-bold text-slate-400 hover:text-danger-700"
                aria-label={`حذف ${item.name}`}
                title="حذف"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-2 text-[10px] text-slate-400">لا توجد تقارير محفوظة بعد.</p>
      )}
    </section>
  );
}
