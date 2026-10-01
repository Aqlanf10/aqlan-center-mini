"use client";

import { useCallback, useEffect, useState } from "react";
import { CURRENCY_LABEL, formatMoney } from "@/lib/money";
import type { CheckoutCurrencyLine } from "@/lib/checkout-summary";
import type { BillingClassification } from "@/lib/billing-classification";
import { CollectPaymentModal } from "../CollectPaymentModal";
import { friendlyDateLong, friendlyTime } from "@/lib/reminders";
import { addDays, clinicDateString } from "@/lib/schedule";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";
import type { VisitWalkout } from "@/lib/db";

/** (P0-G) ملخّص المغادرة كما يعيده الخادم مع ملخّصه المالي بكل عملة. */
type CheckoutWalkout = VisitWalkout & { summary?: CheckoutCurrencyLine[] };

/** تسميات التصنيف القانوني — المصدر في الخادم، والواجهة تعرضه فقط. */
const CLASS_LABEL: Record<BillingClassification, { text: string; tone: string }> = {
  NEW_BILLABLE: { text: "مستحق جديد", tone: "bg-amber-100 text-amber-900" },
  INCLUDED: { text: "مشمول بالاتفاق", tone: "bg-sky-100 text-sky-900" },
  LEGACY_INCLUDED: { text: "مشمول بالعلاج السابق", tone: "bg-violet-100 text-violet-900" },
  OUTSIDE_CONTRACT: { text: "خارج العقد — قرار فوترة", tone: "bg-rose-100 text-rose-900" },
  NO_CHARGE: { text: "بلا رسوم", tone: "bg-slate-100 text-slate-700" },
};

/**
 * (CHAIR-1 Slice 5) إكمال الشبّاك بعد التوقيع — فوق الشبّاك القائم لا بدلًا عنه:
 *
 * - أسطر «مشمول بالخطة» (BILL-1: سعر صفر وعلامة) كما وُقّعت.
 * - «تأجيل الدفع»: لا سند ولا فاتورة — الرصيد يبقى على المريض، والقرار يُدقَّق باسم من اتّخذه.
 * - «ملخّص المغادرة» للطباعة من بياناتٍ قائمة.
 * - حجز الجلسة القادمة هنا بمسار حجز الجلسة القادمة نفسه (`/api/visits/[id]/next`) وحارس سعته.
 *
 * «بلا رسوم» ليس مسارًا جديدًا: يُعدَّل سعر الإجراء قبل التوقيع إلى صفر بسببٍ مكتوب (مسار تعديل
 * السعر القائم). والتحصيل نفسه يبقى في نافذة التحصيل بشرط الوردية المفتوحة.
 */
export function CheckoutExtras({
  visitId, collected, suggestedDate, durationMinutes, onChanged,
}: {
  visitId: number;
  collected: boolean;
  suggestedDate: string | null;
  durationMinutes: number | null;
  onChanged: () => void;
}) {
  const [walkout, setWalkout] = useState<CheckoutWalkout | null>(null);
  const [collectLegacy, setCollectLegacy] = useState<CheckoutCurrencyLine | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [date, setDate] = useState(() => suggestedDate ?? addDays(clinicDateString(new Date(), CLINIC_ZONE_FALLBACK), 28));
  const [time, setTime] = useState("10:00");
  const [booked, setBooked] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/visits/${visitId}/walkout`, { cache: "no-store" });
      if (response.ok) setWalkout(await response.json() as CheckoutWalkout);
    } catch { /* الملخّص مساعدة — الشبّاك يعمل بدونه */ }
  }, [visitId]);

  useEffect(() => {
    const first = setTimeout(() => { void load(); }, 0);
    return () => clearTimeout(first);
  }, [load, collected]);

  const defer = async () => {
    if (busy) return;
    /* (P0-G) التأجيل بسببٍ مكتوب — يُحفظ في التدقيق مع اسم من قرّره. */
    const reason = window.prompt("سبب تأجيل الدفع (يُسجَّل في التدقيق):", "")?.trim() ?? "";
    if (reason.length < 3) {
      setMessage({ tone: "error", text: "اكتب سبب التأجيل (ثلاثة أحرف على الأقل)." });
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`/api/visits/${visitId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "defer", reason }),
      });
      const payload = await response.json().catch(() => null);
      setMessage({ tone: response.ok ? "ok" : "error", text: payload?.message ?? (response.ok ? "أُجِّل الدفع." : "تعذّر التأجيل.") });
      await load();
      if (response.ok) onChanged();
    } catch {
      setMessage({ tone: "error", text: "تعذّر الاتصال بالخادم." });
    } finally {
      setBusy(false);
    }
  };

  const book = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/visits/${visitId}/next`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, time, durationMinutes: durationMinutes ?? 30 }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setMessage({ tone: "error", text: [payload?.message, payload?.suggestionMessage].filter(Boolean).join(" ") || "تعذّر الحجز." });
        if (typeof payload?.suggestion === "string") setTime(payload.suggestion);
        return;
      }
      setBooked(`${friendlyDateLong(date)} — ${friendlyTime(time)}`);
      setMessage(null);
      await load();
      onChanged();
    } catch {
      setMessage({ tone: "error", text: "تعذّر الاتصال بالخادم." });
    } finally {
      setBusy(false);
    }
  };

  const deferred = walkout?.deferred === true;
  const summary = walkout?.summary ?? [];

  return (
    <div className="mt-3 space-y-2">
      {/* (P0-G) «أُنجز اليوم» بتصنيف الخادم لكل سطر — لا حساب فوترة في الواجهة. */}
      {walkout && (walkout.lines.length > 0 || walkout.orthoAdjustment) ? (
        <section className="rounded-xl border border-slate-200 bg-white px-3 py-2" aria-label="أُنجز اليوم">
          <h4 className="mb-1 text-xs font-extrabold text-navy-900">أُنجز اليوم</h4>
          <ul className="space-y-1 text-[11px]">
            {walkout.orthoAdjustment ? (
              <li className="flex items-center justify-between gap-2">
                <span className="font-bold text-slate-800">شدّة تقويم</span>
                <span className={`rounded-full px-2 py-0.5 font-black ${CLASS_LABEL[walkout.orthoAdjustment.billingClass].tone}`}>
                  {walkout.orthoAdjustment.pendingDecision
                    ? "خارج العقد — قرار فوترة معلّق"
                    : walkout.orthoAdjustment.billingClass === "NEW_BILLABLE"
                      ? "فوتِرت بسطر «شدّة تقويم»"
                      : `${CLASS_LABEL[walkout.orthoAdjustment.billingClass].text} · بلا رسوم جديدة`}
                </span>
              </li>
            ) : null}
            {walkout.lines.map((line, index) => (
              <li key={index} className="flex items-center justify-between gap-2">
                <span className="font-bold text-slate-800">{line.description}{line.toothCode ? ` ${line.toothCode}` : ""}</span>
                <span className="flex items-center gap-1.5">
                  <span className={`rounded-full px-2 py-0.5 font-black ${CLASS_LABEL[line.billingClass].tone}`}>{CLASS_LABEL[line.billingClass].text}</span>
                  <span className="font-extrabold text-navy-900">
                    {formatMoney(line.billingClass === "NEW_BILLABLE" ? line.unitPriceMinor * line.quantity : 0, line.currency)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* (P0-G) ما يضيفه الشبّاك فوق لقطته المجمَّدة (TD-05): قسط الرصيد القديم المقترح، ومدفوع اليوم،
          والمطلوب الآن — بكل عملة على حدة ومن الخادم. الرصيد السابق والإجمالي يبقيان في اللقطة أعلاه وحدها. */}
      {summary.filter((line) => line.dueNowMinor > 0 || line.legacySuggestedMinor > 0 || line.paymentsTodayMinor > 0).map((line) => (
        <section key={line.currency} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-[11px]"
          aria-label={`المطلوب الآن ${CURRENCY_LABEL[line.currency]}`}>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
            {line.legacySuggestedMinor > 0 ? (<>
              <span className="text-slate-600">قسط الرصيد القديم المقترح</span>
              <span className="text-left font-bold">{formatMoney(line.legacySuggestedMinor, line.currency)}</span>
            </>) : null}
            {line.paymentsTodayMinor > 0 ? (<>
              <span className="text-slate-600">مدفوع اليوم</span>
              <span className="text-left font-bold">{formatMoney(line.paymentsTodayMinor, line.currency)}</span>
            </>) : null}
            <span className="font-extrabold text-navy-900">المطلوب الآن · {CURRENCY_LABEL[line.currency]}</span>
            <span className="text-left text-sm font-black text-navy-900">{formatMoney(line.dueNowMinor, line.currency)}</span>
          </div>
          {line.legacySuggestedMinor > 0 && walkout?.patientId ? (
            <button type="button" onClick={() => setCollectLegacy(line)}
              className="mt-2 w-full rounded-xl bg-violet-700 py-2 text-xs font-extrabold text-white">
              تحصيل قسط الرصيد القديم {formatMoney(line.legacySuggestedMinor, line.currency)}
            </button>
          ) : null}
        </section>
      ))}
      <div className="flex flex-wrap gap-2">
        {!collected ? (
          deferred ? (
            <span className="rounded-xl bg-slate-100 px-3 py-2 text-xs font-bold text-slate-700">أُجِّل الدفع — الرصيد باقٍ على المريض</span>
          ) : (
            <button type="button" onClick={() => void defer()} disabled={busy}
              title="لا سند ولا فاتورة — يبقى الرصيد على المريض ويُسجَّل القرار"
              className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-bold text-slate-700 disabled:opacity-40">
              تأجيل الدفع
            </button>
          )
        ) : null}
        <a href={`/print/walkout/${visitId}`} target="_blank" rel="noopener"
          className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-navy-800">
          🖨️ ملخّص المغادرة
        </a>
      </div>

      {booked || walkout?.nextAppointment ? (
        <p className="rounded-xl bg-emerald-100 px-3 py-2 text-xs font-bold text-emerald-900">
          الموعد القادم: {booked ?? (walkout?.nextAppointment
            ? `${friendlyDateLong(walkout.nextAppointment.date)} — ${friendlyTime(walkout.nextAppointment.time)}` : "")}
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-navy-200 bg-white px-3 py-2">
          <span className="text-xs font-extrabold text-navy-900">احجز القادمة:</span>
          <input type="date" value={date} onChange={(event) => setDate(event.target.value)} aria-label="تاريخ الجلسة القادمة"
            className="rounded-lg border border-slate-200 px-2 py-1 text-xs" />
          <input type="time" value={time} onChange={(event) => setTime(event.target.value)} aria-label="وقت الجلسة القادمة"
            className="rounded-lg border border-slate-200 px-2 py-1 text-xs" />
          <button type="button" onClick={() => void book()} disabled={busy || !date || !time}
            className="rounded-lg bg-navy-800 px-3 py-1 text-xs font-bold text-white disabled:opacity-40">
            احجز
          </button>
        </div>
      )}

      {message ? (
        <p role={message.tone === "error" ? "alert" : "status"}
          className={`text-[11px] font-bold ${message.tone === "error" ? "text-red-700" : "text-emerald-700"}`}>{message.text}</p>
      ) : null}
      <p className="text-[10px] text-slate-400">بلا رسوم؟ يُعدَّل سعر الإجراء قبل التوقيع إلى صفر بسببٍ مكتوب.</p>

      {collectLegacy && walkout?.patientId ? (
        <CollectPaymentModal
          patientId={walkout.patientId}
          patientName={walkout.patientName}
          isOpen
          onClose={() => setCollectLegacy(null)}
          onSuccess={() => { setCollectLegacy(null); void load(); onChanged(); }}
          suggestedMinor={collectLegacy.legacySuggestedMinor}
          suggestedCurrency={collectLegacy.currency}
          contextLabel="قسط الرصيد القديم — يُنقصه بلا فاتورة جديدة"
          presetOpeningCurrency={collectLegacy.currency}
          openings={[{ currency: collectLegacy.currency, dueMinor: collectLegacy.legacyRemainingMinor }]}
        />
      ) : null}
    </div>
  );
}
