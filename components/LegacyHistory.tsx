"use client";

import { useEffect, useState } from "react";
import { CURRENCY_LABEL, formatMoney } from "@/lib/money";
import type { LegacyTreatmentView } from "@/lib/db";
import { useSession } from "./SessionProvider";

/**
 * (P1-5ج) سجل النظام القديم في ملف المريض — معالجاته ودفعاته كما كانت، للقراءة.
 * لا يدخل الحساب ولا الصندوق: ما بقي منها صار رصيدًا افتتاحيًّا بعملته في «الحساب» أعلاه.
 */

type History = { treatments: LegacyTreatmentView[]; orphanPayments: LegacyTreatmentView["payments"] };
type ReadState = { phase: "ready"; data: History } | { phase: "denied" | "error" };
export const LEGACY_ARCHIVE_READ_TIMEOUT_MS = 15_000;

export function LegacyHistory({ patientId }: { patientId: number }) {
  const session = useSession();
  if (!session) return null;
  const scope = JSON.stringify([patientId, session.username, session.role, session.permissions ?? null]);
  return <ScopedLegacyHistory key={scope} patientId={patientId} />;
}

function ScopedLegacyHistory({ patientId }: { patientId: number }) {
  const [result, setResult] = useState<ReadState | null>(null);
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    let expired = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      expired = true; controller.abort();
      if (alive) setResult({ phase: "error" });
    }, LEGACY_ARCHIVE_READ_TIMEOUT_MS);
    void (async () => {
      try {
        const response = await fetch(`/api/patients/${patientId}/legacy`, { cache: "no-store", signal: controller.signal });
        if (!alive || expired) return;
        if ([401, 403, 404].includes(response.status)) { setResult({ phase: "denied" }); return; }
        if (!response.ok) throw new Error("Archive read unavailable");
        const payload = await response.json() as History;
        if (!payload || !Array.isArray(payload.treatments) || !Array.isArray(payload.orphanPayments)) throw new Error("Invalid archive response");
        if (alive && !expired) setResult({ phase: "ready", data: payload });
      } catch { if (alive && !expired) setResult({ phase: "error" }); }
      finally { clearTimeout(timeout); }
    })();
    return () => { alive = false; clearTimeout(timeout); controller.abort(); };
  }, [patientId, attempt]);

  if (!result) return null;
  if (result.phase !== "ready") return (
    <section className="mt-4 rounded-2xl border border-slate-200 bg-slate-50/60 p-4" aria-label="سجل النظام القديم">
      <p role="status" className="text-xs font-bold text-slate-600">{result.phase === "denied"
        ? "السجل المالي السابق غير متاح بصلاحية الجلسة الحالية."
        : "تعذّر تحميل السجل المالي السابق؛ هذا لا يعني عدم وجود سجل."}</p>
      {result.phase === "error" ? <button type="button" onClick={() => { setResult(null); setAttempt((value) => value + 1); }}
        className="mt-2 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold">أعد تحميل السجل السابق</button> : null}
    </section>
  );
  const { data } = result;
  if (data.treatments.length === 0 && data.orphanPayments.length === 0) return null;

  return (
    <section className="mt-4 rounded-2xl border border-slate-200 bg-slate-50/60 p-4" aria-label="سجل النظام القديم">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center justify-between text-sm font-extrabold">
        <span>سجل النظام القديم ({data.treatments.length} معالجة)</span>
        <span className="text-xs text-slate-500">{open ? "إخفاء" : "عرض"}</span>
      </button>
      <p className="mt-1 text-[11px] font-bold text-slate-500">
        سجل مالي سابق للاطلاع. الأرقام هنا تاريخية؛ الرصيد الحالي والتحصيلات الجديدة في الحساب أعلاه.
      </p>
      {open ? (
        <ul className="mt-3 space-y-2 text-xs">
          {data.treatments.map((treatment) => (
            <li key={treatment.id} className="rounded-xl border border-slate-200 bg-white p-3">
              <p className="font-extrabold">
                {treatment.sourceKind === "manual_history" ? "سجل تاريخي يدوي" : `#${treatment.legacyNumber}`} · {treatment.service ?? "معالجة"} · {treatment.treatedOn ?? ""}
                {treatment.doctorName ? ` · ${treatment.doctorName}` : ""}
              </p>
              {treatment.sourceKind === "manual_history" ? (
                <p className="mt-1 text-slate-500">البيانات التاريخية حتى {treatment.historicalAsOf}</p>
              ) : null}
              <p className="mt-1 font-bold text-slate-600">
                السعر {formatMoney(treatment.priceMinor, treatment.currency)} ({CURRENCY_LABEL[treatment.currency]}
                {treatment.rate && treatment.currency !== "YER" ? ` · سعر الصرف القديم ${treatment.rate}` : ""}) ·
                المدفوع {formatMoney(treatment.paidMinor, treatment.currency)} ·
                الباقي <span className={treatment.remainingMinor > 0 ? "text-rose-700" : ""}>{formatMoney(treatment.remainingMinor, treatment.currency)}</span>
              </p>
              {treatment.payments.length > 0 ? (
                <ul className="mt-2 space-y-0.5 border-t border-slate-100 pt-2 text-slate-600">
                  {treatment.payments.map((payment) => (
                    <li key={payment.legacyNumber}>
                      دفعة #{payment.legacyNumber} · {payment.paidOn ?? ""} · {formatMoney(payment.amountMinor, payment.currency)}
                      {payment.method ? ` · ${payment.method}` : ""}{payment.cashBox ? ` · ${payment.cashBox}` : ""}
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
          {data.orphanPayments.length > 0 ? (
            <li className="rounded-xl border border-slate-200 bg-white p-3">
              <p className="font-extrabold">دفعات بلا معالجة معروفة</p>
              {data.orphanPayments.map((payment) => (
                <p key={payment.legacyNumber}>دفعة #{payment.legacyNumber} · {payment.paidOn ?? ""} · {formatMoney(payment.amountMinor, payment.currency)}</p>
              ))}
            </li>
          ) : null}
        </ul>
      ) : null}
    </section>
  );
}
