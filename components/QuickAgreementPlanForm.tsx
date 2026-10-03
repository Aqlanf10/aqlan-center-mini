"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  CURRENCIES,
  CURRENCY_LABEL,
  formatMoney,
  parseAmount,
  type Currency,
} from "@/lib/money";
import { splitInstallments } from "@/lib/plans";
import { friendlyDateLong } from "@/lib/reminders";
import { clinicDateString } from "@/lib/schedule";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";

interface Doctor { id: number; name: string }

/**
 * مسار الاتفاق السريع — خصوصًا التقويم.
 *
 * الخطة هنا ليست فاتورة: المبلغ المتفق عليه + جدول الأقساط يُرسلان إلى محرك
 * treatment_plans نفسه. التحصيل يبقى حدثًا ماليًا منفصلًا كما تفرض قواعد Mini.
 */
export function QuickAgreementPlanForm({
  patientId,
  base,
  onSaved,
  onError,
  onBusyChange,
  onUncertain,
  onAccessDenied,
}: {
  patientId: number;
  base: Currency;
  onSaved: () => void;
  onError: (message: string | null) => void;
  onBusyChange?: (pending: boolean) => boolean | void;
  onUncertain?: () => void;
  onAccessDenied?: (status: number) => void;
}) {
  const today = clinicDateString(new Date(), CLINIC_ZONE_FALLBACK);
  const [title, setTitle] = useState("عقد تقويم — مبلغ متفق عليه");
  const [currency, setCurrency] = useState<Currency>(base);
  const [total, setTotal] = useState("");
  const [count, setCount] = useState("12");
  const [everyDays, setEveryDays] = useState("30");
  const [firstDueDate, setFirstDueDate] = useState(today);
  const [doctorId, setDoctorId] = useState("");
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const pendingRef = useRef(false);
  const uncertainRef = useRef(false);
  const mountedRef = useRef(false);

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/parties?kind=doctor", { cache: "no-store" });
        if (!response.ok) return;
        const payload = await response.json();
        if (!mountedRef.current) return;
        setDoctors(Array.isArray(payload) ? payload : payload.balances ?? []);
      } catch {
        // الطبيب اختياري، فلا نعطل الاتفاق إن تعذر تحميل القائمة لحظيًا.
      }
    })();
  }, []);

  const totalMinor = parseAmount(total, currency) ?? 0;
  /* حدود الخادم نفسها (١–٦٠ قسطًا، ١–٣٦٥ يومًا) — رسالةٌ هنا بدل رفضٍ عامٍّ بعد الإرسال. */
  const countValue = Math.round(Number(count));
  const everyValue = Math.round(Number(everyDays));
  const scheduleError = !(countValue >= 1 && countValue <= 60)
    ? "عدد الأقساط من ١ إلى ٦٠."
    : !(everyValue >= 1 && everyValue <= 365) ? "الفاصل بين الأقساط من ١ إلى ٣٦٥ يومًا." : null;
  const approxMonths = scheduleError ? null : Math.max(1, Math.round((countValue * everyValue) / 30));
  const installments = useMemo(() => {
    if (totalMinor <= 0 || scheduleError) return [];
    return splitInstallments(
      totalMinor,
      Math.max(1, Number(count) || 1),
      firstDueDate,
      Math.max(1, Number(everyDays) || 30),
    );
  }, [totalMinor, count, everyDays, firstDueDate, scheduleError]);
  const canEditDraft = () => mountedRef.current && !pendingRef.current && !uncertainRef.current;

  const markUncertain = () => {
    uncertainRef.current = true;
    if (mountedRef.current) setUncertain(true);
    // The parent must retain this attempt even if its form was removed.
    onUncertain?.();
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!mountedRef.current || pendingRef.current || uncertainRef.current || busy || totalMinor <= 0 || installments.length === 0 || scheduleError) return;
    pendingRef.current = true;
    if (onBusyChange?.(true) === false) {
      pendingRef.current = false;
      return;
    }
    setBusy(true);
    try {
      onError(null);
      let saved = false;
      let rejection: string | null = null;
      try {
        const response = await fetch("/api/plans", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode: "v2",
            patientId,
            title: title.trim() || "مبلغ متفق عليه",
            specialty: "تقويم",
            currency,
            primaryDoctorId: doctorId ? Number(doctorId) : null,
            startDate: firstDueDate,
            note: note.trim() || null,
            items: [],
            billingMode: "installments",
            total,
            count: Number(count),
            everyDays: Number(everyDays),
          }),
        });
        if (!response.ok && response.status >= 400 && response.status < 500 && ![408, 499].includes(response.status)) {
          rejection = "تعذّر إنشاء اتفاق التقويم.";
          if ([401, 403, 404].includes(response.status)) onAccessDenied?.(response.status);
        }
        const payload = await response.json().catch(() => null);
        saved = response.ok && response.status >= 200 && response.status < 300
          && Number.isSafeInteger(payload?.id) && payload.id > 0;
        if (!response.ok && response.status >= 400 && response.status < 500 && ![408, 499].includes(response.status)) {
          rejection = typeof payload?.message === "string" ? payload.message : "تعذّر إنشاء اتفاق التقويم.";
        }
      } catch {
        // A lost response does not prove that the server rejected the write.
      }
      if (!saved && rejection === null) markUncertain();
      else if (mountedRef.current) {
        if (saved) onSaved();
        else onError(rejection);
      }
    } finally {
      pendingRef.current = false;
      if (mountedRef.current) setBusy(false);
      // A removed form still owns its dispatched request until it settles.
      onBusyChange?.(false);
    }
  };

  return (
    <form onSubmit={submit} className="mb-4 rounded-2xl border-2 border-violet-300 bg-violet-50/35 p-4">
      <fieldset disabled={busy || uncertain} className="min-w-0">
      <div className="mb-3">
        <h3 className="text-sm font-extrabold text-navy-900">🦷 تقويم / مبلغ متفق عليه</h3>
        <p className="mt-1 text-[11px] leading-5 text-slate-500">
          للمبالغ التعاقدية المقسطة: الاتفاق ≠ الاستحقاق ≠ التحصيل. الأقساط وحدها تُفوتر، وجلسات الخطة المشمولة
          لا تُفوتر مرة ثانية. اربط الخطة بحالة التقويم من «ملف التقويم». هذا ليس رصيدًا قديمًا (الرصيد السابق له مساره في الحساب).
        </p>
      </div>

      {uncertain ? (
        <p role="alert" className="mb-3 rounded-xl bg-amber-50 px-3 py-2 text-xs font-bold text-amber-900">
          قد يكون الاتفاق قد أُنشئ رغم عدم وصول تأكيد. لا تُعِد الإرسال قبل مراجعة خطط المريض والتحقق من المحاولة السابقة.
        </p>
      ) : null}

      <input
        value={title}
        onChange={(event) => { if (canEditDraft()) setTitle(event.target.value); }}
        aria-label="اسم الاتفاق"
        className="mb-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
      />

      <div className="grid gap-2 sm:grid-cols-2">
        <label>
          <span className="mb-1 block text-[10px] font-bold text-slate-500">المبلغ المتفق عليه</span>
          <input
            value={total}
            onChange={(event) => { if (canEditDraft()) setTotal(event.target.value); }}
            inputMode="decimal"
            dir="ltr"
            placeholder="0"
            className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-bold"
          />
        </label>
        <label>
          <span className="mb-1 block text-[10px] font-bold text-slate-500">العملة</span>
          <select value={currency} onChange={(event) => { if (canEditDraft()) setCurrency(event.target.value as Currency); }}
            className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm">
            {CURRENCIES.map((one) => <option key={one} value={one}>{CURRENCY_LABEL[one]}</option>)}
          </select>
        </label>
        <label>
          <span className="mb-1 block text-[10px] font-bold text-slate-500">عدد الأقساط</span>
          <input value={count} onChange={(event) => { if (canEditDraft()) setCount(event.target.value); }}
            inputMode="numeric" dir="ltr" min="1" max="60"
            className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm" />
        </label>
        <label>
          <span className="mb-1 block text-[10px] font-bold text-slate-500">كل كم يوم</span>
          <input value={everyDays} onChange={(event) => { if (canEditDraft()) setEveryDays(event.target.value); }}
            inputMode="numeric" dir="ltr" min="1" max="365"
            className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm" />
        </label>
        <label>
          <span className="mb-1 block text-[10px] font-bold text-slate-500">أول قسط / بداية الاتفاق</span>
          <input type="date" value={firstDueDate} onChange={(event) => { if (canEditDraft()) setFirstDueDate(event.target.value); }}
            className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm" />
        </label>
        <label>
          <span className="mb-1 block text-[10px] font-bold text-slate-500">الطبيب المسؤول</span>
          <select value={doctorId} onChange={(event) => { if (canEditDraft()) setDoctorId(event.target.value); }}
            className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm">
            <option value="">— يحدد لاحقًا —</option>
            {doctors.map((doctor) => <option key={doctor.id} value={doctor.id}>{doctor.name}</option>)}
          </select>
        </label>
      </div>

      {scheduleError ? (
        <p className="mt-2 rounded-xl bg-rose-50 px-3 py-2 text-[11px] font-bold text-rose-700">{scheduleError}</p>
      ) : null}
      {installments.length > 0 ? (
        <p className="mt-2 rounded-xl bg-white px-3 py-2 text-[11px] text-slate-600">
          {approxMonths ? `مدة تقريبية ${approxMonths} شهرًا · ` : ""}
          {installments.length} قسطًا · الأول {formatMoney(installments[0].amountMinor, currency)} في {friendlyDateLong(installments[0].dueDate)}
          {" · "}الأخير {formatMoney(installments[installments.length - 1].amountMinor, currency)} في {friendlyDateLong(installments[installments.length - 1].dueDate)}
        </p>
      ) : null}

      <input
        value={note}
        onChange={(event) => { if (canEditDraft()) setNote(event.target.value); }}
        placeholder="ملاحظة الاتفاق (اختياري)"
        className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
      />

      <button
        type="submit"
        disabled={busy || uncertain || totalMinor <= 0 || installments.length === 0 || Boolean(scheduleError)}
        className="mt-3 w-full rounded-xl bg-violet-700 py-2.5 text-sm font-extrabold text-white disabled:opacity-40"
      >
        {busy ? "جارٍ إنشاء الاتفاق…" : "أنشئ اتفاق التقويم وجدول الأقساط"}
      </button>
      </fieldset>
    </form>
  );
}
