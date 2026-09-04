"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { formatMoney, toInputAmount, parseAmount, type Currency } from "@/lib/money";
import {
  reconcileLabStatement,
  type ReconcileOrderItem,
  type ReconcileResult,
} from "@/lib/lab-reconciliation";

interface LabPartySummary {
  partyId: number;
  partyName: string;
  currency: Currency;
  phone: string | null;
  activeOrdersCount: number;
  unsettledOrdersCount: number;
  unsettledCostMinor: number;
}

interface LabReconciliationModalProps {
  initialPartyId?: number | null;
  onClose: () => void;
  onSuccess?: () => void;
}

export function LabReconciliationModal({
  initialPartyId,
  onClose,
  onSuccess,
}: LabReconciliationModalProps) {
  const [labs, setLabs] = useState<LabPartySummary[]>([]);
  const [selectedPartyId, setSelectedPartyId] = useState<number | null>(initialPartyId ?? null);
  const [loadingLabs, setLoadingLabs] = useState(true);

  // أوامر المختبر المحدد
  const [orders, setOrders] = useState<ReconcileOrderItem[]>([]);
  const [loadingOrders, setLoadingOrders] = useState(false);
  const [selectedOrderIds, setSelectedOrderIds] = useState<number[]>([]);
  const [customClaimed, setCustomClaimed] = useState<Record<number, string>>({});

  const [monthLabel, setMonthLabel] = useState<string>(() => {
    const d = new Date();
    return `${d.toLocaleString("ar-YE", { month: "long" })} ${d.getFullYear()}`;
  });

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settledResult, setSettledResult] = useState<{
    voucherNumber: string;
    settledCount: number;
    totalPaidMinor: number;
    currency: Currency;
  } | null>(null);

  // تحميل قائمة المختبرات
  const loadLabs = useCallback(async () => {
    setLoadingLabs(true);
    try {
      const res = await fetch("/api/finance/lab-reconciliation");
      const data = await res.json();
      if (res.ok && Array.isArray(data.labs)) {
        setLabs(data.labs);
        if (!selectedPartyId && data.labs.length > 0) {
          setSelectedPartyId(data.labs[0].partyId);
        }
      }
    } catch {
      setError("تعذّر تحميل قائمة المختبرات.");
    } finally {
      setLoadingLabs(false);
    }
  }, [selectedPartyId]);

  useEffect(() => {
    void loadLabs();
  }, [loadLabs]);

  // تحميل أوامر المختبر المحدد
  const loadPartyOrders = useCallback(async (partyId: number) => {
    setLoadingOrders(true);
    setError(null);
    try {
      const res = await fetch(`/api/finance/lab-reconciliation?partyId=${partyId}`);
      const data = await res.json();
      if (res.ok && Array.isArray(data.orders)) {
        const orderList = data.orders as ReconcileOrderItem[];
        setOrders(orderList);
        // تحديد الأوامر غير المسددة افتراضياً
        const unsettledIds = orderList
          .filter((o) => o.financialStatus !== "paid")
          .map((o) => o.orderId);
        setSelectedOrderIds(unsettledIds);
      } else {
        setOrders([]);
        setSelectedOrderIds([]);
      }
    } catch {
      setError("تعذّر تحميل أوامر المعمل.");
    } finally {
      setLoadingOrders(false);
    }
  }, []);

  useEffect(() => {
    if (selectedPartyId) {
      void loadPartyOrders(selectedPartyId);
    }
  }, [selectedPartyId, loadPartyOrders]);

  const activeParty = useMemo(
    () => labs.find((l) => l.partyId === selectedPartyId),
    [labs, selectedPartyId],
  );

  // حساب نتيجة المطابقة
  const reconcileData: ReconcileResult | null = useMemo(() => {
    if (!activeParty) return null;

    const customMinor: Record<number, number> = {};
    for (const [idStr, valStr] of Object.entries(customClaimed)) {
      if (valStr.trim()) {
        const parsed = parseAmount(valStr, activeParty.currency);
        if (parsed !== null) {
          customMinor[Number(idStr)] = parsed;
        }
      }
    }

    return reconcileLabStatement({
      partyId: activeParty.partyId,
      partyName: activeParty.partyName,
      currency: activeParty.currency,
      items: orders,
      selectedIds: selectedOrderIds,
      customClaimedCosts: customMinor,
    });
  }, [activeParty, orders, selectedOrderIds, customClaimed]);

  const toggleSelectAll = () => {
    if (selectedOrderIds.length === orders.length) {
      setSelectedOrderIds([]);
    } else {
      setSelectedOrderIds(orders.map((o) => o.orderId));
    }
  };

  const toggleOrder = (orderId: number) => {
    setSelectedOrderIds((prev) =>
      prev.includes(orderId) ? prev.filter((id) => id !== orderId) : [...prev, orderId],
    );
  };

  // تنفيذ التسوية وسداد الكشف
  const handleSettle = async () => {
    if (!activeParty || !reconcileData || selectedOrderIds.length === 0) return;

    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/finance/lab-reconciliation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          partyId: activeParty.partyId,
          orderIds: selectedOrderIds,
          amountMinor: reconcileData.totalClaimedCostMinor,
          currency: activeParty.currency,
          monthLabel,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.message || "تعذّر إتمام التسوية.");
        setBusy(false);
        return;
      }

      setSettledResult({
        voucherNumber: data.voucherNumber,
        settledCount: data.settledCount,
        totalPaidMinor: data.totalPaidMinor,
        currency: activeParty.currency,
      });

      if (onSuccess) onSuccess();
    } catch {
      setError("تعذّر الاتصال بخادم المركز.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-navy-950/75 p-3 sm:p-4 backdrop-blur-xs overflow-y-auto"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="relative w-full max-w-4xl rounded-3xl bg-white p-5 sm:p-6 shadow-2xl border border-slate-200 my-8">
        {/* الترويسة */}
        <div className="flex items-center justify-between border-b border-slate-100 pb-4 mb-5">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-indigo-600 to-sky-600 flex items-center justify-center text-white text-xl shadow-xs">
              📑
            </div>
            <div>
              <h2 className="text-lg font-black text-slate-900">
                معالج المطابقة والتسوية الشهرية لكشوف المختبرات
              </h2>
              <p className="text-xs font-semibold text-slate-500">
                مطابقة كشف حساب الفني مع أوامر العيادة وسداد مجمع بسند صرف رسمي موحد
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            ✕
          </button>
        </div>

        {error && (
          <div className="mb-4 p-3.5 rounded-2xl bg-rose-50 border border-rose-200 text-rose-800 text-xs sm:text-sm font-bold flex items-center gap-2">
            <span>⚠️</span>
            <span>{error}</span>
          </div>
        )}

        {/* إذا تمت التسوية بنجاح: بطاقة النتيجة والشهادة */}
        {settledResult ? (
          <div className="py-8 text-center space-y-4">
            <div className="w-16 h-16 rounded-full bg-emerald-100 text-emerald-700 text-3xl mx-auto flex items-center justify-center">
              ✓
            </div>
            <div className="space-y-1">
              <h3 className="text-xl font-black text-slate-900">
                تم اعتماد المطابقة وإصدار سند الصرف المجمع بنجاح!
              </h3>
              <p className="text-sm font-semibold text-slate-500">
                سند صرف رقم: <strong className="font-mono text-brand-orange">{settledResult.voucherNumber}</strong>
              </p>
            </div>

            <div className="inline-block p-4 rounded-2xl bg-slate-50 border border-slate-200 text-right text-xs space-y-1">
              <p>المختبر المسدد: <strong>{activeParty?.partyName}</strong></p>
              <p>عدد الأوامر المسوية: <strong>{settledResult.settledCount} أمر عمل</strong></p>
              <p>إجمالي المبلغ المصروف: <strong className="font-mono text-emerald-700">{formatMoney(settledResult.totalPaidMinor, settledResult.currency)}</strong></p>
              <p className="text-slate-500 text-[11px] pt-1">تم قيد السند بالوردية الحالية وتحديث حالات الأوامر إلى (مدفوع).</p>
            </div>

            <div className="pt-4 flex items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => {
                  setSettledResult(null);
                  if (selectedPartyId) void loadPartyOrders(selectedPartyId);
                }}
                className="py-2.5 px-5 rounded-xl border border-slate-200 bg-white font-bold text-xs text-slate-700 hover:bg-slate-50"
              >
                مطابقة كشف آخر
              </button>
              <button
                type="button"
                onClick={onClose}
                className="py-2.5 px-5 rounded-xl bg-navy-900 text-white font-black text-xs hover:bg-navy-800"
              >
                إغلاق
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-5">
            {/* 1. اختيار المختبر وشهر الكشف */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 p-3.5 rounded-2xl bg-slate-50 border border-slate-200/80">
              <div className="sm:col-span-2">
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  اختر مختبر الأسنان المراد تسوية حسابه
                </label>
                <select
                  value={selectedPartyId ?? ""}
                  onChange={(e) => setSelectedPartyId(Number(e.target.value))}
                  disabled={loadingLabs}
                  className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-bold text-slate-900 focus:outline-hidden focus:ring-2 focus:ring-brand-blue"
                >
                  {labs.map((lab) => (
                    <option key={lab.partyId} value={lab.partyId}>
                      {lab.partyName} ({lab.unsettledOrdersCount} أمر غير مسدد · {formatMoney(lab.unsettledCostMinor, lab.currency)})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  الفترة / شهر الكشف
                </label>
                <input
                  type="text"
                  placeholder="مثال: سبتمبر 2026"
                  value={monthLabel}
                  onChange={(e) => setMonthLabel(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-bold text-slate-900 focus:outline-hidden focus:ring-2 focus:ring-brand-blue text-center"
                />
              </div>
            </div>

            {/* 2. جدول أوامر المختبر */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-black text-slate-800">
                    أوامر التركيبات المنجزة ({orders.length})
                  </span>
                  <button
                    type="button"
                    onClick={toggleSelectAll}
                    className="text-[11px] font-bold text-brand-blue hover:underline"
                  >
                    {selectedOrderIds.length === orders.length ? "إلغاء تحديد الكل" : "تحديد الكل"}
                  </button>
                </div>
                {reconcileData && (
                  <span className="text-xs font-bold text-slate-500">
                    المحدد للتسوية: <strong className="text-slate-900">{reconcileData.totalOrdersCount} أمر</strong>
                  </span>
                )}
              </div>

              {loadingOrders ? (
                <div className="py-12 text-center text-xs text-slate-400 font-bold">
                  جاري جلب أوامر المختبر…
                </div>
              ) : orders.length === 0 ? (
                <div className="py-10 text-center rounded-2xl border border-dashed border-slate-200 text-xs text-slate-400 font-bold">
                  لا توجد أوامر مسجلة لهذا المختبر حالياً.
                </div>
              ) : (
                <div className="max-h-64 overflow-y-auto rounded-2xl border border-slate-200">
                  <table className="w-full text-right text-xs">
                    <thead className="sticky top-0 bg-slate-100 text-slate-600 font-bold border-b border-slate-200">
                      <tr>
                        <th className="p-2.5 w-8 text-center">#</th>
                        <th className="p-2.5">رقم الطلب</th>
                        <th className="p-2.5">المريض</th>
                        <th className="p-2.5">نوع العمل السني</th>
                        <th className="p-2.5">التسليم</th>
                        <th className="p-2.5 text-left">المسجل بالنظام</th>
                        <th className="p-2.5 text-left w-28">مطالبة الكشف</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {orders.map((o) => {
                        const isChecked = selectedOrderIds.includes(o.orderId);
                        const isPaid = o.financialStatus === "paid";
                        const customVal = customClaimed[o.orderId] ?? "";

                        return (
                          <tr
                            key={o.orderId}
                            className={`hover:bg-slate-50/80 transition-colors ${
                              isChecked ? "bg-sky-50/40" : ""
                            } ${isPaid ? "opacity-60 bg-slate-50" : ""}`}
                          >
                            <td className="p-2.5 text-center">
                              <input
                                type="checkbox"
                                checked={isChecked}
                                onChange={() => toggleOrder(o.orderId)}
                                className="rounded border-slate-300 text-brand-blue focus:ring-brand-blue"
                              />
                            </td>
                            <td className="p-2.5 font-mono font-bold text-slate-800">
                              RX-{o.orderId}
                            </td>
                            <td className="p-2.5 font-bold text-slate-900 truncate max-w-[120px]">
                              {o.patientName}
                            </td>
                            <td className="p-2.5 text-slate-700">
                              <span className="font-semibold">{o.workType}</span>
                              {o.teeth && (
                                <span className="text-[10px] text-slate-400 block font-mono">
                                  {o.teeth}
                                </span>
                              )}
                            </td>
                            <td className="p-2.5 text-[11px] text-slate-500 font-mono">
                              {o.dueDate}
                            </td>
                            <td className="p-2.5 text-left font-mono font-bold text-slate-800">
                              {formatMoney(o.systemCostMinor, o.currency)}
                            </td>
                            <td className="p-2.5 text-left">
                              <input
                                type="text"
                                placeholder={toInputAmount(o.systemCostMinor, o.currency)}
                                value={customVal}
                                onChange={(e) =>
                                  setCustomClaimed((prev) => ({
                                    ...prev,
                                    [o.orderId]: e.target.value,
                                  }))
                                }
                                className="w-24 rounded-lg border border-slate-200 px-2 py-1 text-xs font-mono text-left focus:outline-hidden focus:ring-1 focus:ring-brand-blue"
                              />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* 3. شريط ملخص التسوية والمطابقة */}
            {reconcileData && selectedOrderIds.length > 0 && (
              <div className="p-4 rounded-2xl bg-gradient-to-br from-slate-900 to-navy-950 text-white shadow-lg space-y-3">
                <div className="grid grid-cols-3 gap-2 text-center border-b border-white/10 pb-3">
                  <div>
                    <span className="text-[11px] text-white/50 block font-bold">إجمالي النظام</span>
                    <span className="text-sm sm:text-base font-black font-mono text-white">
                      {formatMoney(reconcileData.totalSystemCostMinor, reconcileData.currency)}
                    </span>
                  </div>
                  <div>
                    <span className="text-[11px] text-white/50 block font-bold">المطالَب به في الكشف</span>
                    <span className="text-sm sm:text-base font-black font-mono text-amber-300">
                      {formatMoney(reconcileData.totalClaimedCostMinor, reconcileData.currency)}
                    </span>
                  </div>
                  <div>
                    <span className="text-[11px] text-white/50 block font-bold">الفارق السعري</span>
                    <span
                      className={`text-sm sm:text-base font-black font-mono ${
                        reconcileData.varianceMinor === 0
                          ? "text-emerald-400"
                          : reconcileData.varianceMinor > 0
                          ? "text-rose-400"
                          : "text-sky-400"
                      }`}
                    >
                      {reconcileData.varianceMinor > 0 ? "+" : ""}
                      {formatMoney(reconcileData.varianceMinor, reconcileData.currency)}
                    </span>
                  </div>
                </div>

                {reconcileData.hasDiscrepancy && (
                  <div className="p-2.5 rounded-xl bg-amber-500/20 border border-amber-400/30 text-amber-200 text-xs font-bold flex items-center gap-2">
                    <span>⚠️</span>
                    <span>
                      يوجد اختلاف في تسعيرة ({reconcileData.discrepancies.length}) أمر عمل عن المسجل بالنظام. سيتم اعتماد المبلغ المطابق بالكشف.
                    </span>
                  </div>
                )}

                <div className="flex items-center justify-between pt-1">
                  <div className="text-xs text-white/70">
                    سيصدر <strong className="text-white">سند صرف رسمي موحد</strong> يخصم من الوردية الحالية.
                  </div>
                  <button
                    type="button"
                    disabled={busy || selectedOrderIds.length === 0}
                    onClick={handleSettle}
                    className="py-2.5 px-5 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 active:scale-98 text-white font-black text-xs shadow-md transition-all disabled:opacity-50 flex items-center gap-2"
                  >
                    {busy ? (
                      <span>جاري اعتماد السند…</span>
                    ) : (
                      <>
                        <span>💰 سداد وتسوية مجمعة ({reconcileData.totalOrdersCount})</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
