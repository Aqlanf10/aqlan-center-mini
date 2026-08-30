"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AUDIT_LABEL, isSensitive, type AuditAction, type AuditEntry } from "@/lib/audit";
import { PageHeader } from "@/components/PageHeader";
import { Icon } from "@/components/Icon";
import { clinicDateString } from "@/lib/schedule";
import { friendlyDateLong } from "@/lib/reminders";

/**
 * سجل التدقيق.
 *
 * الشاشة التي تُفتح مرة في الشهر وتُغني عن جدال شهر. ولذلك تُصفّى قبل أن تُعرض:
 * سجلٌّ بألف سطر بلا تصفية لا يُقرأ، فلا يُراجَع، فلا يشهد.
 *
 * والحركات الحسّاسة مميّزة بلون — لا لأنها «مشبوهة»، بل لأنها ما يُسأل عنه أولًا:
 * إلغاء فاتورة، استرداد، قيد يدوي، تغيير إعداد، تنزيل نسخة كاملة.
 */

const RANGE_DAYS = [
  ["اليوم", 0], ["آخر ٧ أيام", 6], ["آخر ٣٠ يومًا", 29],
] as const;

const shiftDate = (date: string, days: number) => {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
};

export default function AuditPage() {
  const today = useMemo(() => clinicDateString(new Date(), "Asia/Aden"), []);
  const [from, setFrom] = useState(() => shiftDate(today, 6));
  const [to, setTo] = useState(today);
  const [action, setAction] = useState("");
  const [actor, setActor] = useState("");
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [actors, setActors] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ from, to });
      if (action) params.set("action", action);
      if (actor) params.set("actor", actor);
      const response = await fetch(`/api/audit?${params}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر التحميل.");
      setEntries(payload.entries as AuditEntry[]);
      setActors(payload.actors as string[]);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "تعذّر التحميل.");
    } finally {
      setLoading(false);
    }
  }, [from, to, action, actor]);

  useEffect(() => { void load(); }, [load]);

  const sensitiveCount = entries.filter((entry) => isSensitive(entry.action)).length;

  return (
    <main className="mx-auto max-w-4xl p-4 pb-24">
      <PageHeader
        title="سجل التدقيق"
        subtitle="من فعل ماذا ومتى — يُكتب ولا يُعدَّل ولا يُحذف"
        links={[
          { href: "/settings", label: "عام" },
          { href: "/settings/users", label: "المستخدمون والصلاحيات" },
          { href: "/settings/audit", label: "سجل التدقيق", current: true },
          { href: "/settings/export", label: "النسخ والتصدير" },
          { href: "/settings/ai", label: "الذكاء الاصطناعي" },
        ]}
      />

      {error ? (
        <p role="alert" className="mb-4 rounded-xl border border-danger-300 bg-danger-50 px-4 py-2 text-sm font-semibold text-danger-700">{error}</p>
      ) : null}

      <div className="mb-3 flex flex-wrap gap-1.5">
        {RANGE_DAYS.map(([label, days]) => {
          const start = shiftDate(today, days);
          const active = from === start && to === today;
          return (
            <button key={label} onClick={() => { setFrom(start); setTo(today); }}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${
                active ? "bg-navy-900 text-white" : "border border-slate-200 bg-white text-navy-800"
              }`}>
              {label}
            </button>
          );
        })}
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        <label className="min-w-[7rem] flex-1">
          <span className="mb-1 block text-[11px] font-bold text-slate-500">من</span>
          <input type="date" value={from} max={to} onChange={(event) => setFrom(event.target.value)}
            className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" />
        </label>
        <label className="min-w-[7rem] flex-1">
          <span className="mb-1 block text-[11px] font-bold text-slate-500">إلى</span>
          <input type="date" value={to} min={from} max={today} onChange={(event) => setTo(event.target.value)}
            className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" />
        </label>
        <label className="min-w-[9rem] flex-1">
          <span className="mb-1 block text-[11px] font-bold text-slate-500">الحركة</span>
          <select value={action} onChange={(event) => setAction(event.target.value)}
            className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm">
            <option value="">كل الحركات</option>
            {(Object.keys(AUDIT_LABEL) as AuditAction[]).map((key) => (
              <option key={key} value={key}>{AUDIT_LABEL[key]}</option>
            ))}
          </select>
        </label>
        <label className="min-w-[8rem] flex-1">
          <span className="mb-1 block text-[11px] font-bold text-slate-500">المستخدم</span>
          <select value={actor} onChange={(event) => setActor(event.target.value)}
            className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm">
            <option value="">الجميع</option>
            {actors.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
      </div>

      <p className="mb-3 text-[11px] font-bold text-slate-500">
        {entries.length} حركة{sensitiveCount > 0 ? ` · منها ${sensitiveCount} تستحقّ المراجعة` : ""}
      </p>

      {loading ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">جارٍ التحميل…</p>
      ) : entries.length === 0 ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">
          لا حركات في هذا المدى.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {entries.map((entry) => {
            const sensitive = isSensitive(entry.action);
            const open = openId === entry.id;
            return (
              <li key={entry.id} className={`rounded-xl border ${
                sensitive ? "border-warning-300 bg-warning-50" : "border-slate-200 bg-white"
              }`}>
                <button
                  onClick={() => setOpenId(open ? null : entry.id)}
                  className="flex w-full flex-wrap items-center gap-2 px-3 py-2.5 text-right"
                >
                  {sensitive ? <Icon name="alert" className="h-4 w-4 shrink-0 text-warning-700" /> : null}
                  <span className="text-xs font-bold text-navy-900">{entry.summary}</span>
                  <span className="text-[11px] font-semibold text-slate-500">{entry.actor}</span>
                  <span className="mr-auto text-[11px] font-semibold text-slate-400 ltr-nums">
                    {new Date(entry.createdAt).toLocaleString("ar", {
                      timeZone: "Asia/Aden", hour: "2-digit", minute: "2-digit",
                      day: "2-digit", month: "2-digit",
                    })}
                  </span>
                </button>
                {open && entry.details ? (
                  <dl className="border-t border-black/5 px-3 py-2 text-[11px]">
                    {Object.entries(entry.details).map(([key, value]) => (
                      <div key={key} className="flex justify-between gap-3 py-0.5">
                        <dt className="font-bold text-slate-500">{key.replace(/_/g, " ")}</dt>
                        <dd className="font-semibold text-navy-900">
                          {typeof value === "object" ? JSON.stringify(value) : String(value)}
                        </dd>
                      </div>
                    ))}
                    <div className="flex justify-between gap-3 border-t border-black/5 pt-1.5 text-slate-400">
                      <dt className="font-bold">الوقت الكامل</dt>
                      <dd className="font-semibold">{friendlyDateLong(entry.createdAt.slice(0, 10))}</dd>
                    </div>
                  </dl>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
