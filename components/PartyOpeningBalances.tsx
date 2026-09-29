"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CURRENCIES, CURRENCY_LABEL, formatMoney, formatAmount, type Currency } from "@/lib/money";
import { friendlyDateLong } from "@/lib/reminders";

/**
 * (FIA-1) ديون المعامل والموردين السابقة لبدء النظام — وأرصدتنا المقدَّمة عندهم.
 *
 * الدَّين السابق **رصيدٌ افتتاحي لا مصروف**: يظهر في كشف الجهة وتقرير الذمم ويُسدَّد بسند الصرف
 * المعتاد (باختيار هذا الرصيد في «السداد»)، ولا يدخل مصروفات الفترة ولا مشترياتها. كل عملةٍ في
 * سطرها: ٣٥٠٬٠٠٠ ر.ي و٥٠٠ ر.س رصيدان لا رقمٌ واحد. والتصحيح بسببٍ مكتوب — والقيمة الأولى تبقى.
 */

interface OpeningPayable {
  id: number; partyId: number; partyName: string; currency: Currency;
  amountMinor: number; originalAmountMinor: number; settledMinor: number; remainingMinor: number;
  asOfDate: string | null; dueDate: string | null; reference: string | null; openingReason: string | null;
  description: string; createdAt: string;
}
interface Adjustment { id: number; payableId: number; deltaMinor: number; reason: string; createdBy: string; createdAt: string }
interface Advance {
  id: number; partyId: number; partyName: string; currency: Currency; amountMinor: number; asOfDate: string;
  reference: string | null; note: string | null; reason: string; createdBy: string;
  voidedAt: string | null; voidedBy: string | null; voidReason: string | null;
}
interface PartyOption { id: number; name: string; kind: string }

const emptyForm = {
  kind: "payable" as "payable" | "advance", partyId: "", currency: "YER" as Currency, amount: "",
  asOfDate: "", dueDate: "", reference: "", note: "", reason: "",
};

export function PartyOpeningBalances() {
  const [payables, setPayables] = useState<OpeningPayable[]>([]);
  const [adjustments, setAdjustments] = useState<Adjustment[]>([]);
  const [advances, setAdvances] = useState<Advance[]>([]);
  const [parties, setParties] = useState<PartyOption[]>([]);
  const [canEdit, setCanEdit] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [correcting, setCorrecting] = useState<{ id: number; amount: string; reason: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/party-openings", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر التحميل.");
      setPayables(payload.payables ?? []);
      setAdjustments(payload.adjustments ?? []);
      setAdvances(payload.advances ?? []);
      setParties(payload.parties ?? []);
      setCanEdit(Boolean(payload.canEdit));
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "تعذّر التحميل.");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  /* لكل عملةٍ مجموعها: الدَّين السابق وما سُدّد منه وما بقي، والأرصدة المقدَّمة لنا — لا مزج. */
  const totals = useMemo(() => CURRENCIES.map((currency) => {
    const rows = payables.filter((row) => row.currency === currency);
    const adv = advances.filter((row) => row.currency === currency && !row.voidedAt);
    return {
      currency,
      owed: rows.reduce((sum, row) => sum + row.amountMinor, 0),
      settled: rows.reduce((sum, row) => sum + row.settledMinor, 0),
      remaining: rows.reduce((sum, row) => sum + row.remainingMinor, 0),
      advance: adv.reduce((sum, row) => sum + row.amountMinor, 0),
    };
  }).filter((row) => row.owed !== 0 || row.advance !== 0), [payables, advances]);

  const send = async (method: "POST" | "PATCH", body: Record<string, unknown>, done: string) => {
    if (busy) return false;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/party-openings", {
        method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) { setError(payload?.message ?? "تعذّر الحفظ."); return false; }
      setNotice(done);
      await load();
      return true;
    } catch {
      setError("تعذّر الاتصال بالخادم.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const ok = await send("POST", {
      kind: form.kind, partyId: Number(form.partyId), currency: form.currency, amount: form.amount,
      asOfDate: form.asOfDate, dueDate: form.dueDate || null, reference: form.reference, note: form.note, reason: form.reason,
    }, form.kind === "payable" ? "حُفظ الدَّين السابق — رصيدٌ افتتاحي لا يدخل مصروفات الفترة." : "حُفظ الرصيد المقدَّم السابق.");
    if (ok) setForm({ ...emptyForm, kind: form.kind, asOfDate: form.asOfDate });
  };

  return (
    <section aria-label="ديون المعامل والموردين السابقة">
      <p className="mb-3 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-xs font-bold leading-5 text-amber-900">
        رصيدٌ افتتاحي — لا يدخل ضمن مصروفات أو مشتريات الفترة الحالية. يُسدَّد من «سند صرف» للجهة باختيار
        هذا الرصيد، فينقص الصندوق والدَّين ولا يُحسب مصروفًا جديدًا.
      </p>

      {error ? <p role="alert" className="mb-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm font-bold text-red-700">{error}</p> : null}
      {notice ? <p className="mb-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-bold text-emerald-800">{notice}</p> : null}

      {totals.length > 0 ? (
        <div className="mb-4 grid gap-2 sm:grid-cols-3" data-testid="party-opening-totals">
          {totals.map((row) => (
            <div key={row.currency} className="rounded-2xl border border-slate-200 bg-white p-3 text-center">
              <p className="text-[11px] font-bold text-slate-500">{CURRENCY_LABEL[row.currency]}</p>
              <p className="text-lg font-extrabold">{formatMoney(row.remaining, row.currency)}</p>
              <p className="text-[11px] text-slate-500">
                متبقٍّ من {formatMoney(row.owed, row.currency)} · سُدّد {formatMoney(row.settled, row.currency)}
              </p>
              {row.advance > 0 ? <p className="text-[11px] font-bold text-emerald-700">رصيد مقدَّم لنا: {formatMoney(row.advance, row.currency)}</p> : null}
            </div>
          ))}
        </div>
      ) : null}

      {canEdit ? (
        <form onSubmit={submit} className="mb-4 grid gap-2 rounded-2xl border border-slate-200 bg-white p-3 sm:grid-cols-2">
          <div className="flex gap-2 sm:col-span-2" role="radiogroup" aria-label="نوع الرصيد">
            {([["payable", "دَينٌ علينا للجهة"], ["advance", "رصيدٌ مقدَّم لنا عند الجهة"]] as const).map(([kind, label]) => (
              <button key={kind} type="button" role="radio" aria-checked={form.kind === kind}
                onClick={() => setForm({ ...form, kind })}
                className={`flex-1 rounded-xl border px-3 py-2 text-xs font-bold ${form.kind === kind ? "border-navy-800 bg-navy-800 text-white" : "border-slate-200 bg-white"}`}>
                {label}
              </button>
            ))}
          </div>
          <label className="text-xs font-bold text-slate-600">المختبر / المورّد
            <select required value={form.partyId} onChange={(e) => setForm({ ...form, partyId: e.target.value })} aria-label="الجهة"
              className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-2 py-2 text-sm">
              <option value="">— اختر —</option>
              {parties.map((party) => (
                <option key={party.id} value={party.id}>{party.name} ({party.kind === "lab" ? "مختبر" : "مورد"})</option>
              ))}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs font-bold text-slate-600">المبلغ
              <input required value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} aria-label="المبلغ"
                inputMode="decimal" dir="ltr" className="mt-1 w-full rounded-xl border border-slate-200 px-2 py-2 text-sm font-bold" />
            </label>
            <label className="text-xs font-bold text-slate-600">العملة
              <select value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value as Currency })} aria-label="العملة"
                className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-2 py-2 text-sm">
                {CURRENCIES.map((currency) => <option key={currency} value={currency}>{CURRENCY_LABEL[currency]}</option>)}
              </select>
            </label>
          </div>
          <label className="text-xs font-bold text-slate-600">حتى تاريخ (تاريخ الرصيد)
            <input required type="date" value={form.asOfDate} onChange={(e) => setForm({ ...form, asOfDate: e.target.value })} aria-label="تاريخ الرصيد"
              className="mt-1 w-full rounded-xl border border-slate-200 px-2 py-2 text-sm" />
          </label>
          {form.kind === "payable" ? (
            <label className="text-xs font-bold text-slate-600">تاريخ الاستحقاق (إن عُرف)
              <input type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} aria-label="تاريخ الاستحقاق"
                className="mt-1 w-full rounded-xl border border-slate-200 px-2 py-2 text-sm" />
            </label>
          ) : <span />}
          <label className="text-xs font-bold text-slate-600">المرجع (رقم الكشف أو الفاتورة القديمة)
            <input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} aria-label="المرجع" maxLength={120}
              className="mt-1 w-full rounded-xl border border-slate-200 px-2 py-2 text-sm" />
          </label>
          <label className="text-xs font-bold text-slate-600">ملاحظة
            <input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} aria-label="ملاحظة" maxLength={300}
              className="mt-1 w-full rounded-xl border border-slate-200 px-2 py-2 text-sm" />
          </label>
          <label className="text-xs font-bold text-slate-600 sm:col-span-2">سبب الإدخال
            <input required value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} aria-label="سبب الإدخال" maxLength={300}
              placeholder="مثل: كشف حساب ورقي حتى أغسطس — رصيد قبل بدء النظام"
              className="mt-1 w-full rounded-xl border border-slate-200 px-2 py-2 text-sm" />
          </label>
          <button type="submit" disabled={busy}
            className="rounded-xl bg-navy-800 py-2.5 text-sm font-extrabold text-white disabled:opacity-50 sm:col-span-2">
            {form.kind === "payable" ? "حفظ الدَّين السابق" : "حفظ الرصيد المقدَّم"}
          </button>
        </form>
      ) : (
        <p className="mb-4 rounded-2xl border border-slate-200 bg-white p-3 text-[11px] font-bold text-slate-500">الإدخال والتصحيح للمدير وحده.</p>
      )}

      {payables.length === 0 && advances.length === 0 ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">لا ديون سابقة مُدخلة للمعامل والموردين.</p>
      ) : null}

      {payables.length > 0 ? (
        <ul className="mb-4 space-y-2" aria-label="الديون السابقة">
          {payables.map((row) => {
            const history = adjustments.filter((adjustment) => adjustment.payableId === row.id);
            return (
              <li key={row.id} className="rounded-2xl border border-slate-200 bg-white p-3" data-opening-payable={row.id}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-extrabold">{row.partyName}</p>
                    <p className="text-[11px] text-slate-500">
                      رصيد افتتاحي حتى {row.asOfDate ? friendlyDateLong(row.asOfDate) : "—"}
                      {row.reference ? ` · ${row.reference}` : ""}
                      {` · الاستحقاق: ${row.dueDate ? friendlyDateLong(row.dueDate) : "غير معروف"}`}
                    </p>
                  </div>
                  <div className="text-end">
                    <p className="text-sm font-extrabold">{formatMoney(row.remainingMinor, row.currency)} متبقٍّ</p>
                    <p className="text-[11px] text-slate-500">من {formatMoney(row.amountMinor, row.currency)} · سُدّد {formatMoney(row.settledMinor, row.currency)}</p>
                  </div>
                </div>
                {history.length > 0 ? (
                  <ul className="mt-2 space-y-0.5 border-t border-dashed border-slate-200 pt-2 text-[11px] text-slate-600">
                    <li>أُدخل أولًا: {formatMoney(row.originalAmountMinor, row.currency)}</li>
                    {history.map((adjustment) => (
                      <li key={adjustment.id}>
                        تصحيح {adjustment.deltaMinor > 0 ? "+" : "−"}{formatMoney(Math.abs(adjustment.deltaMinor), row.currency)}
                        {` · ${adjustment.reason} · ${adjustment.createdBy} · ${adjustment.createdAt.slice(0, 10)}`}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {canEdit ? (
                  correcting?.id === row.id ? (
                    <div className="mt-2 flex flex-wrap items-end gap-2">
                      <label className="text-[11px] font-bold text-slate-600">القيمة الصحيحة
                        <input value={correcting.amount} onChange={(e) => setCorrecting({ ...correcting, amount: e.target.value })}
                          aria-label="القيمة الصحيحة" inputMode="decimal" dir="ltr" className="mt-1 w-28 rounded-lg border border-slate-200 px-2 py-1 text-sm" />
                      </label>
                      <label className="min-w-[10rem] flex-1 text-[11px] font-bold text-slate-600">سبب التصحيح
                        <input value={correcting.reason} onChange={(e) => setCorrecting({ ...correcting, reason: e.target.value })}
                          aria-label="سبب التصحيح" className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-1 text-sm" />
                      </label>
                      <button type="button" disabled={busy}
                        onClick={async () => {
                          if (await send("PATCH", { action: "adjust", payableId: row.id, currency: row.currency, amount: correcting.amount, reason: correcting.reason }, "حُفظ التصحيح — والقيمة السابقة باقية في السجل.")) setCorrecting(null);
                        }}
                        className="rounded-lg bg-navy-800 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50">حفظ التصحيح</button>
                      <button type="button" onClick={() => setCorrecting(null)} className="rounded-lg px-2 py-1.5 text-xs font-bold text-slate-500">إلغاء</button>
                    </div>
                  ) : (
                    <button type="button" onClick={() => setCorrecting({ id: row.id, amount: formatAmount(row.amountMinor, row.currency), reason: "" })}
                      className="mt-2 rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-bold text-navy-800">تصحيح القيمة</button>
                  )
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {advances.length > 0 ? (
        <ul className="space-y-2" aria-label="الأرصدة المقدَّمة السابقة">
          {advances.map((row) => (
            <li key={row.id} className={`rounded-2xl border p-3 ${row.voidedAt ? "border-slate-100 bg-slate-50 opacity-70" : "border-emerald-200 bg-white"}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-extrabold">{row.partyName} — رصيد مقدَّم لنا</p>
                  <p className="text-[11px] text-slate-500">
                    حتى {friendlyDateLong(row.asOfDate)}{row.reference ? ` · ${row.reference}` : ""} · {row.reason}
                    {row.voidedAt ? ` · ملغى: ${row.voidReason} (${row.voidedBy})` : ""}
                  </p>
                </div>
                <p className="text-sm font-extrabold text-emerald-700">{formatMoney(row.amountMinor, row.currency)}</p>
              </div>
              {canEdit && !row.voidedAt ? (
                <button type="button" disabled={busy}
                  onClick={async () => {
                    const reason = window.prompt("سبب إلغاء هذا الرصيد المقدَّم:");
                    if (reason && reason.trim().length >= 3) await send("PATCH", { action: "void_advance", id: row.id, reason }, "أُلغي الرصيد المقدَّم — والسطر باقٍ للتاريخ.");
                  }}
                  className="mt-2 rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-bold text-red-700">إلغاء بسبب</button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
