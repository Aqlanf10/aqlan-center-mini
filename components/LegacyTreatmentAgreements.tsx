"use client";

import { useEffect, useState } from "react";
import { formatMoney, isCurrency } from "@/lib/money";
import { friendlyDateLong } from "@/lib/reminders";
import { LEGACY_CASE_LABEL } from "@/lib/legacy-treatment";

/**
 * (INV-LEGACY) الاتفاقات التاريخية في حساب المريض — منفصلةً عن المستحق الحالي.
 * الحقيقة التاريخية (المتفق، المدفوع قبل النظام، المتبقي عند البدء، التاريخ) للقراءة؛ والمستحق الحالي هو الرصيد أعلاه
 * وحده (والمتبقي جزءٌ منه رصيدًا سابقًا). الإبطال للمدير وبسبب.
 */

interface Agreement {
  id: number; serviceName: string; specialtyLabel: string; toothCode: number | null; caseTitle: string | null;
  currency: string; agreedMinor: number; previouslyPaidMinor: number; remainingMinor: number; historicalAsOf: string;
  openingEffect: "none" | "created" | "increased"; status: "live" | "void"; createdBy: string; voidReason: string | null;
}

const OPENING_TEXT: Record<Agreement["openingEffect"], string> = {
  none: "مسدَّد تاريخيًّا — لا رصيد سابق",
  created: "المتبقي سُجّل رصيدًا سابقًا",
  increased: "المتبقي أُضيف إلى الرصيد السابق",
};

export function LegacyTreatmentAgreements({ patientId, refreshKey, onChanged }: {
  patientId: number; refreshKey: number; onChanged: () => void;
}) {
  const [agreements, setAgreements] = useState<Agreement[]>([]);
  const [canVoid, setCanVoid] = useState(false);
  const [voiding, setVoiding] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/patients/${patientId}/legacy-treatments`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json().catch(() => null) as { agreements?: Agreement[]; access?: { void?: boolean } } | null;
        if (!response.ok || !Array.isArray(payload?.agreements)) { setAgreements([]); return; }
        setAgreements(payload.agreements);
        setCanVoid(payload.access?.void === true);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [patientId, refreshKey, reload]);

  if (agreements.length === 0) return null;

  const submitVoid = async (id: number) => {
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/patients/${patientId}/legacy-treatments/${id}/void`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason }),
      });
      const payload = await response.json().catch(() => null) as { message?: string } | null;
      if (!response.ok) { setMessage(payload?.message ?? "تعذّر الإبطال."); return; }
      setMessage("أُبطل الاتفاق التاريخي وحُرِّرت تغطيته.");
      setVoiding(null); setReason(""); setReload((value) => value + 1); onChanged();
    } catch {
      setMessage("تعذّر الاتصال بالخادم.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="علاجات بدأت قبل النظام" data-testid="legacy-agreements" className="mb-4">
      <h3 className="mb-1 text-sm font-bold">علاجات بدأت قبل النظام ({agreements.filter((one) => one.status === "live").length})</h3>
      <p className="mb-2 text-[11px] leading-4 text-slate-500">
        أرقامٌ تاريخية للمرجع — ليست دَينًا حاليًا ولا سندات. المستحق الحالي هو الرصيد أعلاه وحده.
      </p>
      {message ? <p role="status" className="mb-2 rounded-xl border border-slate-200 bg-slate-50 p-2 text-xs font-bold">{message}</p> : null}
      <ul className="space-y-2">
        {agreements.map((agreement) => {
          const currency = isCurrency(agreement.currency) ? agreement.currency : "YER";
          return (
            <li key={agreement.id} data-testid={`legacy-agreement-${agreement.id}`}
              className={`rounded-2xl border p-3 ${agreement.status === "live" ? "border-indigo-200 bg-white" : "border-slate-200 bg-slate-50 opacity-70"}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 text-sm font-extrabold">
                  {agreement.serviceName}{agreement.toothCode ? ` — سن ${agreement.toothCode}` : ""}
                </span>
                <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-bold text-indigo-800">
                  {agreement.status === "live" ? LEGACY_CASE_LABEL : "مُبطَل"}
                </span>
              </div>
              <p className="mt-0.5 text-[11px] text-slate-500">
                {agreement.specialtyLabel}{agreement.caseTitle ? ` · ${agreement.caseTitle}` : ""} · المعلومات حتى {friendlyDateLong(agreement.historicalAsOf)}
              </p>
              <dl className="mt-2 grid grid-cols-1 gap-1.5 text-center text-xs sm:grid-cols-3">
                <div className="rounded-lg bg-slate-50 px-1.5 py-1.5">
                  <dt className="text-[10px] text-slate-500">المتفق عليه أصلًا</dt>
                  <dd className="font-extrabold">{formatMoney(agreement.agreedMinor, currency)}</dd>
                </div>
                <div className="rounded-lg bg-emerald-50 px-1.5 py-1.5">
                  <dt className="text-[10px] text-emerald-700">المدفوع قبل النظام</dt>
                  <dd className="font-extrabold text-emerald-800">{formatMoney(agreement.previouslyPaidMinor, currency)}</dd>
                </div>
                <div className="rounded-lg bg-amber-50 px-1.5 py-1.5">
                  <dt className="text-[10px] text-amber-800">المتبقي عند بدء النظام</dt>
                  <dd className="font-extrabold text-amber-900">{formatMoney(agreement.remainingMinor, currency)}</dd>
                </div>
              </dl>
              <p className="mt-1.5 text-[11px] text-slate-500">
                {OPENING_TEXT[agreement.openingEffect]} · لا سند للمدفوع سابقًا · سجّله {agreement.createdBy}
                {agreement.voidReason ? ` · سبب الإبطال: ${agreement.voidReason}` : ""}
              </p>
              {canVoid && agreement.status === "live" ? (
                voiding === agreement.id ? (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={300}
                      aria-label="سبب إبطال الاتفاق التاريخي" placeholder="سبب الإبطال"
                      className="min-h-11 min-w-0 flex-1 rounded-xl border border-amber-200 bg-amber-50/50 px-3 py-2 text-xs" />
                    <button type="button" disabled={busy || reason.trim().length < 3} onClick={() => void submitVoid(agreement.id)}
                      className="min-h-11 rounded-xl bg-red-600 px-3 py-2 text-xs font-bold text-white disabled:opacity-50">تأكيد الإبطال</button>
                    <button type="button" onClick={() => { setVoiding(null); setReason(""); }}
                      className="min-h-11 rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600">تراجع</button>
                  </div>
                ) : (
                  <button type="button" onClick={() => { setVoiding(agreement.id); setMessage(null); }}
                    className="mt-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-bold text-amber-800">
                    إبطال الاتفاق
                  </button>
                )
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
