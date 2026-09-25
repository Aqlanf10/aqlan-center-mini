"use client";

import { useEffect, useState } from "react";
import { CURRENCY_LABEL, formatMoney, type Currency } from "@/lib/money";

/**
 * (P1-5ج) سجل النظام القديم في ملف المريض — معالجاته ودفعاته كما كانت، للقراءة.
 * لا يدخل الحساب ولا الصندوق: ما بقي منها صار رصيدًا افتتاحيًّا بعملته في «الحساب» أعلاه.
 */

interface Payment { legacyNumber: number; paidOn: string | null; currency: Currency; amountMinor: number; rate: number | null; method: string | null; cashBox: string | null }
interface Treatment {
  legacyNumber: number; treatedOn: string | null; doctorName: string | null; service: string | null; currency: Currency;
  priceMinor: number; rate: number | null; paidMinor: number; remainingMinor: number; payments: Payment[];
}

export function LegacyHistory({ patientId }: { patientId: number }) {
  const [data, setData] = useState<{ treatments: Treatment[]; orphanPayments: Payment[] } | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const response = await fetch(`/api/patients/${patientId}/legacy`, { cache: "no-store" });
      if (!response.ok) return;
      const payload = await response.json() as { treatments: Treatment[]; orphanPayments: Payment[] };
      if (alive) setData(payload);
    })();
    return () => { alive = false; };
  }, [patientId]);

  if (!data || (data.treatments.length === 0 && data.orphanPayments.length === 0)) return null;

  return (
    <section className="mt-4 rounded-2xl border border-slate-200 bg-slate-50/60 p-4" aria-label="سجل النظام القديم">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center justify-between text-sm font-extrabold">
        <span>سجل النظام القديم ({data.treatments.length} معالجة)</span>
        <span className="text-xs text-slate-500">{open ? "إخفاء" : "عرض"}</span>
      </button>
      <p className="mt-1 text-[11px] font-bold text-slate-500">
        كما سُجّل في البرنامج السابق — للاطلاع. ما بقي منه صار رصيدًا افتتاحيًّا بعملته في الحساب أعلاه.
      </p>
      {open ? (
        <ul className="mt-3 space-y-2 text-xs">
          {data.treatments.map((treatment) => (
            <li key={treatment.legacyNumber} className="rounded-xl border border-slate-200 bg-white p-3">
              <p className="font-extrabold">
                #{treatment.legacyNumber} · {treatment.service ?? "معالجة"} · {treatment.treatedOn ?? ""}
                {treatment.doctorName ? ` · ${treatment.doctorName}` : ""}
              </p>
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
