"use client";

import { useCallback, useEffect, useState } from "react";
import { PARTY_KIND_LABEL, type PartyKind } from "@/lib/expenses";
import { formatMoney, isCurrency, type Currency } from "@/lib/money";
import { PageHeader } from "@/components/PageHeader";
import { financeLinks } from "@/components/financeLinks";

/**
 * الجهات: مختبرات وموردون وأطباء.
 *
 * جدول واحد لأن السؤال عنها واحد: كم لهذه الجهة عندنا وكم دفعنا لها. والطبيب هنا
 * لا في جدول منفصل لأن علاقته المالية بالعيادة من نوع علاقة المورّد: مستحقٌّ يتراكم
 * ويُصرف بسند.
 */

interface Party {
  id: number; name: string; kind: PartyKind; phone: string | null;
  note: string | null; commissionPercent: number; isActive: boolean;
}

const KINDS: PartyKind[] = ["lab", "supplier", "doctor"];

export default function PartiesPage() {
  const [parties, setParties] = useState<Party[]>([]);
  const [balances, setBalances] = useState<Map<number, number>>(new Map());
  const [base, setBase] = useState<Currency>("YER");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: "", kind: "lab" as PartyKind, phone: "", commissionPercent: "" });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [response, balancesResponse] = await Promise.all([
        fetch("/api/parties", { cache: "no-store" }),
        fetch("/api/payables", { cache: "no-store" }),
      ]);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر التحميل.");
      setParties(payload as Party[]);
      if (balancesResponse.ok) {
        const data = await balancesResponse.json();
        setBalances(new Map((data.balances as { partyId: number; dueMinor: number }[])
          .map((row) => [row.partyId, row.dueMinor])));
        if (isCurrency(data.baseCurrency)) setBase(data.baseCurrency);
      }
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "تعذّر التحميل.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const send = useCallback(async (run: () => Promise<Response>) => {
    if (busy) return false;
    setBusy(true);
    try {
      const response = await run();
      const payload = await response.json().catch(() => null);
      if (!response.ok) { setError(payload?.message ?? "تعذّر التنفيذ."); return false; }
      setError(null);
      await load();
      return true;
    } catch {
      setError("تعذّر الاتصال بالخادم.");
      return false;
    } finally {
      setBusy(false);
    }
  }, [busy, load]);

  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    const ok = await send(() => fetch("/api/parties", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    }));
    if (ok) setForm({ name: "", kind: form.kind, phone: "", commissionPercent: "" });
  };

  return (
    <main className="mx-auto max-w-3xl p-4 pb-24">
      <PageHeader
        title="الجهات"
        subtitle="المختبرات والموردون والأطباء"
        links={financeLinks("/finance/parties")}
      />

      {error ? (
        <p role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</p>
      ) : null}

      <form onSubmit={add} className="mb-5 rounded-2xl border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-bold">جهة جديدة</h2>
        <div className="mb-2 flex gap-1.5">
          {KINDS.map((kind) => (
            <button key={kind} type="button" onClick={() => setForm((current) => ({ ...current, kind }))}
              className={`flex-1 rounded-xl border px-3 py-2 text-sm font-bold ${
                form.kind === kind ? "border-brand-blue bg-brand-blue text-white" : "border-slate-200 bg-white text-slate-600"
              }`}>
              {PARTY_KIND_LABEL[kind]}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <input value={form.name} onChange={(e) => setForm((c) => ({ ...c, name: e.target.value }))}
            placeholder="الاسم" aria-label="الاسم"
            className="min-w-[10rem] flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand-blue" />
          <input value={form.phone} onChange={(e) => setForm((c) => ({ ...c, phone: e.target.value }))}
            placeholder="الجوال" aria-label="الجوال" dir="ltr" inputMode="tel"
            className="w-36 rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand-blue" />
          {form.kind === "doctor" ? (
            <input value={form.commissionPercent} onChange={(e) => setForm((c) => ({ ...c, commissionPercent: e.target.value }))}
              placeholder="نسبة %" aria-label="نسبة العمولة" dir="ltr" inputMode="decimal"
              className="w-24 rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand-blue" />
          ) : null}
          <button type="submit" disabled={busy || !form.name.trim()}
            className="rounded-xl bg-brand-orange px-5 py-2 text-sm font-bold text-white disabled:opacity-50">
            أضف
          </button>
        </div>
      </form>

      {loading ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">جارٍ التحميل…</p>
      ) : parties.length === 0 ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">
          لا جهات بعد. أضف مختبراتك وأطباءك أولًا.
        </p>
      ) : (
        KINDS.map((kind) => {
          const list = parties.filter((party) => party.kind === kind);
          if (list.length === 0) return null;
          return (
            <section key={kind} className="mb-4">
              <h2 className="mb-2 text-sm font-bold">{PARTY_KIND_LABEL[kind]}</h2>
              <ul className="space-y-2">
                {list.map((party) => (
                  <li key={party.id} className={`flex flex-wrap items-center gap-2 rounded-2xl border p-3 ${
                    party.isActive ? "border-slate-200 bg-white" : "border-slate-200 bg-slate-50 opacity-60"
                  }`}>
                    <div className="min-w-[8rem] flex-1">
                      <a href={`/finance/parties/${party.id}`} className="block truncate text-sm font-extrabold underline decoration-slate-300 underline-offset-4">
                        {party.name}
                      </a>
                      {party.phone ? <p className="text-[11px] text-slate-500" dir="ltr">{party.phone}</p> : null}
                    </div>
                    {kind === "doctor" ? (
                      <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-bold text-slate-600">
                        عمولة {party.commissionPercent}%
                      </span>
                    ) : null}
                    {/* الرصيد بجانب الاسم لا في شاشة أخرى: من يفتح قائمة الجهات
                        يسأل عن المستحق، لا عن أسمائها. والأطباء مستثنون لأن
                        مستحقهم يُحسب من نسبتهم على المحصّل في تقرير العمولات. */}
                    {kind !== "doctor" && (balances.get(party.id) ?? 0) !== 0 ? (
                      <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${
                        (balances.get(party.id) ?? 0) > 0 ? "bg-amber-100 text-amber-900" : "bg-slate-100 text-slate-600"
                      }`}>
                        {(balances.get(party.id) ?? 0) > 0
                          ? `علينا ${formatMoney(balances.get(party.id) ?? 0, base)}`
                          : `زيادة ${formatMoney(-(balances.get(party.id) ?? 0), base)}`}
                      </span>
                    ) : null}
                    {kind === "doctor" ? (
                      <a href="/finance/commissions" className="rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-bold text-navy-800">
                        عمولاته
                      </a>
                    ) : null}
                    <button
                      onClick={() => send(() => fetch(`/api/parties/${party.id}`, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ isActive: !party.isActive }),
                      }))}
                      disabled={busy}
                      className="rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-bold text-slate-500 disabled:opacity-40">
                      {party.isActive ? "إيقاف" : "تفعيل"}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          );
        })
      )}
    </main>
  );
}
