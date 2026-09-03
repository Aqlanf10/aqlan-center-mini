"use client";

import { useCallback, useEffect, useState } from "react";
import { formatMoney, toInputAmount, CURRENCIES, type Currency } from "@/lib/money";
import { friendlyDateLong } from "@/lib/reminders";
import { useSession } from "@/components/SessionProvider";
import { PageHeader } from "@/components/PageHeader";
import { financeLinks } from "@/components/financeLinks";
import { isAdmin } from "@/lib/roles";

interface CashierShift {
  id: number;
  openedBy: string;
  openedAt: string;
  opening: Record<Currency, number>;
  closedBy: string | null;
  closedAt: string | null;
  counted: Record<Currency, number> | null;
  note: string | null;
  status: "open" | "closed";
}

interface OpenShiftData {
  shift: CashierShift;
  paymentsCount: number;
  expensesCount: number;
  income: Record<Currency, number>;
  refunds: Record<Currency, number>;
  expenses: Record<Currency, number>;
  expected: Record<Currency, number>;
}

export default function ReconciliationPage() {
  const session = useSession();
  const [openShift, setOpenShift] = useState<OpenShiftData | null>(null);
  const [shifts, setShifts] = useState<CashierShift[]>([]);
  const [baseCurrency, setBaseCurrency] = useState<Currency>("YER");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Close shift form state
  const [counted, setCounted] = useState<Record<Currency, string>>({ YER: "", SAR: "", USD: "" });
  const [closeNote, setCloseNote] = useState("");
  const [showCloseModal, setShowCloseModal] = useState(false);

  // Open shift form state
  const [openAmounts, setOpenAmounts] = useState<Record<Currency, string>>({ YER: "0", SAR: "0", USD: "0" });
  const [showOpenModal, setShowOpenModal] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/finance/reconciliation", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || "تعذر تحميل البيانات.");
      setOpenShift(data.openShift);
      setShifts(data.shifts || []);
      setBaseCurrency(data.baseCurrency || "YER");
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "حدث خطأ غير متوقع.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const handleOpenShift = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/shifts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          opening: {
            YER: Number(openAmounts.YER || 0),
            SAR: Number(openAmounts.SAR || 0),
            USD: Number(openAmounts.USD || 0),
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || "فشل فتح الوردية.");
      setShowOpenModal(false);
      await loadData();
    } catch (err) {
      alert(err instanceof Error ? err.message : "فشل فتح الوردية.");
    } finally {
      setBusy(false);
    }
  };

  const handleCloseShift = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!openShift || busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/shifts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: openShift.shift.id,
          counted: {
            YER: Number(counted.YER || 0),
            SAR: Number(counted.SAR || 0),
            USD: Number(counted.USD || 0),
          },
          note: closeNote.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || "فشل إغلاق الوردية ومطابقة الصندوق.");
      setShowCloseModal(false);
      setCounted({ YER: "", SAR: "", USD: "" });
      setCloseNote("");
      await loadData();
    } catch (err) {
      alert(err instanceof Error ? err.message : "فشل إغلاق الوردية.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-5">
      <PageHeader
        title="إقفال ومطابقة اليومية"
        subtitle="المطابقة اليومية والرقابة النقدية وفق المعايير العالمية لضبط حركة الصندوق والورديات"
        links={financeLinks("/finance/reconciliation")}
      />

      {error ? (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-semibold text-red-700">
          {error}
        </div>
      ) : null}

      {/* الحالة الحالية للصندوق */}
      <section className="mb-8 rounded-2xl border border-slate-200 bg-white p-5 shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-100 pb-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-bold text-navy-900">الوردية الحالية</h2>
              {openShift ? (
                <span className="inline-flex items-center rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-bold text-emerald-800">
                  مفتوحة
                </span>
              ) : (
                <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-bold text-slate-600">
                  مغلقة
                </span>
              )}
            </div>
            <p className="mt-1 text-xs text-slate-500">
              {openShift
                ? `فُتحت بواسطة ${openShift.shift.openedBy} في ${friendlyDateLong(openShift.shift.openedAt)}`
                : "لا توجد وردية مفتوحة حاليًا. يجب فتح وردية لتسجيل المقبوضات والمصروفات."}
            </p>
          </div>

          <div>
            {openShift ? (
              <button
                onClick={() => {
                  /* المتوقع يرجع بالوحدات الصغرى — والدرج يُدخل بالكبرى (الخادم
                     يقرأه بـ parseAmount). ملء الكبرى بالصغرى كان يجعل إقفال أي
                     درجٍ به سعودية أو دولار كأن فيه مئة ضعف المتوقع. */
                  setCounted({
                    YER: toInputAmount(openShift.expected.YER || 0, "YER"),
                    SAR: toInputAmount(openShift.expected.SAR || 0, "SAR"),
                    USD: toInputAmount(openShift.expected.USD || 0, "USD"),
                  });
                  setShowCloseModal(true);
                }}
                className="rounded-xl bg-red-600 px-4 py-2 text-xs font-bold text-white transition hover:bg-red-700 shadow-sm"
              >
                جرد وإقفال الوردية
              </button>
            ) : (
              <button
                onClick={() => setShowOpenModal(true)}
                className="rounded-xl bg-navy-900 px-4 py-2 text-xs font-bold text-white transition hover:bg-navy-800 shadow-sm"
              >
                فتح وردية جديدة
              </button>
            )}
          </div>
        </div>

        {openShift ? (
          <div className="mt-5">
            <div className="grid gap-4 sm:grid-cols-3">
              {CURRENCIES.map((cur) => {
                const op = openShift.shift.opening[cur] || 0;
                const inc = openShift.income[cur] || 0;
                const ref = openShift.refunds[cur] || 0;
                const exp = openShift.expenses[cur] || 0;
                const expc = openShift.expected[cur] || 0;

                return (
                  <div key={cur} className="rounded-xl border border-slate-200 bg-slate-50/70 p-4">
                    <div className="flex items-center justify-between border-b border-slate-200 pb-2">
                      <span className="text-xs font-bold text-slate-700">عملة {cur}</span>
                      <span className="text-xs font-bold text-navy-900">المتوقع في الدرج</span>
                    </div>

                    <div className="mt-3 space-y-1.5 text-xs">
                      <div className="flex justify-between text-slate-600">
                        <span>الرصيد الافتتاحي:</span>
                        <span className="font-semibold">{formatMoney(op, cur)}</span>
                      </div>
                      <div className="flex justify-between text-emerald-700">
                        <span>+ المقبوضات:</span>
                        <span className="font-semibold">{formatMoney(inc, cur)}</span>
                      </div>
                      {ref > 0 ? (
                        <div className="flex justify-between text-amber-700">
                          <span>- المستردات:</span>
                          <span className="font-semibold">{formatMoney(ref, cur)}</span>
                        </div>
                      ) : null}
                      <div className="flex justify-between text-rose-700">
                        <span>- سندات الصرف:</span>
                        <span className="font-semibold">{formatMoney(exp, cur)}</span>
                      </div>
                      <div className="flex justify-between border-t border-slate-200 pt-2 font-bold text-navy-900">
                        <span>الرصيد النظري (المحسوب):</span>
                        <span className="text-sm text-navy-900">{formatMoney(expc, cur)}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-4 text-xs text-slate-500 bg-slate-50 rounded-xl p-3 border border-slate-200">
              <span>إجمالي الحركات: <strong>{openShift.paymentsCount}</strong> مقبوضات / مستردات</span>
              <span>•</span>
              <span>سندات الصرف: <strong>{openShift.expensesCount}</strong> سند</span>
              <span>•</span>
              <span className="text-slate-400">أي فارق أثناء الإقفال يُرحل تلقائيًا كقيد عجز/زيادة في الدفاتر المحاسبية.</span>
            </div>
          </div>
        ) : null}
      </section>

      {/* سجل إقفال الورديات السابقة والمطابقات */}
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-card">
        <h3 className="mb-4 text-base font-bold text-navy-900">سجل إقفال الورديات والمطابقة الرقابية</h3>

        {loading ? (
          <p className="py-8 text-center text-xs text-slate-400">جارٍ التحميل…</p>
        ) : shifts.length === 0 ? (
          <p className="py-8 text-center text-xs text-slate-400">لا توجد ورديات مسجلة حتى الآن.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-right text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500 font-semibold">
                  <th className="pb-3 pr-2">رقم الوردية</th>
                  <th className="pb-3">أمين الصندوق</th>
                  <th className="pb-3">تاريخ الفتح</th>
                  <th className="pb-3">تاريخ الإقفال</th>
                  <th className="pb-3">المجرود (الفعلي)</th>
                  <th className="pb-3">الحالة</th>
                  <th className="pb-3 pl-2">ملاحظات</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {shifts.map((s) => (
                  <tr key={s.id} className="hover:bg-slate-50/80 transition">
                    <td className="py-3 pr-2 font-bold text-navy-900">#{s.id}</td>
                    <td className="py-3 font-semibold text-slate-700">{s.openedBy}</td>
                    <td className="py-3 text-slate-500">{friendlyDateLong(s.openedAt)}</td>
                    <td className="py-3 text-slate-500">
                      {s.closedAt ? friendlyDateLong(s.closedAt) : "—"}
                    </td>
                    <td className="py-3 font-mono text-slate-700">
                      {s.counted ? (
                        <div className="space-y-0.5">
                          {CURRENCIES.map((c) => (
                            <span key={c} className="block text-[11px]">
                              {formatMoney(s.counted?.[c] || 0, c)}
                            </span>
                          ))}
                        </div>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="py-3">
                      {s.status === "open" ? (
                        <span className="inline-flex rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-800">
                          مفتوحة
                        </span>
                      ) : (
                        <span className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-600">
                          مقفل ومطابق
                        </span>
                      )}
                    </td>
                    <td className="py-3 pl-2 text-slate-400 max-w-xs truncate">{s.note || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Modal: فتح وردية جديدة */}
      {showOpenModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-navy-900/40 p-4 backdrop-blur-xs">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <h3 className="text-base font-bold text-navy-900">فتح وردية جديدة</h3>
            <p className="mt-1 text-xs text-slate-500">أدخل الرصيد الافتتاحي الموجود في الدرج قبل بدء الاستلام.</p>

            <form onSubmit={handleOpenShift} className="mt-4 space-y-3">
              {CURRENCIES.map((cur) => (
                <div key={cur}>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    الرصيد الافتتاحي ({cur})
                  </label>
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={openAmounts[cur]}
                    onChange={(e) => setOpenAmounts({ ...openAmounts, [cur]: e.target.value })}
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand-blue"
                  />
                </div>
              ))}

              <div className="mt-6 flex items-center justify-end gap-2 border-t border-slate-100 pt-4">
                <button
                  type="button"
                  onClick={() => setShowOpenModal(false)}
                  className="rounded-xl border border-slate-200 px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className="rounded-xl bg-navy-900 px-4 py-2 text-xs font-bold text-white hover:bg-navy-800 disabled:opacity-50"
                >
                  تأكيد وفتح الوردية
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {/* Modal: جرد وإقفال الوردية */}
      {showCloseModal && openShift ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-navy-900/40 p-4 backdrop-blur-xs">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <h3 className="text-base font-bold text-navy-900">جرد وإقفال الوردية الحالية</h3>
            <p className="mt-1 text-xs text-slate-500">
              عدّ النقدية الفعلية في الدرج وأدخل المبالغ لمطابقتها مع الحسابات.
            </p>

            <form onSubmit={handleCloseShift} className="mt-4 space-y-3">
              {CURRENCIES.map((cur) => (
                <div key={cur}>
                  <div className="flex justify-between text-xs font-bold text-slate-700 mb-1">
                    <span>المبلغ الفعلي في الدرج ({cur})</span>
                    <span className="text-slate-400">المتوقع: {formatMoney(openShift.expected[cur] || 0, cur)}</span>
                  </div>
                  <input
                    type="number"
                    step="any"
                    required
                    value={counted[cur]}
                    onChange={(e) => setCounted({ ...counted, [cur]: e.target.value })}
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand-blue"
                  />
                </div>
              ))}

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  ملاحظات أو مبررات الفوارق (اختياري)
                </label>
                <textarea
                  rows={2}
                  value={closeNote}
                  onChange={(e) => setCloseNote(e.target.value)}
                  placeholder="مثال: تم إيداع 50,000 في الحساب البنكي أو جرد مطابق"
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs outline-none focus:border-brand-blue"
                />
              </div>

              <div className="mt-6 flex items-center justify-end gap-2 border-t border-slate-100 pt-4">
                <button
                  type="button"
                  onClick={() => setShowCloseModal(false)}
                  className="rounded-xl border border-slate-200 px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className="rounded-xl bg-red-600 px-4 py-2 text-xs font-bold text-white hover:bg-red-700 disabled:opacity-50"
                >
                  تأكيد الإقفال والمطابقة
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </main>
  );
}
