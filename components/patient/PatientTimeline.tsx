"use client";

import { useCallback, useEffect, useState } from "react";
import { formatMoney, isCurrency, type Currency } from "@/lib/money";
import { friendlyDate } from "@/lib/reminders";
import {
  filterTimeline,
  TIMELINE_GROUP_LABEL,
  TIMELINE_KIND_LABEL,
  type TimelineEvent,
  type TimelineGroup,
} from "@/lib/workflow";

/**
 * الخط الزمني الموحَّد (المواصفة §٢٩-٣٠).
 *
 * كل أحداث المريض من كل مصادرها — الزيارات والخطط والمواعيد والفواتير والدفعات
 * وطلبات المختبر والمستندات وشدّات التقويم — في خطٍّ واحد، وكل حدثٍ ينقر إلى
 * مصدره (§٣١). والفلاتر تجيب «ما تاريخ علاجه؟» و«ما تاريخ ماله؟» من مكان واحد.
 *
 * ويُحمَّل عند فتحه لا مع فتح الملف (§٤٨): الملخص يكفي أولًا، والتاريخ يُقرأ حين
 * يُطلب.
 */

const GROUPS: TimelineGroup[] = ["all", "clinical", "financial", "lab", "files"];

const KIND_ICON: Record<string, string> = {
  visit: "🪑",
  plan: "📋",
  invoice: "🧾",
  payment: "💳",
  lab: "🦷",
  document: "📄",
  appointment: "📅",
  ortho: "🪛",
  diagnosis: "📝",
};

const KIND_STYLE: Record<string, string> = {
  visit: "border-navy-200 bg-navy-50/50",
  plan: "border-navy-200 bg-white",
  invoice: "border-amber-200 bg-amber-50/40",
  payment: "border-emerald-200 bg-emerald-50/40",
  lab: "border-sky-200 bg-sky-50/40",
  document: "border-slate-200 bg-white",
  appointment: "border-sky-200 bg-white",
  ortho: "border-slate-200 bg-slate-50/50",
  diagnosis: "border-violet-200 bg-violet-50/40",
};

function eventDateTime(at: string): string {
  const date = at.slice(0, 10);
  const time = at.slice(11, 16);
  return `${friendlyDate(date)}${time ? ` · ${time}` : ""}`;
}

export function PatientTimeline({
  patientId,
  base,
}: {
  patientId: number;
  base: Currency;
}) {
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<TimelineEvent[] | null>(null);
  const [group, setGroup] = useState<TimelineGroup>("all");
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch(`/api/patients/${patientId}/timeline`, {
        cache: "no-store",
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload?.message ?? "تعذّر تحميل الخط الزمني.");
        return;
      }
      setEvents((payload.events ?? []) as TimelineEvent[]);
    } catch {
      setError("تعذّر الاتصال بالخادم.");
    }
  }, [patientId]);

  useEffect(() => {
    if (open && events === null) void load();
  }, [open, events, load]);

  const visible = events ? filterTimeline(events, group) : [];
  const baseCurrency: Currency = isCurrency(base) ? base : "YER";

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4" aria-label="الخط الزمني">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between gap-2 text-right"
        aria-expanded={open}
      >
        <span className="text-xs font-extrabold text-navy-900">
          🕘 الخط الزمني — تاريخ الرحلة كاملًا
        </span>
        <span className="text-[11px] font-bold text-slate-500">
          {open ? "إخفاء ▲" : "عرض ▼"}
        </span>
      </button>

      {open ? (
        <>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {GROUPS.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setGroup(option)}
                className={`rounded-xl px-3 py-1.5 text-[11px] font-bold transition-all ${
                  group === option
                    ? "bg-navy-800 text-white shadow-xs"
                    : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-100"
                }`}
              >
                {TIMELINE_GROUP_LABEL[option]}
              </button>
            ))}
          </div>

          {error ? (
            <p role="alert" className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-bold text-red-700">
              {error}
              <button type="button" onClick={() => void load()} className="mr-2 underline">
                أعد المحاولة
              </button>
            </p>
          ) : events === null ? (
            <p className="mt-3 text-center text-xs font-semibold text-slate-400">
              جارٍ تحميل الخط الزمني…
            </p>
          ) : visible.length === 0 ? (
            <p className="mt-3 text-center text-xs font-semibold text-slate-400">
              لا أحداث في هذا الفلتر.
            </p>
          ) : (
            <>
              <ul className="mt-3 space-y-1.5">
                {(expanded ? visible : visible.slice(0, 12)).map((event) => (
                  <li
                    key={event.key}
                    className={`rounded-xl border px-3 py-2 ${KIND_STYLE[event.kind] ?? "border-slate-200 bg-white"}`}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="flex flex-wrap items-center gap-1.5 text-xs font-bold text-navy-900">
                          <span>{KIND_ICON[event.kind] ?? "•"}</span>
                          <span className="truncate">{event.title}</span>
                          <span className="rounded-lg bg-white/80 px-1.5 py-0.5 text-[10px] font-bold text-slate-500">
                            {TIMELINE_KIND_LABEL[event.kind]}
                          </span>
                        </p>
                        <p className="mt-0.5 text-[11px] text-slate-500">
                          {eventDateTime(event.at)}
                          {event.detail ? ` · ${event.detail}` : ""}
                        </p>
                      </div>
                      {event.amountMinor !== null ? (
                        <span
                          className={`text-xs font-extrabold ${
                            event.kind === "payment" ? "text-emerald-700" : "text-amber-700"
                          }`}
                        >
                          {event.kind === "payment" ? "+" : ""}
                          {formatMoney(event.amountMinor, event.currency ? (isCurrency(event.currency) ? event.currency : baseCurrency) : baseCurrency)}
                        </span>
                      ) : null}
                    </div>
                    {event.href ? (
                      <a
                        href={event.href}
                        className="mt-1 inline-block text-[10px] font-bold text-navy-700 underline decoration-navy-300 underline-offset-4"
                      >
                        افتح المصدر ↗
                      </a>
                    ) : null}
                  </li>
                ))}
              </ul>

              {visible.length > 12 ? (
                <button
                  type="button"
                  onClick={() => setExpanded((value) => !value)}
                  className="mt-2 w-full rounded-xl border border-slate-200 bg-slate-50 py-2 text-[11px] font-bold text-slate-600 hover:bg-slate-100"
                >
                  {expanded ? "طوِ القائمة ▲" : `و${visible.length - 12} حدثًا آخر — اعرض الكل ▼`}
                </button>
              ) : null}
            </>
          )}
        </>
      ) : null}
    </section>
  );
}
