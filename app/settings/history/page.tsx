"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { Modal } from "@/components/Modal";
import {
  CATEGORY_LABEL,
  searchDefinitions,
  settingDefinition,
  visibleCategories,
  type SettingCategory,
} from "@/lib/settings-definitions";
import { roleCan } from "@/lib/settings-permissions";
import {
  canRestoreHistoryValue,
  formatSettingValue,
  historyActionLabel,
  secretStateLabel,
} from "@/lib/settings-ui";

interface HistoryEntry {
  id: string;
  action: string;
  key: string;
  category: string | null;
  before: string | null;
  after: string | null;
  secretState: string | null;
  reason: string | null;
  actor: string;
  actorRole: string | null;
  at: string;
}

interface Snapshot {
  values: Record<string, string>;
  versions: Record<string, string | null>;
}

interface RestoreState {
  entry: HistoryEntry;
  value: string;
  reason: string;
  version: string | null;
  conflict?: boolean;
}

const HISTORY_PAGE_SIZE = 50;

async function json(response: Response): Promise<Record<string, unknown>> {
  return response.json().catch(() => ({})) as Promise<Record<string, unknown>>;
}

function friendlyValue(entry: HistoryEntry, side: "before" | "after"): string {
  if (entry.secretState) return secretStateLabel(entry.secretState);
  const definition = settingDefinition(entry.key);
  const raw = side === "before" ? entry.before : entry.after;
  if (raw === null) return "—";
  return definition ? formatSettingValue(definition, raw) : raw;
}

export default function SettingsHistoryPage() {
  const categories = useMemo(() => visibleCategories(), []);
  const [role, setRole] = useState<string | null>(null);
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [snapshot, setSnapshot] = useState<Snapshot>({ values: {}, versions: {} });
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [restore, setRestore] = useState<RestoreState | null>(null);
  const [saving, setSaving] = useState(false);

  const [keyFilter, setKeyFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [actorFilter, setActorFilter] = useState("");
  const [fromFilter, setFromFilter] = useState("");
  const [toFilter, setToFilter] = useState("");
  const [actionFilter, setActionFilter] = useState("");
  const appliedParams = useRef("");

  const readSnapshot = useCallback(async (): Promise<Snapshot> => {
    const response = await fetch("/api/settings", { cache: "no-store" });
    const payload = await json(response);
    if (!response.ok) throw new Error(typeof payload.message === "string" ? payload.message : "تعذّر تحميل الإعدادات.");
    const values: Record<string, string> = {};
    for (const definition of searchDefinitions("")) {
      const value = payload[definition.key];
      if (typeof value === "string") values[definition.key] = value;
    }
    return {
      values,
      versions: payload.__versions && typeof payload.__versions === "object"
        ? payload.__versions as Record<string, string | null>
        : {},
    };
  }, []);

  const loadHistory = useCallback(async (beforeId?: string) => {
    if (beforeId) setLoadingMore(true);
    else setLoading(true);
    setError(null);
    try {
      const meResponse = await fetch("/api/auth/me", { cache: "no-store" });
      const me = await json(meResponse);
      const nextRole = typeof me.role === "string" ? me.role : null;
      setRole(nextRole);
      if (!meResponse.ok || !roleCan(nextRole, "settings.view_history")) {
        setEntries([]);
        setError("سجل تغييرات الإعدادات متاح للمدير المخوّل فقط.");
        return;
      }

      const params = new URLSearchParams({ limit: String(HISTORY_PAGE_SIZE + 1) });
      if (keyFilter) params.set("key", keyFilter);
      if (categoryFilter) params.set("category", categoryFilter);
      if (actorFilter.trim()) params.set("actor", actorFilter.trim());
      if (fromFilter) params.set("from", fromFilter);
      if (toFilter) params.set("to", toFilter);
      if (actionFilter) params.set("action", actionFilter);
      if (beforeId) {
        const previous = new URLSearchParams(appliedParams.current);
        for (const key of [...params.keys()]) params.delete(key);
        previous.forEach((value, key) => params.set(key, value));
        params.set("beforeId", beforeId);
      }

      const [historyResponse, nextSnapshot] = await Promise.all([
        fetch(`/api/settings/history?${params.toString()}`, { cache: "no-store" }),
        readSnapshot(),
      ]);
      const historyPayload = await historyResponse.json().catch(() => []) as unknown;
      if (!historyResponse.ok) {
        const objectPayload = historyPayload as Record<string, unknown>;
        throw new Error(typeof objectPayload.message === "string" ? objectPayload.message : "تعذّر تحميل السجل.");
      }
      const page = Array.isArray(historyPayload) ? historyPayload as HistoryEntry[] : [];
      if (!beforeId) appliedParams.current = params.toString();
      setHasMore(page.length > HISTORY_PAGE_SIZE);
      const visiblePage = page.slice(0, HISTORY_PAGE_SIZE);
      setEntries((current) => beforeId ? [...current, ...visiblePage] : visiblePage);
      setSnapshot(nextSnapshot);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "تعذّر تحميل السجل.");
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [actionFilter, actorFilter, categoryFilter, fromFilter, keyFilter, readSnapshot, toFilter]);

  useEffect(() => { void loadHistory(); /* load once; filters apply explicitly */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clearFilters = () => {
    setKeyFilter(""); setCategoryFilter(""); setActorFilter(""); setFromFilter(""); setToFilter(""); setActionFilter("");
  };

  const submitRestore = useCallback(async () => {
    if (!restore || saving || restore.conflict) return;
    const definition = settingDefinition(restore.entry.key);
    if (!canRestoreHistoryValue(definition, restore.value)) {
      setError("هذه القيمة غير مؤهلة للاستعادة.");
      return;
    }
    if (definition?.requiresReason && !restore.reason.trim()) {
      setError("اكتب سبب الاستعادة ليبقى القرار مفهومًا في سجل التدقيق.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          [restore.entry.key]: restore.value,
          __versions: { [restore.entry.key]: restore.version },
          __reason: restore.reason.trim(),
        }),
      });
      const payload = await json(response);
      if (response.status === 409) {
        setSnapshot(await readSnapshot());
        setRestore((current) => current ? { ...current, conflict: true } : current);
        setError("تغيّر الإعداد منذ فتح السجل. أعد مراجعة القيمة الحالية قبل الاستعادة.");
        return;
      }
      if (!response.ok) {
        setError(typeof payload.message === "string" ? payload.message : "تعذّرت الاستعادة.");
        return;
      }
      setRestore(null);
      setSuccess("استُعيدت القيمة بعملية جديدة؛ لم يُحذف أو يُعدّل أي سجل تاريخي.");
      await loadHistory();
    } catch {
      setError("تعذّر الاتصال بالخادم أثناء الاستعادة.");
    } finally {
      setSaving(false);
    }
  }, [loadHistory, readSnapshot, restore, saving]);

  const canView = roleCan(role, "settings.view_history");

  return (
    <main className="mx-auto max-w-7xl p-4 pb-16" dir="rtl">
      <PageHeader title="سجل تغييرات الإعدادات" subtitle="كل تغيير مركزي بقيمته قبل وبعد وفاعله وسببه — بلا أسرار خام" links={[
        { href: "/settings", label: "الإعدادات المركزية" },
        { href: "/settings/history", label: "سجل التغييرات", current: true },
        { href: "/settings/audit", label: "سجل التدقيق العام" },
      ]} />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Link href="/settings" className="text-sm font-bold text-brand-blue">‹ العودة إلى الإعدادات</Link>
        <p className="text-xs text-slate-500">تغييرات إعدادات المركز، من الأحدث إلى الأقدم.</p>
      </div>

      {error ? <div role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div> : null}
      {success ? <div role="status" className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{success}</div> : null}

      {canView ? (
        <section className="mb-4 rounded-2xl border border-slate-200 bg-white p-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
            <label className="text-xs font-bold text-slate-700">الإعداد
              <select aria-label="الإعداد" value={keyFilter} onChange={(event) => setKeyFilter(event.target.value)} className="mt-1 block w-full rounded-xl border border-slate-300 px-2 py-2 text-xs font-normal">
                <option value="">الكل</option>
                {searchDefinitions("").map((definition) => <option key={definition.key} value={definition.key}>{definition.label}</option>)}
              </select>
            </label>
            <label className="text-xs font-bold text-slate-700">الفئة
              <select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)} className="mt-1 block w-full rounded-xl border border-slate-300 px-2 py-2 text-xs font-normal">
                <option value="">الكل</option>
                {categories.map((category) => <option key={category} value={category}>{CATEGORY_LABEL[category]}</option>)}
              </select>
            </label>
            <label className="text-xs font-bold text-slate-700">الفاعل
              <input value={actorFilter} onChange={(event) => setActorFilter(event.target.value)} className="mt-1 block w-full rounded-xl border border-slate-300 px-2 py-2 text-xs font-normal" placeholder="اسم المستخدم" />
            </label>
            <label className="text-xs font-bold text-slate-700">من
              <input type="date" value={fromFilter} onChange={(event) => setFromFilter(event.target.value)} className="mt-1 block w-full rounded-xl border border-slate-300 px-2 py-2 text-xs font-normal" />
            </label>
            <label className="text-xs font-bold text-slate-700">إلى
              <input type="date" value={toFilter} onChange={(event) => setToFilter(event.target.value)} className="mt-1 block w-full rounded-xl border border-slate-300 px-2 py-2 text-xs font-normal" />
            </label>
            <label className="text-xs font-bold text-slate-700">الفعل
              <select aria-label="الفعل" value={actionFilter} onChange={(event) => setActionFilter(event.target.value)} className="mt-1 block w-full rounded-xl border border-slate-300 px-2 py-2 text-xs font-normal">
                <option value="">الكل</option>
                <option value="clinic_settings.update">تعديل</option>
                <option value="clinic_settings.reset">إعادة افتراضي</option>
                <option value="clinic_settings.secret.replace">استبدال سر</option>
                <option value="clinic_settings.secret.remove">إزالة سر</option>
              </select>
            </label>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" disabled={loading || loadingMore} onClick={() => void loadHistory()} className="rounded-xl bg-navy-950 px-4 py-2 text-xs font-black text-white disabled:opacity-50">تطبيق الفلاتر</button>
            <button type="button" disabled={loading || loadingMore} onClick={clearFilters} className="rounded-xl border border-slate-300 px-4 py-2 text-xs font-bold text-slate-700">مسح</button>
          </div>
        </section>
      ) : null}

      {loading ? <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">جارٍ تحميل السجل…</div>
        : canView && entries.length === 0 ? <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500">لا توجد تغييرات مطابقة. هذا ليس خطأً.</div>
        : canView ? (
          <section className="space-y-3">
            {entries.map((entry) => {
              const definition = settingDefinition(entry.key);
              const canRestore = canRestoreHistoryValue(definition, entry.before);
              return (
                <article key={entry.id} aria-label={definition?.label ?? entry.key} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-sm font-black text-navy-950">{definition?.label ?? entry.key}</h2>
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-700">{historyActionLabel(entry.action)}</span>
                        {entry.category && entry.category in CATEGORY_LABEL ? <span className="text-[10px] text-slate-400">{CATEGORY_LABEL[entry.category as SettingCategory]}</span> : null}
                      </div>
                      <p className="mt-1 text-[11px] text-slate-400"><span dir="ltr">{entry.key}</span> · {entry.actor}{entry.actorRole ? ` (${entry.actorRole})` : ""}</p>
                    </div>
                    <time className="text-xs text-slate-500" dateTime={entry.at}>{new Date(entry.at).toLocaleString("ar-YE")}</time>
                  </div>

                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    <div className="rounded-xl bg-slate-50 p-3"><p className="text-[10px] font-bold text-slate-400">قبل</p><p className="mt-1 text-sm font-black text-slate-800">{friendlyValue(entry, "before")}</p></div>
                    <div className="rounded-xl bg-blue-50/60 p-3"><p className="text-[10px] font-bold text-blue-500">بعد</p><p className="mt-1 text-sm font-black text-blue-900">{friendlyValue(entry, "after")}</p></div>
                  </div>
                  {entry.reason ? <p className="mt-3 rounded-xl border border-slate-100 px-3 py-2 text-xs text-slate-600"><strong>السبب:</strong> {entry.reason}</p> : null}
                  {canRestore ? <div className="mt-3 flex justify-end"><button type="button" onClick={() => { setError(null); setRestore({ entry, value: entry.before!, reason: "", version: snapshot.versions[entry.key] ?? null }); }} className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50">استعادة القيمة السابقة</button></div> : null}
                </article>
              );
            })}
            {hasMore ? <div className="flex justify-center pt-2"><button type="button" disabled={loadingMore} onClick={() => void loadHistory(entries.at(-1)?.id)} className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-xs font-bold text-slate-700 disabled:opacity-50">{loadingMore ? "جارٍ تحميل المزيد…" : "تحميل المزيد"}</button></div> : null}
          </section>
        ) : null}

      {restore ? (
        <Modal labelledBy="restore-title" busy={saving} onClose={() => setRestore(null)}>
          <section className="my-auto max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-5 shadow-2xl">
            <h2 id="restore-title" className="text-lg font-black text-navy-950">استعادة قيمة سابقة</h2>
            {error ? <p role="alert" className="mt-3 rounded-xl bg-red-50 p-3 text-sm text-red-800">{error}</p> : null}
            {restore.conflict ? <p className="mt-3 text-sm">القيمة الحالية: {formatSettingValue(settingDefinition(restore.entry.key)!, snapshot.values[restore.entry.key])}. أغلق النافذة وأعد اختيار الاستعادة بعد المراجعة.</p> : null}
            <p className="mt-2 text-sm text-slate-600">سيُنشأ تغيير جديد للإعداد <strong>{settingDefinition(restore.entry.key)?.label ?? restore.entry.key}</strong>. لن يُحذف أي حدث من السجل.</p>
            <div className="mt-3 rounded-xl bg-slate-50 p-3 text-sm"><span className="text-slate-500">القيمة المراد استعادتها:</span> <strong>{settingDefinition(restore.entry.key) ? formatSettingValue(settingDefinition(restore.entry.key)!, restore.value) : restore.value}</strong></div>
            {settingDefinition(restore.entry.key)?.impact ? <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900"><strong>الأثر:</strong> {settingDefinition(restore.entry.key)!.impact}</p> : null}
            <label htmlFor="restore-reason" className="mt-4 block text-xs font-bold text-slate-700">سبب الاستعادة ({settingDefinition(restore.entry.key)?.requiresReason ? "مطلوب" : "اختياري"})</label>
            <textarea id="restore-reason" autoFocus value={restore.reason} onChange={(event) => setRestore((current) => current ? { ...current, reason: event.target.value } : current)} rows={3} className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm" />
            <div className="mt-5 flex justify-end gap-2 border-t border-slate-100 pt-4"><button type="button" disabled={saving} onClick={() => setRestore(null)} className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-bold">إلغاء</button><button type="button" disabled={saving || restore.conflict || (settingDefinition(restore.entry.key)?.requiresReason && !restore.reason.trim())} onClick={() => void submitRestore()} className="rounded-xl bg-navy-950 px-4 py-2 text-sm font-black text-white disabled:opacity-50">{saving ? "جارٍ الاستعادة…" : "تأكيد الاستعادة"}</button></div>
          </section>
        </Modal>
      ) : null}
    </main>
  );
}
