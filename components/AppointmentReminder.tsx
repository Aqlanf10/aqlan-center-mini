"use client";

import { useLayoutEffect, useMemo, useRef } from "react";
import { useSession } from "@/components/SessionProvider";
import { formatClinicTimestamp } from "@/lib/clinic-clock";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";
import { friendlyDateLong, friendlyTime, reminderNeedsOverride, whatsAppLink } from "@/lib/reminders";
import type { Appointment } from "@/lib/schedule";
import type { ManualAppointmentReminderSnapshot } from "@/lib/manual-appointment-reminder";

/** Opening an external draft is never evidence of sending or contacting a patient. */
export function AppointmentReminder({ item, busy, isCurrent, onConfirmed, clinicTimeZone = CLINIC_ZONE_FALLBACK }: {
  item: Appointment;
  busy: boolean;
  clinicTimeZone?: string;
  /** The owning list must still be the same ready day/request, not a retired snapshot. */
  isCurrent: () => boolean;
  onConfirmed: (snapshot: ManualAppointmentReminderSnapshot) => Promise<void>;
}) {
  const session = useSession();
  const sessionKey = JSON.stringify([session?.username, session?.role, session?.permissions]);
  const itemKey = JSON.stringify([
    item.id, item.patientId, item.patientName, item.scheduledDate, item.scheduledTime,
    item.status, item.patientPhone, item.reminderSentAt, clinicTimeZone,
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
  const reminded = Boolean(item.reminderSentAt);
  const needsOverride = reminderNeedsOverride(item.reminderSentAt);
  const reminderLabel = needsOverride ? "إعادة تذكير؟" : reminded ? "ذُكِّر ✓" : "💬 تذكير واتساب";
  const helpId = `appointment-reminder-help-${item.id}`;

  const confirm = async () => {
    if (!canUse()) return;
    if (item.status !== "booked" && item.status !== "no_show") return;
    // Capture only the displayed reminder fields before opening the native prompt.
    const snapshot: ManualAppointmentReminderSnapshot = {
      patientId: item.patientId, patientName: item.patientName, patientPhone: item.patientPhone,
      scheduledDate: item.scheduledDate, scheduledTime: item.scheduledTime, status: item.status,
    };
    if (!window.confirm(
      `هل تؤكد أنك ذكّرت ${item.patientName} بموعد ${friendlyDateLong(item.scheduledDate)} الساعة ${friendlyTime(item.scheduledTime)}، برسالة أرسلتها أو بتواصل فعلي؟\nفتح مسودة واتساب وحده لا يكفي. هذا تسجيل بإفادتك، وليس إثبات تسليم آلي.`,
    )) return;
    // A native prompt can outlive its row, day, or signed-in user.
    if (!canUse()) return;
    pending.current = context;
    try {
      await onConfirmed(snapshot);
    } finally {
      if (pending.current === context) pending.current = null;
    }
  };

  if (!active) return null;
  return (
    <div role="group" aria-label={`تذكير موعد ${item.patientName}`} className="inline-flex max-w-full flex-wrap items-center gap-1.5" data-manual-reminder={item.id}>
      {link ? (
        <a
          href={busy || !session?.username ? undefined : link}
          target="_blank"
          rel="noopener noreferrer"
          aria-disabled={busy || !session?.username}
          aria-label={`${reminderLabel}، فتح مسودة واتساب لـ${item.patientName}`}
          aria-describedby={helpId}
          onClick={(event) => {
            if (!canUse() || (needsOverride && !window.confirm("سُجّل تذكير لهذا المريض قبل أقل من ١٢ ساعة. هل تريد فتح مسودة جديدة؟")) || !canUse()) {
              event.preventDefault();
            }
          }}
          title={item.reminderSentAt ? `آخر تذكير مسجّل: ${formatClinicTimestamp(item.reminderSentAt, clinicTimeZone)}` : "فتح مسودة واتساب فقط؛ لا يُسجّل التذكير حتى يؤكده الموظف."}
          className={`whitespace-nowrap rounded-xl px-3 py-1.5 text-xs font-bold transition-opacity hover:opacity-90 aria-disabled:opacity-40 ${
            needsOverride || reminded
              ? "border border-emerald-300 bg-emerald-50 text-emerald-700"
              : "bg-[#25D366] text-white shadow-2xs"
          }`}
        >
          {reminderLabel}
        </a>
      ) : (
        <span title="بلا رقم واتساب صالح" className="rounded-xl bg-slate-100 px-2.5 py-1.5 text-[11px] font-bold text-slate-400">بلا رقم</span>
      )}
      <button
        type="button"
        data-action="confirm-manual-reminder"
        disabled={busy || !session?.username}
        onClick={confirm}
        aria-label={`تأكيد الموظف أنه ذكّر ${item.patientName} بالموعد`}
        aria-describedby={helpId}
        title="تسجيل أنني ذكّرت المريض برسالة أرسلتها أو بتواصل فعلي"
        className="whitespace-nowrap rounded-xl border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-40"
      >
        تأكيد الموظف
      </button>
      <span id={helpId} className="sr-only">
        فتح المسودة لا يسجّل تذكيرًا. التأكيد اليدوي إفادة الموظف، وليس إثبات تسليم.
        {item.reminderSentAt ? ` آخر تذكير مسجّل: ${formatClinicTimestamp(item.reminderSentAt, clinicTimeZone)}` : ""}
      </span>
    </div>
  );
}
