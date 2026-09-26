"use client";

import { useCallback, useEffect, useState } from "react";
import { useSession } from "@/components/SessionProvider";

interface SavedReportItem {
  id: number;
  name: string;
  reportId: string;
  sectionId: string;
  queryString: string;
  isFavorite: boolean;
  isShared: boolean;
  owned: boolean;
  ownerUsername: string;
}

interface TemplateItem {
  key: string;
  name: string;
  reportId: string;
  sectionId: string;
  queryString: string;
}

async function payload(response: Response): Promise<Record<string, unknown>> {
  return response.json().catch(() => ({})) as Promise<Record<string, unknown>>;
}

function reportHref(sectionId: string, queryString: string): string {
  return `/reports?section=${encodeURIComponent(sectionId)}&${queryString}`;
}

/**
 * (Reports R3) التقارير المحفوظة والمفضلة والقوالب.
 *
 * العرض المحفوظ رابطُ فلاتر وأعمدة وترتيب وتجميع — لا بيانات. فتحه يعيد طلب
 * التقرير من الخادم الذي يفرض الصلاحية؛ والقالب المشترك لا يتجاوزها.
 */
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
  const session = useSession();
  const readOnly = session?.role === "accountant";
  const [saved, setSaved] = useState<SavedReportItem[]>([]);
  const [templates, setTemplates] = useState<TemplateItem[]>([]);
  const [canShare, setCanShare] = useState(false);
  const [name, setName] = useState("");
  const [shareNew, setShareNew] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [menuFor, setMenuFor] = useState<number | null>(null);
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch("/api/reports/saved", { cache: "no-store" });
    if (!response.ok) return;
    const data = await payload(response);
    setSaved(Array.isArray(data.saved) ? data.saved as SavedReportItem[] : []);
    setTemplates(Array.isArray(data.templates) ? data.templates as TemplateItem[] : []);
    setCanShare(data.canShare === true);
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function request(method: string, body?: Record<string, unknown>, query = ""): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/reports/saved${query}`, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await payload(response);
      if (!response.ok) {
        setMessage(String(data.message ?? "تعذّر تنفيذ العملية."));
        return false;
      }
      await load();
      return true;
    } catch {
      setMessage("تعذّر الاتصال بالخادم.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function saveCurrent() {
    const ok = await request("POST", {
      name: name.trim() || currentName,
      reportId,
      sectionId,
      queryString,
      isShared: canShare && shareNew,
    });
    if (ok) {
      setName("");
      setShareNew(false);
      setOpen(false);
      setMessage("تم حفظ التقرير.");
    }
  }

  async function rename() {
    if (!renaming) return;
    const ok = await request("PATCH", { id: renaming.id, name: renaming.name });
    if (ok) {
      setRenaming(null);
      setMenuFor(null);
    }
  }

  async function overwriteWithCurrent(item: SavedReportItem) {
    if (!window.confirm(`استبدال فلاتر وعرض «${item.name}» بالعرض الحالي؟`)) return;
    const ok = await request("PATCH", { id: item.id, reportId, sectionId, queryString });
    if (ok) {
      setMenuFor(null);
      setMessage(`حُدّث «${item.name}» بالعرض الحالي.`);
    }
  }

  async function duplicate(item: SavedReportItem) {
    const ok = await request("POST", { duplicateOf: item.id });
    if (ok) {
      setMenuFor(null);
      setMessage(`نُسخ «${item.name}» إلى تقاريرك.`);
    }
  }

  async function remove(item: SavedReportItem) {
    if (!window.confirm(`حذف العرض المحفوظ «${item.name}»؟ لا تُحذف أي بيانات.`)) return;
    const ok = await request("DELETE", undefined, `?id=${item.id}`);
    if (ok) setMenuFor(null);
  }

  async function copyCurrentLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setMessage("تم نسخ رابط التقرير بفلاتره وعرضه.");
    } catch {
      setMessage("تعذّر نسخ الرابط.");
    }
  }

  const actionClass = "rounded-lg border border-slate-200 bg-white px-2 py-1 text-[10px] font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-40";

  return (
    <section className="mb-4 rounded-2xl border border-slate-200 bg-white p-3 shadow-xs print:hidden" aria-label="التقارير المحفوظة">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-xs font-black text-navy-900">تقاريري المحفوظة</p>
          <p className="text-[10px] text-slate-500">احفظ التقرير بفلاتره وأعمدته وترتيبه وافتحه بنفس الصورة من أي جهاز.</p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => void copyCurrentLink()}
            className="rounded-xl border border-slate-200 px-3 py-1.5 text-[11px] font-bold text-slate-700 hover:bg-slate-50"
          >
            نسخ رابط التقرير
          </button>
          {!readOnly && <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            className="rounded-xl bg-navy-900 px-3 py-1.5 text-[11px] font-bold text-white hover:bg-navy-800"
          >
            + حفظ التقرير الحالي
          </button>}
        </div>
      </div>

      {!readOnly && open ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl bg-slate-50 p-2">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={80}
            placeholder={currentName}
            aria-label="اسم التقرير المحفوظ"
            className="min-w-[14rem] flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs outline-none focus:border-brand-blue"
          />
          {canShare ? (
            <label className="flex items-center gap-1.5 text-[11px] font-bold text-slate-600">
              <input type="checkbox" checked={shareNew} onChange={(event) => setShareNew(event.target.checked)} />
              قالب مشترك للطاقم
            </label>
          ) : null}
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

      {message ? <p className="mt-2 text-[10px] font-bold text-slate-600" role="status">{message}</p> : null}

      {saved.length > 0 ? (
        <ul className="mt-3 flex flex-wrap gap-1.5">
          {saved.map((item) => (
            <li key={item.id} className="rounded-xl border border-slate-200 bg-white">
              <div className="flex items-center">
                {item.owned && !readOnly ? (
                  <button
                    type="button"
                    title={item.isFavorite ? "إزالة من المفضلة" : "إضافة إلى المفضلة"}
                    onClick={() => void request("PATCH", { id: item.id, isFavorite: !item.isFavorite })}
                    className="px-2 py-1.5 text-sm leading-none text-warning-600"
                    aria-label={item.isFavorite ? `إزالة ${item.name} من المفضلة` : `إضافة ${item.name} إلى المفضلة`}
                  >
                    {item.isFavorite ? "★" : "☆"}
                  </button>
                ) : null}
                <a
                  href={reportHref(item.sectionId, item.queryString)}
                  className="max-w-[15rem] truncate px-2.5 py-1.5 text-[11px] font-bold text-navy-800 hover:bg-navy-50"
                  title={item.owned ? item.name : `${item.name} — قالب مشترك من ${item.ownerUsername}`}
                >
                  {item.name}
                </a>
                {item.isShared ? (
                  <span className="ml-1 rounded-md bg-navy-50 px-1.5 py-0.5 text-[9px] font-bold text-navy-700">مشترك</span>
                ) : null}
                {!readOnly && <button
                  type="button"
                  onClick={() => { setMenuFor(menuFor === item.id ? null : item.id); setRenaming(null); }}
                  className="border-r border-slate-100 px-2 py-1.5 text-[11px] font-bold text-slate-500 hover:text-navy-800"
                  aria-label={`خيارات ${item.name}`}
                  aria-expanded={menuFor === item.id}
                >
                  ⋯
                </button>}
              </div>
              {!readOnly && menuFor === item.id ? (
                <div className="flex flex-wrap items-center gap-1 border-t border-slate-100 p-1.5">
                  {item.owned && renaming?.id === item.id ? (
                    <>
                      <input
                        value={renaming.name}
                        onChange={(event) => setRenaming({ id: item.id, name: event.target.value })}
                        maxLength={80}
                        aria-label="الاسم الجديد"
                        className="w-40 rounded-lg border border-slate-200 px-2 py-1 text-[11px]"
                      />
                      <button type="button" disabled={busy} className={actionClass} onClick={() => void rename()}>حفظ الاسم</button>
                      <button type="button" className={actionClass} onClick={() => setRenaming(null)}>إلغاء</button>
                    </>
                  ) : (
                    <>
                      {item.owned ? (
                        <button type="button" className={actionClass} onClick={() => setRenaming({ id: item.id, name: item.name })}>إعادة تسمية</button>
                      ) : null}
                      <button type="button" disabled={busy} className={actionClass} onClick={() => void duplicate(item)}>نسخ وتعديل</button>
                      {item.owned ? (
                        <button type="button" disabled={busy} className={actionClass} onClick={() => void overwriteWithCurrent(item)}>تحديثه بالعرض الحالي</button>
                      ) : null}
                      {item.owned && canShare ? (
                        <button
                          type="button"
                          disabled={busy}
                          className={actionClass}
                          onClick={() => void request("PATCH", { id: item.id, isShared: !item.isShared })}
                        >
                          {item.isShared ? "إلغاء المشاركة" : "مشاركة كقالب"}
                        </button>
                      ) : null}
                      {item.owned ? (
                        <button type="button" disabled={busy} className={`${actionClass} text-danger-700`} onClick={() => void remove(item)}>حذف</button>
                      ) : null}
                    </>
                  )}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-[10px] text-slate-400">لا توجد تقارير محفوظة بعد.</p>
      )}

      {templates.length > 0 ? (
        <div className="mt-3 border-t border-slate-100 pt-2">
          <p className="mb-1.5 text-[10px] font-bold text-slate-500">قوالب جاهزة</p>
          <ul className="flex flex-wrap gap-1.5">
            {templates.map((template) => (
              <li key={template.key}>
                <a
                  href={reportHref(template.sectionId, template.queryString)}
                  className="block rounded-xl border border-dashed border-slate-300 px-2.5 py-1.5 text-[11px] font-bold text-slate-700 hover:border-brand-blue hover:text-brand-blue"
                >
                  {template.name}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
