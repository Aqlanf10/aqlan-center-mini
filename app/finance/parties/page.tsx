"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PARTY_KIND_LABEL, type PartyKind } from "@/lib/expenses";
import { formatMoney } from "@/lib/money";
import { PARTY_BALANCE_VIEW, partyBalanceIdentities, readPartyNativeBalances, type PartyNativeBalance } from "@/lib/party-native-balances";
import { PageHeader } from "@/components/PageHeader";
import { financeLinks } from "@/components/financeLinks";
import { useSession } from "@/components/SessionProvider";
import { canHandleMoney, canViewMoney } from "@/lib/roles";

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
  const session = useSession();
  // Remount in the identity-changing render, before any effect can expose the
  // previous principal's financial snapshot. Cleanup also rejects late reads.
  return <PartyList key={JSON.stringify([session?.username, session?.role, session?.permissions ?? null])}
    canMutate={canHandleMoney(session?.role)} canRead={canViewMoney(session?.role)} />;
}

function PartyList({ canMutate, canRead }: { canMutate: boolean; canRead: boolean }) {
  const [parties, setParties] = useState<Party[]>([]);
  const [balances, setBalances] = useState<Map<number, PartyNativeBalance[]> | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: "", kind: "lab" as PartyKind, phone: "", commissionPercent: "" });
  const mounted = useRef(false);
  const requestId = useRef(0);
  const controller = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    if (!mounted.current) return;
    const id = ++requestId.current;
    controller.current?.abort();
    const active = new AbortController();
    controller.current = active;
    setLoading(true);
    setBalances(null);
    setLoadError(null);
    const read = async (url: string): Promise<unknown> => {
      const response = await fetch(url, { cache: "no-store", signal: active.signal });
      if (!response.ok) throw new Error("تعذّر تحميل الأرصدة.");
      const payload = await response.json();
      return payload;
    };
    const [catalog, native] = await Promise.allSettled([
      read("/api/parties"),
      canRead ? read(`/api/payables?view=${PARTY_BALANCE_VIEW}`) : Promise.reject(new Error("Unavailable")),
    ]);
    if (!mounted.current || id !== requestId.current || active.signal.aborted) return;
    try {
      if (catalog.status !== "fulfilled" || !Array.isArray(catalog.value)) throw new Error("Invalid catalog");
      const rows = catalog.value as Party[];
      // Validate identities even when the balance read fails, so the catalog
      // can remain visible with explicit unavailable badges and a retry.
      partyBalanceIdentities(rows);
      setParties(rows);
      if (native.status !== "fulfilled") throw new Error("Unavailable");
      // Complete native identity coverage must match this catalog before any
      // omitted currency buckets can mean zero, including no-activity parties.
      setBalances(readPartyNativeBalances(native.value, rows));
    } catch {
      setBalances(null);
      setLoadError("الأرصدة غير متاحة الآن. أعد المحاولة؛ تعذّر تأكيد صافي الجهات.");
    } finally {
      setLoading(false);
    }
  }, [canRead]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      requestId.current += 1;
      controller.current?.abort();
    };
  }, [load]);

  const send = useCallback(async (run: () => Promise<Response>) => {
    if (busy) return false;
    setBusy(true);
    try {
      const response = await run();
      const payload = await response.json().catch(() => null);
      if (!mounted.current) return false;
      if (!response.ok) { setError(payload?.message ?? "تعذّر التنفيذ."); return false; }
      setError(null);
      await load();
      return mounted.current;
    } catch {
      if (mounted.current) setError("تعذّر الاتصال بالخادم.");
      return false;
    } finally {
      if (mounted.current) setBusy(false);
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
    <main data-testid="party-native-balances" className="mx-auto max-w-3xl p-4 pb-24">
      <PageHeader
        title="الجهات"
        subtitle="المختبرات والموردون والأطباء"
        links={financeLinks("/finance/parties")}
      />

      {error ? (
        <p role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</p>
      ) : null}

      <div className="mb-4 rounded-xl border border-slate-200 bg-white p-3 text-sm text-slate-600">
        <p>صافي الجهة بكل عملة على حدة، ويشمل الدفعات على الحساب غير المرتبطة بفاتورة. صافي الصفر لا يعني تسوية كل فاتورة.</p>
        {loadError ? <p role="alert" className="mt-2 text-red-700">{loadError}</p> : null}
        <button type="button" onClick={() => { void load(); }} disabled={busy}
          aria-label="تحديث أرصدة الجهات"
          className="mt-2 rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-bold text-navy-800 disabled:opacity-40">
          {loadError ? "إعادة المحاولة" : "تحديث الأرصدة"}
        </button>
      </div>

      {canMutate ? <form onSubmit={add} className="mb-5 rounded-2xl border border-slate-200 bg-white p-4">
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
      </form> : null}

      {loading ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">جارٍ التحميل…</p>
      ) : parties.length === 0 && loadError ? null : parties.length === 0 ? (
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
                  <li key={party.id} data-testid={`party-row-${party.id}`} className={`flex flex-wrap items-center gap-2 rounded-2xl border p-3 ${
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
                    {kind !== "doctor" ? (
                      !balances?.has(party.id) ? (
                        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-bold text-slate-600">الرصيد غير متاح</span>
                      ) : balances.get(party.id)!.length === 0 ? (
                        <span data-testid="party-native-zero" className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-bold text-slate-600">صافي الجهة صفر</span>
                      ) : balances.get(party.id)!.map(({ currency, dueMinor }) => (
                        <span key={currency} data-testid="party-native-balance" data-currency={currency}
                          className={`rounded-full px-2.5 py-1 text-xs font-bold ${dueMinor > 0 ? "bg-amber-100 text-amber-900" : "bg-slate-100 text-slate-600"}`}>
                          {dueMinor > 0 ? "علينا" : "لنا"} {formatMoney(Math.abs(dueMinor), currency)} ({currency})
                        </span>
                      ))
                    ) : null}
                    {kind === "doctor" ? (
                      <a href="/finance/commissions" className="rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-bold text-navy-800">
                        عمولاته
                      </a>
                    ) : null}
                    {canMutate ? <button
                      onClick={() => send(() => fetch(`/api/parties/${party.id}`, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ isActive: !party.isActive }),
                      }))}
                      disabled={busy}
                      className="rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-bold text-slate-500 disabled:opacity-40">
                      {party.isActive ? "إيقاف" : "تفعيل"}
                    </button> : null}
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
