"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import {
  CONTACT_CHANNELS, CONTACT_CHANNEL_LABEL, CONTACT_OUTCOMES, CONTACT_OUTCOME_LABEL,
  SHIFTS, SHIFT_LABEL, URGENCIES, URGENCY_LABEL, WAITING_STATUS_LABEL,
  WEEKDAYS, WEEKDAY_LABEL, describeWindow,
  type ContactChannel, type ContactEvent, type ContactOutcome, type PreferredShift,
  type WaitingEntry, type WaitingUrgency, type Weekday,
} from "@/lib/waiting-list";

/**
 * قائمة الانتظار — من لم يجد موعدًا.
 *
 * المحرّك يرفض الحجز حين يمتلئ اليوم، والرفضُ بلا وجهةٍ يعني مريضًا ضاع: تقول
 * له الاستقبال «لا يوجد مكان» فيُغلق الهاتف، ثم يُلغي مريضٌ آخر موعده بعد
 * ساعتين فيبقى الكرسي فارغًا ولا أحد يعرف من يُنادى.
 *
 * وهذه الشاشة أداةُ عملٍ لا تقرير. وما تغيّر فيها:
 *   • «نوديَ» وحدها كانت كلمةً لا تقول أردّ أم لم يردّ، ولا متى، ولا من اتّصل —
 *     فصارت **مكالمةً تُسجَّل بنتيجتها**، وسجلُّها ظاهرٌ تحت كلّ اسم.
 *   • «حُجز له» كانت تكتب الحالة بلا موعدٍ موجود، فيسقط المريض من القائمة ومن
 *     الجدول معًا — فصار الحجزُ من شاشة المواعيد حيث يمرّ بمحرّك السعة.
 *   • التفضيلات تُعدَّل في مكانها، فمن اتّصل يقول «صرت أقدر صباحًا» لا يفقد
 *     أقدميّته بإلغاء صفّه وإنشاء غيره.
 *
 * والقاعدة فوق ذلك كلِّه: **القائمة ترشِّح ولا تحجز صامتةً.**
 */

const URGENCY_STYLE: Record<string, string> = {
  urgent: "border-red-300 bg-red-50 text-red-800",
  soon: "border-amber-300 bg-amber-50 text-amber-800",
  normal: "border-slate-200 bg-slate-50 text-slate-700",
};

interface PreferenceDraft {
  urgency: WaitingUrgency;
  preferredShift: PreferredShift;
  preferredDays: Weekday[];
  sameDayAvailable: boolean;
  earliestDate: string;
  latestDate: string;
  note: string;
}

interface ContactDraft {
  outcome: ContactOutcome;
  channel: ContactChannel;
  note: string;
}

/** أيامُ الانتظار — رقمٌ يقرأه الموظّف فيعرف من طال انتظاره. */
function waitingDays(createdAt: string): number {
  const created = new Date(createdAt).getTime();
  if (!Number.isFinite(created)) return 0;
  return Math.max(0, Math.floor((Date.now() - created) / 86_400_000));
}

function formatMoment(value: string | null | undefined): string {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toLocaleString("ar", {
    dateStyle: "short", timeStyle: "short", numberingSystem: "latn",
  });
}

export default function WaitingListPage() {
  const [entries, setEntries] = useState<WaitingEntry[]>([]);
  const [history, setHistory] = useState<Record<number, ContactEvent[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [closing, setClosing] = useState<{ id: number; reason: string } | null>(null);
  const [contacting, setContacting] = useState<{ id: number; draft: ContactDraft } | null>(null);
  const [editing, setEditing] = useState<{ id: number; draft: PreferenceDraft } | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/waiting-list?withHistory=1", { cache: "no-store" });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.message ?? "تعذّر تحميل قائمة الانتظار.");
        return;
      }
      setEntries(Array.isArray(data?.entries) ? data.entries : []);
      setHistory(data?.history && typeof data.history === "object" ? data.history : {});
      setError(null);
    } catch {
      setError("تعذّر الاتصال بالخادم.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const act = async (id: number, body: Record<string, unknown>, done?: () => void) => {
    setBusyId(id);
    try {
      const res = await fetch(`/api/waiting-list/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.message ?? "تعذّر تنفيذ الإجراء.");
        return;
      }
      setError(null);
      done?.();
      await load();
    } catch {
      setError("تعذّر الاتصال بالخادم.");
    } finally {
      setBusyId(null);
    }
  };

  const startEditing = (entry: WaitingEntry) => {
    setEditing({
      id: entry.id,
      draft: {
        urgency: entry.urgency,
        preferredShift: entry.preferredShift ?? "any",
        preferredDays: entry.preferredDays ?? [],
        sameDayAvailable: entry.sameDayAvailable !== false,
        earliestDate: entry.earliestDate ?? "",
        latestDate: entry.latestDate ?? "",
        note: entry.note ?? "",
      },
    });
  };

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-5" dir="rtl">
      <PageHeader
        title="قائمة الانتظار"
        subtitle="من طلب موعدًا ولم يجد مكانًا — يُنادى حين يشغر"
      />

      {error && (
        <div role="alert" className="mb-3 rounded-xl border border-red-200 bg-red-50 p-2.5 text-xs font-bold text-red-700">
          {error}
        </div>
      )}
      {notice && (
        <div role="status" className="mb-3 rounded-xl border border-emerald-200 bg-emerald-50 p-2.5 text-xs font-bold text-emerald-800">
          {notice}
        </div>
      )}

      {loading ? (
        <p className="text-xs text-slate-600">جارٍ التحميل…</p>
      ) : entries.length === 0 ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center">
          <p className="text-sm font-bold text-navy-900">لا أحد ينتظر.</p>
          <p className="mt-1 text-xs text-slate-600">
            حين يمتلئ يومٌ ويُردّ مريض، تظهر له هنا إضافةٌ من شاشة الحجز نفسها.
          </p>
        </div>
      ) : (
        <ul className="space-y-2.5">
          {entries.map((entry) => {
            const events = history[entry.id] ?? [];
            const days = entry.preferredDays ?? [];
            const age = waitingDays(entry.createdAt);
            return (
              <li
                key={entry.id}
                data-waiting-entry={entry.id}
                data-urgency={entry.urgency}
                data-stale={entry.isStale ? "1" : "0"}
                className={`rounded-2xl border bg-white p-3.5 shadow-xs ${
                  entry.isStale ? "border-amber-300" : "border-slate-200"
                }`}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-black text-navy-900">{entry.patientName}</span>
                      <span className={`rounded-lg border px-2 py-0.5 text-[10px] font-bold ${URGENCY_STYLE[entry.urgency] ?? URGENCY_STYLE.normal}`}>
                        {URGENCY_LABEL[entry.urgency]}
                      </span>
                      {entry.status === "offered" && (
                        <span className="rounded-lg border border-sky-300 bg-sky-50 px-2 py-0.5 text-[10px] font-bold text-sky-800">
                          {WAITING_STATUS_LABEL.offered}
                        </span>
                      )}
                      {/* علامةُ مراجعةٍ لا حذف: الصفّ يبقى ويُعلَّم حين تمضي مدّة البقاء المهيّأة. */}
                      {entry.isStale && (
                        <span
                          data-stale-badge="1"
                          className="rounded-lg border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-800"
                        >
                          مضت مدّة البقاء — راجعه
                        </span>
                      )}
                    </div>

                    <p className="mt-1 text-[11px] text-slate-600">
                      {entry.patientPhone ? (
                        <a href={`tel:${entry.patientPhone}`} dir="ltr" className="font-bold text-navy-800 underline">
                          {entry.patientPhone}
                        </a>
                      ) : "بلا رقم"}
                      {" · "}{entry.serviceName ?? "إجراء عام"}
                      {entry.doctorName ? ` · د. ${entry.doctorName}` : ""}
                    </p>

                    <p className="mt-0.5 text-[11px] text-slate-600">
                      {describeWindow(entry)} · {SHIFT_LABEL[entry.preferredShift ?? "any"]}
                      {" · "}{days.length === 0 ? "أيّ يوم" : days.map((day) => WEEKDAY_LABEL[day]).join("، ")}
                      {entry.sameDayAvailable === false ? " · لا يقبل اليوم نفسه" : ""}
                      {entry.durationMinutes ? ` · ${entry.durationMinutes} دقيقة` : ""}
                    </p>

                    <p className="mt-0.5 text-[11px] text-slate-500">
                      ينتظر منذ {age} يومًا
                      {" · "}
                      {/* «كُلّم ٣ مرات، آخرها لم يردّ» — بدل كلمةٍ واحدة لا تقول شيئًا. */}
                      {entry.contactAttempts
                        ? `كُلّم ${entry.contactAttempts} مرة${entry.lastOutcome ? ` · آخرها: ${CONTACT_OUTCOME_LABEL[entry.lastOutcome]}` : ""}`
                        : "لم يُكلَّم بعد"}
                      {entry.lastContactAt ? ` · ${formatMoment(entry.lastContactAt)}` : ""}
                    </p>

                    {entry.note && (
                      <p className="mt-1 text-[11px] text-slate-700">{entry.note}</p>
                    )}
                  </div>

                  <div className="flex shrink-0 flex-wrap gap-1.5">
                    <button
                      type="button"
                      data-action="contact"
                      disabled={busyId === entry.id}
                      onClick={() => setContacting({
                        id: entry.id,
                        draft: { outcome: "no_answer", channel: "phone", note: "" },
                      })}
                      className="rounded-xl border border-sky-300 bg-sky-50 px-3 py-1.5 text-xs font-bold text-sky-800 hover:bg-sky-100 disabled:opacity-50"
                    >
                      سجّل مكالمة
                    </button>
                    <button
                      type="button"
                      data-action="edit-preferences"
                      disabled={busyId === entry.id}
                      onClick={() => startEditing(entry)}
                      className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                    >
                      تعديل التفضيلات
                    </button>
                    {events.length > 0 && (
                      <button
                        type="button"
                        data-action="history"
                        onClick={() => setExpanded(expanded === entry.id ? null : entry.id)}
                        className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50"
                      >
                        سجلّ الاتصال ({events.length})
                      </button>
                    )}
                    <button
                      type="button"
                      data-action="close"
                      disabled={busyId === entry.id}
                      onClick={() => setClosing({ id: entry.id, reason: "" })}
                      className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                    >
                      إغلاق
                    </button>
                  </div>
                </div>

                {/* سجلُّ المكالمات — وقائعُ تُضاف ولا تُعدَّل. */}
                {expanded === entry.id && events.length > 0 && (
                  <ul data-contact-history={entry.id} className="mt-2.5 space-y-1 rounded-xl border border-slate-200 bg-slate-50 p-2.5">
                    {events.map((event) => (
                      <li key={event.id} className="text-[11px] text-slate-700">
                        <span className="font-bold">{CONTACT_OUTCOME_LABEL[event.outcome]}</span>
                        {" · "}{CONTACT_CHANNEL_LABEL[event.channel]}
                        {" · "}{formatMoment(event.contactedAt)}
                        {" · "}{event.contactedBy}
                        {event.slotDate ? ` · لمكان ${event.slotDate} ${event.slotTime ?? ""}` : ""}
                        {event.note ? ` — ${event.note}` : ""}
                      </li>
                    ))}
                  </ul>
                )}

                {/* تسجيلُ مكالمة */}
                {contacting?.id === entry.id && (
                  <div data-contact-form={entry.id} className="mt-2.5 rounded-xl border border-sky-200 bg-sky-50/60 p-2.5">
                    <div className="flex flex-wrap gap-2">
                      <label className="text-[11px] font-bold text-slate-700">
                        النتيجة
                        <select
                          data-field="outcome"
                          value={contacting.draft.outcome}
                          onChange={(event) => setContacting({
                            id: entry.id,
                            draft: { ...contacting.draft, outcome: event.target.value as ContactOutcome },
                          })}
                          className="mr-1.5 rounded-lg border border-slate-200 px-2 py-1 text-xs"
                        >
                          {CONTACT_OUTCOMES.map((outcome) => (
                            <option key={outcome} value={outcome}>{CONTACT_OUTCOME_LABEL[outcome]}</option>
                          ))}
                        </select>
                      </label>
                      <label className="text-[11px] font-bold text-slate-700">
                        الوسيلة
                        <select
                          data-field="channel"
                          value={contacting.draft.channel}
                          onChange={(event) => setContacting({
                            id: entry.id,
                            draft: { ...contacting.draft, channel: event.target.value as ContactChannel },
                          })}
                          className="mr-1.5 rounded-lg border border-slate-200 px-2 py-1 text-xs"
                        >
                          {CONTACT_CHANNELS.map((channel) => (
                            <option key={channel} value={channel}>{CONTACT_CHANNEL_LABEL[channel]}</option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <input
                      type="text"
                      data-field="contact-note"
                      value={contacting.draft.note}
                      onChange={(event) => setContacting({
                        id: entry.id, draft: { ...contacting.draft, note: event.target.value },
                      })}
                      placeholder="ملاحظة — مثال: يفضّل معاودة الاتصال بعد العصر"
                      className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-xs outline-none focus:border-navy-800"
                    />
                    <div className="mt-2 flex gap-1.5">
                      <button
                        type="button"
                        data-action="confirm-contact"
                        disabled={busyId === entry.id}
                        onClick={() => void act(entry.id, {
                          action: "contact",
                          outcome: contacting.draft.outcome,
                          channel: contacting.draft.channel,
                          note: contacting.draft.note,
                        }, () => { setContacting(null); setNotice("سُجّلت المكالمة."); })}
                        className="rounded-xl bg-navy-800 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50"
                      >
                        حفظ المكالمة
                      </button>
                      <button
                        type="button"
                        onClick={() => setContacting(null)}
                        className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-700"
                      >
                        تراجع
                      </button>
                    </div>
                  </div>
                )}

                {/* تعديلُ التفضيلات — الأقدميّة تبقى، فلا يُلغى الصفّ ويُنشأ غيره. */}
                {editing?.id === entry.id && (
                  <div data-preferences-form={entry.id} className="mt-2.5 rounded-xl border border-slate-200 bg-slate-50 p-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <label className="text-[11px] font-bold text-slate-700">
                        الإلحاح
                        <select
                          data-field="urgency"
                          value={editing.draft.urgency}
                          onChange={(event) => setEditing({
                            id: entry.id,
                            draft: { ...editing.draft, urgency: event.target.value as WaitingUrgency },
                          })}
                          className="mr-1.5 rounded-lg border border-slate-200 px-2 py-1 text-xs"
                        >
                          {URGENCIES.map((urgency) => (
                            <option key={urgency} value={urgency}>{URGENCY_LABEL[urgency]}</option>
                          ))}
                        </select>
                      </label>
                      <label className="text-[11px] font-bold text-slate-700">
                        الوردية
                        <select
                          data-field="preferredShift"
                          value={editing.draft.preferredShift}
                          onChange={(event) => setEditing({
                            id: entry.id,
                            draft: { ...editing.draft, preferredShift: event.target.value as PreferredShift },
                          })}
                          className="mr-1.5 rounded-lg border border-slate-200 px-2 py-1 text-xs"
                        >
                          {SHIFTS.map((shift) => (
                            <option key={shift} value={shift}>{SHIFT_LABEL[shift]}</option>
                          ))}
                        </select>
                      </label>
                      <label className="flex items-center gap-1 text-[11px] font-bold text-slate-700">
                        <input
                          type="checkbox"
                          data-field="sameDayAvailable"
                          checked={editing.draft.sameDayAvailable}
                          onChange={(event) => setEditing({
                            id: entry.id,
                            draft: { ...editing.draft, sameDayAvailable: event.target.checked },
                          })}
                        />
                        يقبل مكانًا اليوم نفسه
                      </label>
                    </div>

                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {WEEKDAYS.map((day) => {
                        const on = editing.draft.preferredDays.includes(day);
                        return (
                          <button
                            key={day}
                            type="button"
                            data-weekday={day}
                            aria-pressed={on}
                            onClick={() => setEditing({
                              id: entry.id,
                              draft: {
                                ...editing.draft,
                                preferredDays: on
                                  ? editing.draft.preferredDays.filter((value) => value !== day)
                                  : [...editing.draft.preferredDays, day].sort((a, b) => a - b),
                              },
                            })}
                            className={`rounded-lg border px-2 py-1 text-[11px] font-bold ${
                              on ? "border-navy-800 bg-navy-800 text-white" : "border-slate-200 bg-white text-slate-700"
                            }`}
                          >
                            {WEEKDAY_LABEL[day]}
                          </button>
                        );
                      })}
                      <span className="self-center text-[10px] text-slate-500">
                        بلا تحديد = أيّ يوم
                      </span>
                    </div>

                    <div className="mt-2 flex flex-wrap gap-2">
                      <label className="text-[11px] font-bold text-slate-700">
                        من
                        <input
                          type="date"
                          data-field="earliestDate"
                          value={editing.draft.earliestDate}
                          onChange={(event) => setEditing({
                            id: entry.id, draft: { ...editing.draft, earliestDate: event.target.value },
                          })}
                          className="mr-1.5 rounded-lg border border-slate-200 px-2 py-1 text-xs"
                        />
                      </label>
                      <label className="text-[11px] font-bold text-slate-700">
                        إلى
                        <input
                          type="date"
                          data-field="latestDate"
                          value={editing.draft.latestDate}
                          onChange={(event) => setEditing({
                            id: entry.id, draft: { ...editing.draft, latestDate: event.target.value },
                          })}
                          className="mr-1.5 rounded-lg border border-slate-200 px-2 py-1 text-xs"
                        />
                      </label>
                    </div>

                    <input
                      type="text"
                      data-field="note"
                      value={editing.draft.note}
                      onChange={(event) => setEditing({
                        id: entry.id, draft: { ...editing.draft, note: event.target.value },
                      })}
                      placeholder="ملاحظة"
                      className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-xs outline-none focus:border-navy-800"
                    />

                    <div className="mt-2 flex gap-1.5">
                      <button
                        type="button"
                        data-action="save-preferences"
                        disabled={busyId === entry.id}
                        onClick={() => void act(entry.id, {
                          action: "preferences",
                          urgency: editing.draft.urgency,
                          preferredShift: editing.draft.preferredShift,
                          preferredDays: editing.draft.preferredDays,
                          sameDayAvailable: editing.draft.sameDayAvailable,
                          earliestDate: editing.draft.earliestDate,
                          latestDate: editing.draft.latestDate,
                          note: editing.draft.note,
                        }, () => { setEditing(null); setNotice("حُفظت التفضيلات — والأقدميّة كما هي."); })}
                        className="rounded-xl bg-navy-800 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50"
                      >
                        حفظ التفضيلات
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditing(null)}
                        className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-700"
                      >
                        تراجع
                      </button>
                    </div>
                  </div>
                )}

                {closing?.id === entry.id && (
                  <div className="mt-2.5 rounded-xl border border-slate-200 bg-slate-50 p-2.5">
                    <label htmlFor={`reason-${entry.id}`} className="mb-1 block text-[11px] font-bold text-slate-700">
                      سبب الإغلاق — يُسأل عنه حين يتّصل المريض بعد شهرٍ يسأل عن دوره
                    </label>
                    <input
                      id={`reason-${entry.id}`}
                      type="text"
                      value={closing.reason}
                      onChange={(event) => setClosing({ id: entry.id, reason: event.target.value })}
                      placeholder="مثال: اعتذر المريض · عولج في مكانٍ آخر"
                      className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs outline-none focus:border-navy-800"
                    />
                    <div className="mt-2 flex gap-1.5">
                      <button
                        type="button"
                        data-action="confirm-close"
                        disabled={busyId === entry.id || !closing.reason.trim()}
                        onClick={() => void act(
                          entry.id,
                          { action: "cancelled", reason: closing.reason },
                          () => { setClosing(null); setNotice("أُغلق الانتظار — والصفّ يبقى في السجلّ بسببه."); },
                        )}
                        className="rounded-xl bg-navy-800 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50"
                      >
                        تأكيد الإغلاق
                      </button>
                      <button
                        type="button"
                        onClick={() => setClosing(null)}
                        className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-700"
                      >
                        تراجع
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <p className="mt-4 text-[11px] leading-relaxed text-slate-600">
        القائمة ترشِّح ولا تحجز: الحجز يتمّ من شاشة المواعيد — حين يشغر مكانٌ تظهر
        هناك لوحةُ المرشَّحين بسبب ترشيح كلٍّ منهم — فيمرّ من محرّك السعة نفسه.
        وموعدٌ يُفرض على مريضٍ لم يؤكّد هو وعدٌ لا يستطيع المركز الوفاء به. و
        <a href="/appointments" className="font-bold text-navy-800 underline">شاشة المواعيد</a>
        {" "}هي مكان الحجز.
      </p>
    </div>
  );
}
