"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, GripVertical, Plus, Trash2 } from "lucide-react";
import {
  MAX_ANNOUNCEMENTS_COUNT,
  MAX_ANNOUNCEMENT_BODY_LENGTH,
  MAX_ANNOUNCEMENT_TITLE_LENGTH,
} from "@/lib/waiting-room";

/**
 * إدارة إعلانات شاشة الصالة — قائمةٌ حيّة لا خانةٌ واحدة.
 *
 * الخانة النصية الواحدة كانت تجبر من يريد عشرين إعلانًا على حشرها كلها في
 * أربعمئة حرف (فيردّ عليه النظام: «القيمة طويلة أكثر من اللازم»)، ولا سبيل
 * فيها لتعطيل إعلانٍ واحد أو ترتيبه إلا بإعادة كتابة كل شيء. هنا كل إعلانٍ
 * سجلٌّ مستقل: عنوانه ونصّه وحدوده الخاصة، وتفعيله يُقلب بضغطة، وترتيبه
 * يُسحب بالإصبع، وحذفه يسأل قبل أن يقع.
 */

interface AnnouncementRecord {
  id: number;
  title: string;
  body: string;
  sortOrder: number;
  isActive: boolean;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Draft {
  key: string;
  title: string;
  body: string;
}

const formatStamp = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("ar-YE-u-nu-latn", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
};

/** عدّاد الأحرف — ينبّه قرب الحدّ ويصرخ عند تجاوزه قبل أن يرفض الخادم. */
function CharCounter({ value, limit }: { value: string; limit: number }) {
  const count = value.length;
  const near = count >= Math.floor(limit * 0.85) && count <= limit;
  const over = count > limit;
  return (
    <span
      className={`text-[10px] font-bold tabular-nums ${
        over ? "text-red-600" : near ? "text-amber-600" : "text-slate-400"
      }`}
    >
      {count} / {limit}
      {over ? " — تجاوزت الحد" : near ? " — اقتربت من الحد" : ""}
    </span>
  );
}

const inputClass =
  "w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand-blue";

export function AnnouncementsManager() {
  const [records, setRecords] = useState<AnnouncementRecord[]>([]);
  const [edits, setEdits] = useState<Record<number, { title: string; body: string }>>({});
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const [dragId, setDragId] = useState<number | null>(null);
  const [dropTargetId, setDropTargetId] = useState<number | null>(null);
  const [armedDrag, setArmedDrag] = useState<number | null>(null);
  const draftCounter = useRef(0);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flash = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 2500);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/settings/display/announcements", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر تحميل الإعلانات.");
      setRecords((payload?.announcements ?? []) as AnnouncementRecord[]);
      setEdits({});
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "تعذّر تحميل الإعلانات.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    };
  }, [load]);

  const activeCount = useMemo(() => records.filter((item) => item.isActive).length, [records]);
  const atCap = records.length + drafts.length >= MAX_ANNOUNCEMENTS_COUNT;

  const request = useCallback(
    async (url: string, init: RequestInit): Promise<{ ok: boolean; payload: Record<string, unknown> | null }> => {
      const response = await fetch(url, init);
      const payload = await response.json().catch(() => null);
      return { ok: response.ok, payload };
    },
    [],
  );

  // ── الإضافة: مسودة محلية تُحفظ بالزر ────────────────────────────────────
  const addDraft = () => {
    draftCounter.current += 1;
    setDrafts((current) => [...current, { key: `draft-${draftCounter.current}`, title: "", body: "" }]);
  };

  const patchDraft = (key: string, patch: Partial<Draft>) => {
    setDrafts((current) => current.map((item) => (item.key === key ? { ...item, ...patch } : item)));
  };

  const removeDraft = (key: string) => {
    setDrafts((current) => current.filter((item) => item.key !== key));
    setConfirmKey(null);
  };

  const saveDraft = async (draft: Draft) => {
    if (busy) return;
    setBusy(`draft:${draft.key}`);
    setError(null);
    try {
      const { ok, payload } = await request("/api/settings/display/announcements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: draft.title, body: draft.body }),
      });
      if (!ok || !payload?.announcement) {
        throw new Error((payload?.message as string) ?? "تعذّر إضافة الإعلان.");
      }
      setRecords((current) => [...current, payload.announcement as AnnouncementRecord]);
      setDrafts((current) => current.filter((item) => item.key !== draft.key));
      flash("أُضيف الإعلان ✓");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "تعذّر إضافة الإعلان.");
    } finally {
      setBusy(null);
    }
  };

  // ── التعديل: كل إعلانٍ وحده ─────────────────────────────────────────────
  const editValue = (record: AnnouncementRecord) =>
    edits[record.id] ?? { title: record.title, body: record.body };

  const setEdit = (id: number, patch: Partial<{ title: string; body: string }>) => {
    setEdits((current) => {
      const base = current[id] ?? records.find((item) => item.id === id);
      if (!base) return current;
      return { ...current, [id]: { ...base, ...patch } };
    });
  };

  const isDirty = (record: AnnouncementRecord) => {
    const edit = edits[record.id];
    if (!edit) return false;
    return edit.title !== record.title || edit.body !== record.body;
  };

  const saveRecord = async (record: AnnouncementRecord) => {
    const edit = edits[record.id];
    if (!edit || busy) return;
    setBusy(`save:${record.id}`);
    setError(null);
    try {
      const { ok, payload } = await request(`/api/settings/display/announcements/${record.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: edit.title, body: edit.body }),
      });
      if (!ok || !payload?.announcement) {
        throw new Error((payload?.message as string) ?? "تعذّر حفظ التعديل.");
      }
      setRecords((current) =>
        current.map((item) => (item.id === record.id ? (payload.announcement as AnnouncementRecord) : item)),
      );
      setEdits((current) => {
        const next = { ...current };
        delete next[record.id];
        return next;
      });
      flash("حُفظ الإعلان ✓");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "تعذّر حفظ التعديل.");
    } finally {
      setBusy(null);
    }
  };

  const toggleActive = async (record: AnnouncementRecord) => {
    if (busy) return;
    setBusy(`toggle:${record.id}`);
    setError(null);
    try {
      const { ok, payload } = await request(`/api/settings/display/announcements/${record.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !record.isActive }),
      });
      if (!ok || !payload?.announcement) {
        throw new Error((payload?.message as string) ?? "تعذّر تغيير الحالة.");
      }
      setRecords((current) =>
        current.map((item) => (item.id === record.id ? (payload.announcement as AnnouncementRecord) : item)),
      );
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : "تعذّر تغيير الحالة.");
    } finally {
      setBusy(null);
    }
  };

  const removeRecord = async (record: AnnouncementRecord) => {
    if (busy) return;
    setBusy(`delete:${record.id}`);
    setError(null);
    try {
      const { ok, payload } = await request(`/api/settings/display/announcements/${record.id}`, {
        method: "DELETE",
      });
      // 404 يعني «حُذف من نافذة أخرى»: الهدف نفسه — إزالته من القائمة هنا.
      if (!ok && payload?.message && !String(payload.message).includes("غير موجود")) {
        throw new Error(payload.message as string);
      }
      setRecords((current) => current.filter((item) => item.id !== record.id));
      setConfirmKey(null);
      flash("حُذف الإعلان ✓");
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "تعذّر حذف الإعلان.");
    } finally {
      setBusy(null);
    }
  };

  // ── الترتيب: سحبٌ وإفلات، وأزرارٌ لمن لا سحب عنده ──────────────────────
  const commitOrder = async (next: AnnouncementRecord[]) => {
    if (busy) return;
    const previous = records;
    setRecords(next);
    setBusy("reorder");
    setError(null);
    try {
      const { ok, payload } = await request("/api/settings/display/announcements/reorder", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: next.map((item) => item.id) }),
      });
      if (!ok) {
        throw new Error((payload?.message as string) ?? "تعذّر حفظ الترتيب.");
      }
      if (Array.isArray(payload?.announcements)) {
        setRecords(payload.announcements as AnnouncementRecord[]);
      }
    } catch (orderError) {
      setRecords(previous); // الترتيب القديم يعود — الخادم لم يشهد الجديد.
      setError(orderError instanceof Error ? orderError.message : "تعذّر حفظ الترتيب.");
    } finally {
      setBusy(null);
    }
  };

  const moveTo = (draggedId: number, targetId: number) => {
    if (draggedId === targetId) return;
    const next = [...records];
    const from = next.findIndex((item) => item.id === draggedId);
    const to = next.findIndex((item) => item.id === targetId);
    if (from === -1 || to === -1) return;
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    void commitOrder(next);
  };

  const moveBy = (id: number, offset: number) => {
    const next = [...records];
    const index = next.findIndex((item) => item.id === id);
    const target = index + offset;
    if (index === -1 || target < 0 || target >= next.length) return;
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved!);
    void commitOrder(next);
  };

  const clearDrag = () => {
    setDragId(null);
    setDropTargetId(null);
    setArmedDrag(null);
  };

  return (
    <div className="border-t border-slate-100 pt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-black text-navy-900">
            الإعلانات المتناوبة
            {records.length > 0 ? (
              <span className="ms-2 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-bold text-slate-600 tabular-nums">
                {records.length} إعلانًا · {activeCount} مفعّلًا
              </span>
            ) : null}
          </h3>
          <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
            شاشة الصالة تعرض المفعّل منها فقط، بهذا الترتيب من الأعلى، وتتناوب عليها كل ١٥ ثانية.
            {records.length === 0 && drafts.length === 0
              ? " لا إعلانات بعد — تُعرض النصوص الافتراضية حتى تضيف أول إعلان."
              : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={addDraft}
          disabled={atCap}
          className="flex items-center gap-1.5 rounded-xl bg-brand-orange px-4 py-2 text-xs font-extrabold text-white shadow-xs hover:opacity-90 disabled:opacity-40"
        >
          <Plus className="h-4 w-4" aria-hidden />
          إضافة إعلان
        </button>
      </div>

      {error ? (
        <p role="alert" className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-bold text-red-700">
          {error}
        </p>
      ) : notice ? (
        <p role="status" className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-700">
          {notice}
        </p>
      ) : null}

      {loading ? (
        <p className="mt-4 rounded-xl bg-slate-50 px-4 py-6 text-center text-sm text-slate-400">
          جارٍ تحميل الإعلانات…
        </p>
      ) : (
        <div role="list" className="mt-4 space-y-3">
          {records.map((record, index) => {
            const edit = editValue(record);
            const dirty = isDirty(record);
            const saveBusy = busy === `save:${record.id}`;
            const toggleBusy = busy === `toggle:${record.id}`;
            const deleteBusy = busy === `delete:${record.id}`;
            const confirming = confirmKey === `id:${record.id}`;
            return (
              <article
                key={record.id}
                role="listitem"
                draggable={armedDrag === record.id}
                onDragStart={(event) => {
                  setDragId(record.id);
                  event.dataTransfer.effectAllowed = "move";
                }}
                onDragEnd={clearDrag}
                onDragOver={(event) => {
                  if (dragId === null || dragId === record.id) return;
                  event.preventDefault();
                  setDropTargetId(record.id);
                }}
                onDragLeave={() => {
                  if (dropTargetId === record.id) setDropTargetId(null);
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  if (dragId !== null) moveTo(dragId, record.id);
                  clearDrag();
                }}
                className={`rounded-2xl border p-3 transition-shadow ${
                  record.isActive ? "border-slate-200 bg-white" : "border-slate-200 bg-slate-50/70"
                } ${dropTargetId === record.id ? "ring-2 ring-brand-blue" : ""} ${
                  dragId === record.id ? "opacity-60" : ""
                }`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    title="اسحب لإعادة الترتيب"
                    aria-label={`اسحب الإعلان رقم ${index + 1} لإعادة ترتيبه`}
                    onMouseDown={() => setArmedDrag(record.id)}
                    onMouseUp={() => setArmedDrag(null)}
                    onTouchStart={() => setArmedDrag(record.id)}
                    onTouchEnd={() => setArmedDrag(null)}
                    className="cursor-grab touch-none rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 active:cursor-grabbing"
                  >
                    <GripVertical className="h-4 w-4" aria-hidden />
                  </button>
                  <span className="w-6 text-center text-xs font-black text-slate-400 tabular-nums" title="الترتيب">
                    {index + 1}
                  </span>
                  <button
                    type="button"
                    onClick={() => void toggleActive(record)}
                    disabled={toggleBusy}
                    aria-pressed={record.isActive}
                    className={`rounded-xl border px-3 py-1.5 text-[11px] font-bold disabled:opacity-50 ${
                      record.isActive
                        ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                        : "border-slate-200 bg-white text-slate-500"
                    }`}
                  >
                    {toggleBusy ? "…" : record.isActive ? "مفعّل" : "معطّل"}
                  </button>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => moveBy(record.id, -1)}
                      disabled={index === 0 || busy === "reorder"}
                      aria-label="تحريك الإعلان للأعلى"
                      className="rounded-lg border border-slate-200 p-1.5 text-slate-500 hover:bg-slate-50 disabled:opacity-30"
                    >
                      <ArrowUp className="h-3.5 w-3.5" aria-hidden />
                    </button>
                    <button
                      type="button"
                      onClick={() => moveBy(record.id, 1)}
                      disabled={index === records.length - 1 || busy === "reorder"}
                      aria-label="تحريك الإعلان للأسفل"
                      className="rounded-lg border border-slate-200 p-1.5 text-slate-500 hover:bg-slate-50 disabled:opacity-30"
                    >
                      <ArrowDown className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  </div>
                  <span className="ms-auto text-[10px] leading-relaxed text-slate-400">
                    آخر تعديل: {formatStamp(record.updatedAt)}
                    {record.updatedBy ? ` — بواسطة ${record.updatedBy}` : ""}
                  </span>
                </div>

                <label className="mt-2 block">
                  <span className="mb-1 flex items-center justify-between">
                    <span className="text-[11px] font-bold text-slate-500">العنوان</span>
                    <CharCounter value={edit.title} limit={MAX_ANNOUNCEMENT_TITLE_LENGTH} />
                  </span>
                  <input
                    type="text"
                    value={edit.title}
                    maxLength={MAX_ANNOUNCEMENT_TITLE_LENGTH}
                    onChange={(event) => setEdit(record.id, { title: event.target.value })}
                    className={inputClass}
                    dir="rtl"
                  />
                </label>
                <label className="mt-2 block">
                  <span className="mb-1 flex items-center justify-between">
                    <span className="text-[11px] font-bold text-slate-500">النص</span>
                    <CharCounter value={edit.body} limit={MAX_ANNOUNCEMENT_BODY_LENGTH} />
                  </span>
                  <textarea
                    rows={2}
                    value={edit.body}
                    maxLength={MAX_ANNOUNCEMENT_BODY_LENGTH}
                    onChange={(event) => setEdit(record.id, { body: event.target.value })}
                    className={`${inputClass} resize-y`}
                    dir="rtl"
                  />
                </label>

                {confirming ? (
                  <div className="mt-2 flex flex-wrap items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2">
                    <span className="text-[11px] font-bold text-red-700">
                      حذف «{record.title}» نهائيًا من شاشة الصالة؟
                    </span>
                    <button
                      type="button"
                      onClick={() => void removeRecord(record)}
                      disabled={deleteBusy}
                      className="rounded-lg bg-red-600 px-3 py-1.5 text-[11px] font-bold text-white disabled:opacity-50"
                    >
                      {deleteBusy ? "جارٍ الحذف…" : "نعم، احذف"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmKey(null)}
                      className="rounded-lg border border-red-200 bg-white px-3 py-1.5 text-[11px] font-bold text-red-600"
                    >
                      إلغاء
                    </button>
                  </div>
                ) : (
                  <div className="mt-2 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void saveRecord(record)}
                      disabled={!dirty || saveBusy || busy === "reorder"}
                      className="rounded-xl bg-brand-blue px-5 py-1.5 text-xs font-extrabold text-white disabled:opacity-40"
                    >
                      {saveBusy ? "جارٍ الحفظ…" : "حفظ"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmKey(`id:${record.id}`)}
                      className="flex items-center gap-1 rounded-xl border border-red-200 px-3 py-1.5 text-xs font-bold text-red-600 hover:bg-red-50"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                      حذف
                    </button>
                    {dirty ? (
                      <button
                        type="button"
                        onClick={() =>
                          setEdits((current) => {
                            const next = { ...current };
                            delete next[record.id];
                            return next;
                          })
                        }
                        className="rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-bold text-slate-500 hover:bg-slate-50"
                      >
                        تراجع
                      </button>
                    ) : null}
                  </div>
                )}
              </article>
            );
          })}

          {drafts.map((draft) => {
            const saving = busy === `draft:${draft.key}`;
            const confirming = confirmKey === draft.key;
            const valid =
              draft.title.trim().length > 0 &&
              draft.body.trim().length > 0 &&
              draft.title.length <= MAX_ANNOUNCEMENT_TITLE_LENGTH &&
              draft.body.length <= MAX_ANNOUNCEMENT_BODY_LENGTH;
            return (
              <article
                key={draft.key}
                role="listitem"
                className="rounded-2xl border-2 border-dashed border-brand-orange/50 bg-brand-orange/5 p-3"
              >
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-black text-brand-orange">إعلان جديد — لم يُحفظ بعد</span>
                  {confirming ? (
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => removeDraft(draft.key)}
                        className="rounded-lg bg-red-600 px-3 py-1 text-[11px] font-bold text-white"
                      >
                        نعم، أزِله
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmKey(null)}
                        className="rounded-lg border border-slate-200 bg-white px-3 py-1 text-[11px] font-bold text-slate-500"
                      >
                        إلغاء
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmKey(draft.key)}
                      className="rounded-lg border border-red-200 px-2.5 py-1 text-[11px] font-bold text-red-600 hover:bg-red-50"
                    >
                      إزالة
                    </button>
                  )}
                </div>
                <label className="mt-2 block">
                  <span className="mb-1 flex items-center justify-between">
                    <span className="text-[11px] font-bold text-slate-500">العنوان</span>
                    <CharCounter value={draft.title} limit={MAX_ANNOUNCEMENT_TITLE_LENGTH} />
                  </span>
                  <input
                    type="text"
                    value={draft.title}
                    maxLength={MAX_ANNOUNCEMENT_TITLE_LENGTH}
                    onChange={(event) => patchDraft(draft.key, { title: event.target.value })}
                    className={inputClass}
                    dir="rtl"
                    placeholder="مثال: العناية بعد التقويم"
                  />
                </label>
                <label className="mt-2 block">
                  <span className="mb-1 flex items-center justify-between">
                    <span className="text-[11px] font-bold text-slate-500">النص</span>
                    <CharCounter value={draft.body} limit={MAX_ANNOUNCEMENT_BODY_LENGTH} />
                  </span>
                  <textarea
                    rows={2}
                    value={draft.body}
                    maxLength={MAX_ANNOUNCEMENT_BODY_LENGTH}
                    onChange={(event) => patchDraft(draft.key, { body: event.target.value })}
                    className={`${inputClass} resize-y`}
                    dir="rtl"
                    placeholder="مثال: الالتزام بالمطاط حسب تعليمات الطبيب يسرّع تقدم العلاج."
                  />
                </label>
                <button
                  type="button"
                  onClick={() => void saveDraft(draft)}
                  disabled={!valid || saving}
                  className="mt-2 rounded-xl bg-brand-orange px-5 py-1.5 text-xs font-extrabold text-white disabled:opacity-40"
                >
                  {saving ? "جارٍ الحفظ…" : "حفظ الإعلان الجديد"}
                </button>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
