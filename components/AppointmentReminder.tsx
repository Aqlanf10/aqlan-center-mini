"use client";

import { useLayoutEffect, useMemo, useRef } from "react";
import { useSession } from "@/components/SessionProvider";
import { formatClinicTimestamp } from "@/lib/clinic-clock";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";
import { friendlyDateLong, friendlyTime, reminderNeedsOverride, whatsAppLink } from "@/lib/reminders";
import type { Appointment } from "@/lib/schedule";

/** Opening an external draft is never evidence of sending or contacting a patient. */
export function AppointmentReminder({ item, busy, isCurrent, onConfirmed }: {
  item: Appointment;
  busy: boolean;
  /** The owning list must still be the same ready day/request, not a retired snapshot. */
  isCurrent: () => boolean;
  onConfirmed: () => Promise<void>;
}) {
  const session = useSession();
  const sessionKey = JSON.stringify([session?.username, session?.role, session?.permissions]);
  const itemKey = JSON.stringify([
    item.id, item.patientId, item.patientName, item.scheduledDate, item.scheduledTime,
    item.status, item.patientPhone, item.reminderSentAt,
  ]);
  // Identical claims in a replacement session are still a new signed-in lifetime.
  const context = useMemo(() => ({ session, sessionKey, itemKey }), [session, sessionKey, itemKey]);
  const owner = useRef<object | null>(null);
  const pending = useRef<object | null>(null);
  useLayoutEffect(() => {
    owner.current = context;
    return () => { owner.current = null; };
  }, [context]);

  const active = item.status === "booked" || item.status === "no_show";
  const canUse = () => active && !!session?.username && !busy && owner.current === context
    && pending.current === null && isCurrent();
  const link = whatsAppLink(item, item.status === "no_show" ? "missed" : "upcoming");
  const needsOverride = reminderNeedsOverride(item.reminderSentAt);

  const confirm = async () => {
    if (!canUse()) return;
    if (!window.confirm(
      `هل تؤكد أنك ذكّرت ${item.patientName} بموعد ${friendlyDateLong(item.scheduledDate)} الساعة ${friendlyTime(item.scheduledTime)}، برسالة أرسلتها أو بتواصل فعلي؟\nفتح مسودة واتساب وحده لا يكفي. هذا تسجيل بإفادتك، وليس إثبات تسليم آلي.`,
    )) return;
    // A native prompt can outlive its row, day, or signed-in user.
    if (!canUse()) return;
    pending.current = context;
    try {
      await onConfirmed();
    } finally {
      if (pending.current === context) pending.current = null;
    }
  };

  if (!active) return null;
  return (
    <div role="group" aria-label={`تذكير موعد ${item.patientName}`} className="flex flex-wrap items-center gap-1.5" data-manual-reminder={item.id}>
      {link ? (
        <a
          href={busy || !session?.username ? undefined : link}
          target="_blank"
          rel="noopener noreferrer"
          aria-disabled={busy || !session?.username}
          onClick={(event) => {
            if (!canUse() || (needsOverride && !window.confirm("سُجّل تذكير لهذا المريض قبل أقل من ١٢ ساعة. هل تريد فتح مسودة جديدة؟")) || !canUse()) {
              event.preventDefault();
            }
          }}
          className="rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-bold text-emerald-800 hover:bg-emerald-100 aria-disabled:opacity-40"
        >
          💬 فتح مسودة واتساب
        </a>
      ) : (
        <span className="rounded-xl bg-slate-100 px-2.5 py-1.5 text-[11px] font-bold text-slate-500">بلا رقم واتساب صالح</span>
      )}
      <button
        type="button"
        data-action="confirm-manual-reminder"
        disabled={busy || !session?.username}
        onClick={confirm}
        className="rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-40"
      >
        أؤكد أنني ذكّرت المريض
      </button>
      {item.reminderSentAt ? (
        <span className="text-[11px] font-bold text-emerald-700" title={`آخر تذكير مسجّل: ${formatClinicTimestamp(item.reminderSentAt, CLINIC_ZONE_FALLBACK)}`}>
          تذكير مسجّل ✓
        </span>
      ) : null}
      <span className="w-full text-[10px] text-slate-500">فتح المسودة لا يسجّل تذكيرًا. التأكيد اليدوي إفادة الموظف، وليس إثبات تسليم.</span>
    </div>
  );
}
