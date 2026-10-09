"use client";

import { useState, useEffect, useRef } from "react";
import type { LabOrder } from "@/lib/lab";
import { MINOR_UNITS, toInputAmount, formatAmount, CURRENCY_LABEL, type Currency } from "@/lib/money";
import { rateFromSettings, type SettingsMap } from "@/lib/settings";
import { STANDARD_LAB_EXPENSE_ACCOUNTS, STANDARD_LAB_PAYABLE_ACCOUNTS } from "@/lib/accounting";
import { isLabAccountingRate, labAccountingMoneyEdit, labAccountingPreviewBase } from "@/lib/lab-accounting-edit";

export interface ExpenseCategoryOption {
  id: number;
  key: string;
  name: string;
  categoryGroup: string;
  accountCode: string;
  accountName: string;
  isActive: boolean;
}

interface Props {
  order: LabOrder | null;
  onClose: () => void;
  onSaved: (updatedOrder: LabOrder) => void;
  expenseCategories: ExpenseCategoryOption[];
  baseCurrency?: Currency;
}

export function LabOrderAccountingModal({
  order,
  onClose,
  onSaved,
  expenseCategories,
  baseCurrency = "YER",
}: Props) {
  const [selectedCategoryId, setSelectedCategoryId] = useState<number | null>(null);
  const [selectedExpenseAccount, setSelectedExpenseAccount] = useState<string>("5101");
  const [selectedPayableAccount, setSelectedPayableAccount] = useState<string>("2101");
  const [costValue, setCostValue] = useState<string>("");
  const [currencyValue, setCurrencyValue] = useState<Currency>("YER");
  const [moneyTouched, setMoneyTouched] = useState(false);
  const [moneyRevision, setMoneyRevision] = useState(0);
  const [moneyOwner, setMoneyOwner] = useState<LabOrder | null>(null);
  const [rateState, setRateState] = useState<{
    key: string; status: "loading" | "ready" | "unavailable"; rate?: number;
  } | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!order) return;

    // Initialize category
    if (order.expenseCategoryId) {
      setSelectedCategoryId(order.expenseCategoryId);
    } else {
      // Look for a category matching 'lab' or account '5101'
      const defaultCat = expenseCategories.find(
        (c) => c.key === "lab" || c.accountCode === "5101" || c.accountCode?.startsWith("51"),
      );
      if (defaultCat) {
        setSelectedCategoryId(defaultCat.id);
      } else if (expenseCategories.length > 0) {
        setSelectedCategoryId(expenseCategories[0].id);
      }
    }

    // Initialize accounts
    setSelectedExpenseAccount(order.expenseAccountCode || "5101");
    setSelectedPayableAccount(order.payableAccountCode || "2101");

    // Initialize cost — بالوحدات الكبرى يقرأها المستخدم، لا وحدات القاعدة.
    const initialCurrency = (order.costCurrency || baseCurrency) as Currency;
    if (order.costMinor != null && order.costMinor > 0) {
      setCostValue(toInputAmount(order.costMinor, initialCurrency));
    } else {
      setCostValue("");
    }
    setCurrencyValue(initialCurrency);
    setMoneyTouched(false);
    setMoneyRevision((revision) => revision + 1);
    setMoneyOwner(order);
    setErrorMsg(null);
    setSuccessMsg(null);
  }, [order, expenseCategories, baseCurrency]);

  const moneyEdit = order
    ? labAccountingMoneyEdit(order, costValue, currencyValue, baseCurrency, moneyTouched)
    : { kind: "unchanged" as const };
  const orderId = order?.id ?? null;
  const needsCurrentRate = moneyEdit.kind === "edited";
  const rateKey = `${orderId}:${moneyRevision}:${currencyValue}:${baseCurrency}`;
  // Saved money is never repriced. Intentional edits use the server's current
  // settings policy, even when only the amount (not currency) changed.
  useEffect(() => {
    if (orderId == null || !needsCurrentRate) return;
    if (currencyValue === baseCurrency) {
      setRateState({ key: rateKey, status: "ready", rate: 1 });
      return;
    }
    let active = true;
    setRateState({ key: rateKey, status: "loading" });
    void (async () => {
      try {
        const res = await fetch("/api/settings", { cache: "no-store" });
        if (!res.ok) throw new Error("settings_unavailable");
        const settings = (await res.json()) as SettingsMap;
        const rate = rateFromSettings(settings, currencyValue, baseCurrency);
        if (active) setRateState(isLabAccountingRate(rate)
          ? { key: rateKey, status: "ready", rate }
          : { key: rateKey, status: "unavailable" });
      } catch {
        if (active) setRateState({ key: rateKey, status: "unavailable" });
      }
    })();
    return () => {
      active = false;
    };
  }, [orderId, needsCurrentRate, rateKey, currencyValue, baseCurrency]);

  if (!order) return null;

  // Handle category change to automatically sync expense account
  const handleCategoryChange = (catId: number | null) => {
    setSelectedCategoryId(catId);
    if (catId) {
      const cat = expenseCategories.find((c) => c.id === catId);
      if (cat?.accountCode) {
        setSelectedExpenseAccount(cat.accountCode);
      }
    }
  };

  const selectedCategory = expenseCategories.find((c) => c.id === selectedCategoryId);
  const selectedExpenseAccObj =
    STANDARD_LAB_EXPENSE_ACCOUNTS.find((a) => a.code === selectedExpenseAccount) || {
      code: selectedExpenseAccount,
      name: selectedCategory?.accountName || "تكلفة خدمات المعامل والمختبرات",
    };
  const selectedPayableAccObj =
    STANDARD_LAB_PAYABLE_ACCOUNTS.find((a) => a.code === selectedPayableAccount) || {
      code: selectedPayableAccount,
      name: "ذمم المعامل والموردين",
    };

  const ownedRate = rateState?.key === rateKey ? rateState : null;
  const previewRate = moneyEdit.kind === "unchanged"
    ? (isLabAccountingRate(order.exchangeRate) ? order.exchangeRate : null)
    : (ownedRate?.status === "ready" ? ownedRate.rate ?? null : null);
  const previewMinor = moneyEdit.kind === "unchanged" ? order.costMinor
    : moneyEdit.kind === "edited" ? moneyEdit.costMinor : null;
  const costMajorValue = previewMinor != null ? previewMinor / MINOR_UNITS[currencyValue] : null;
  const baseAmount = moneyEdit.kind === "unchanged"
    ? (Number.isSafeInteger(order.baseAmountMinor) && order.baseAmountMinor != null && order.baseAmountMinor >= 0
        ? order.baseAmountMinor : null)
    : moneyEdit.kind === "edited" && previewRate != null
      ? labAccountingPreviewBase(moneyEdit.costMinor, currencyValue, baseCurrency, previewRate) : null;
  const previewState = moneyEdit.kind === "unchanged" ? "saved"
    : moneyEdit.kind === "invalid" ? "invalid"
      : ownedRate?.status === "unavailable" || (ownedRate?.status === "ready" && baseAmount == null)
        ? "unavailable" : baseAmount != null ? "ready" : "loading";
  const moneyReady = moneyEdit.kind === "unchanged" || previewState === "ready";
  const canSubmit = moneyOwner === order && !isSubmitting && moneyReady;

  const isAlreadyPosted = order.isPosted !== false && (order.costMinor != null && order.costMinor > 0);

  const handleSubmit = async (action: "post" | "unpost" | "update_accounting") => {
    if (submittingRef.current) return;
    if (!canSubmit) {
      setErrorMsg(moneyEdit.kind === "invalid" ? moneyEdit.message : "انتظر معاينة سعر صرف صالحة قبل حفظ تعديل التكلفة.");
      return;
    }
    submittingRef.current = true;
    setIsSubmitting(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    try {
      const payload: Record<string, unknown> = {
        action,
        expenseCategoryId: selectedCategoryId,
        expenseAccountCode: selectedExpenseAccount,
        payableAccountCode: selectedPayableAccount,
      };

      // Omitting unchanged money is what preserves both historical snapshots.
      if (moneyEdit.kind === "edited") {
        // Parse the same raw text on both sides; reserializing large minor
        // values can introduce a second floating-point rounding step.
        payload.cost = costValue;
        payload.costCurrency = moneyEdit.currency;
        payload.expectedExchangeRate = previewRate;
      }

      const res = await fetch(`/api/lab/${order.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok) {
        if (data.code === "lab_accounting_rate_changed" || data.code === "lab_accounting_rate_invalid") {
          setRateState((current) => current?.key === rateKey
            ? { key: rateKey, status: "unavailable" } : current);
        }
        throw new Error(data.message || "تعذّر حفظ التعديلات المحاسبية.");
      }

      setSuccessMsg(
        action === "post"
          ? "تم اعتماد الترحيل النهائي للقيد المحاسبي بنجاح! تم إدراجه في اليومية العامة والتقارير المالية."
          : action === "unpost"
          ? "تم إلغاء الترحيل وإعادة الفاتورة كمسودة بانتظار المراجعة والترحيل النهائي."
          : "تم حفظ الربط المحاسبي وتحديث بند المصروف بنجاح.",
      );

      onSaved(data as LabOrder);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "حدث خطأ أثناء حفظ الربط المحاسبي.";
      setErrorMsg(msg);
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  };

  return (
    <div
      id="lab-accounting-modal-backdrop"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-xs overflow-y-auto"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        id="lab-accounting-modal-container"
        className="relative w-full max-w-2xl rounded-2xl bg-white shadow-2xl border border-slate-200 overflow-hidden my-6 transition-all"
        dir="rtl"
      >
        {/* Header */}
        <div className="bg-gradient-to-r from-slate-900 via-indigo-950 to-slate-900 text-white px-6 py-5 border-b border-indigo-900/50">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-indigo-600/30 border border-indigo-400/40 flex items-center justify-center text-xl">
                ⚖️
              </div>
              <div>
                <h2 className="text-lg font-bold text-white tracking-wide">
                  الربط المحاسبي واعتماد الترحيل المالي للأمر #{order.id}
                </h2>
                <p className="text-xs text-indigo-200 mt-0.5">
                  توجيه تكلفة العمل لـ ({order.workType}) مباشرة لبنود المصروفات وشجرة الحسابات
                </p>
              </div>
            </div>
            <button
              id="lab-accounting-close-btn"
              type="button"
              onClick={onClose}
              className="w-8 h-8 rounded-lg bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors text-lg"
              title="إغلاق"
            >
              ✕
            </button>
          </div>
        </div>

        <div className="p-4 sm:p-6 space-y-6 max-h-[80vh] overflow-y-auto">
          {/* Messages */}
          {errorMsg && (
            <div
              id="lab-accounting-error"
              className="p-3.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs font-medium flex items-center gap-2"
            >
              <span className="text-base">⚠️</span>
              <span>{errorMsg}</span>
            </div>
          )}

          {successMsg && (
            <div
              id="lab-accounting-success"
              className="p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-medium flex items-center gap-2"
            >
              <span className="text-base">✓</span>
              <span>{successMsg}</span>
            </div>
          )}

          {/* Quick Info Badge Card */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 bg-slate-50 p-3.5 rounded-xl border border-slate-200/80 text-xs">
            <div>
              <span className="text-slate-500 block text-[11px]">المريض:</span>
              <span className="font-semibold text-slate-800 truncate block">
                {order.patientName} (#{order.patientNumber || order.patientId})
              </span>
            </div>
            <div>
              <span className="text-slate-500 block text-[11px]">المعمل المنفّذ:</span>
              <span className="font-semibold text-slate-800 truncate block">
                {order.labName}
              </span>
            </div>
            <div>
              <span className="text-slate-500 block text-[11px]">نوع العمل والسن:</span>
              <span className="font-semibold text-slate-800 truncate block">
                {order.workType} {order.toothNumbers ? `(سن ${order.toothNumbers})` : ""}
              </span>
            </div>
            <div>
              <span className="text-slate-500 block text-[11px]">حالة الترحيل الحالية:</span>
              {isAlreadyPosted ? (
                <span className="inline-flex items-center gap-1 font-bold text-emerald-700 bg-emerald-100/70 px-2 py-0.5 rounded-md border border-emerald-300">
                  <span>✓</span> مُرحّل نهائياً
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 font-bold text-amber-800 bg-amber-100/80 px-2 py-0.5 rounded-md border border-amber-300 animate-pulse">
                  <span>⏳</span> بانتظار الترحيل
                </span>
              )}
            </div>
          </div>

          {/* Configuration Form */}
          <div className="space-y-4">
            <h3 className="text-sm font-bold text-slate-800 flex items-center gap-2 border-b border-slate-100 pb-2">
              <span>🏷️</span> توجيه التكلفة وبند المصروف
            </h3>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Expense Category Selection */}
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  بند المصروف التشغيلي *
                </label>
                <select
                  id="lab-accounting-category-select"
                  value={selectedCategoryId || ""}
                  onChange={(e) =>
                    handleCategoryChange(e.target.value ? Number(e.target.value) : null)
                  }
                  className="w-full text-xs rounded-xl border border-slate-300 p-2.5 bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500 font-medium"
                >
                  <option value="">-- اختر بند المصروف من الدليل --</option>
                  {expenseCategories.map((cat) => (
                    <option key={cat.id} value={cat.id}>
                      {cat.name} ({cat.categoryGroup || "تكاليف مهنية"}) [{cat.accountCode || "5101"}]
                    </option>
                  ))}
                  {!expenseCategories.some((c) => c.key === "lab") && (
                    <option value="">مستحقات وتكاليف المعامل [5101]</option>
                  )}
                </select>
                <p className="text-[11px] text-slate-500 mt-1">
                  البند الذي ستُدرج تحته هذه التكلفة في تقارير المصروفات وقائمة الدخل.
                </p>
              </div>

              {/* Expense Detailed Account Selection */}
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  حساب المصروف المدين (شجرة الحسابات العامة) *
                </label>
                <select
                  id="lab-accounting-expense-acc-select"
                  value={selectedExpenseAccount}
                  onChange={(e) => setSelectedExpenseAccount(e.target.value)}
                  className="w-full text-xs rounded-xl border border-slate-300 p-2.5 bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500 font-medium font-mono"
                >
                  {STANDARD_LAB_EXPENSE_ACCOUNTS.map((acc) => (
                    <option key={acc.code} value={acc.code}>
                      {acc.code} — {acc.name}
                    </option>
                  ))}
                </select>
                <p className="text-[11px] text-slate-500 mt-1">
                  الطرف المدين الذي يُحمّل التكلفة لمركز التكلفة بدقة.
                </p>
              </div>

              {/* Payable Account Selection */}
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  حساب الذمم الدائنة (الطرف الدائن للمعامل) *
                </label>
                <select
                  id="lab-accounting-payable-acc-select"
                  value={selectedPayableAccount}
                  onChange={(e) => setSelectedPayableAccount(e.target.value)}
                  className="w-full text-xs rounded-xl border border-slate-300 p-2.5 bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500 font-medium font-mono"
                >
                  {STANDARD_LAB_PAYABLE_ACCOUNTS.map((acc) => (
                    <option key={acc.code} value={acc.code}>
                      {acc.code} — {acc.name}
                    </option>
                  ))}
                </select>
                <p className="text-[11px] text-slate-500 mt-1">
                  الطرف الدائن الذي يُثبت الالتزام المالي للمعمل.
                </p>
              </div>

              {/* Cost and Currency */}
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  تكلفة أمر المختبر والعملة *
                </label>
                <div className="flex gap-2">
                  <input
                    id="lab-accounting-cost-input"
                    disabled={isSubmitting}
                    type="number"
                    min="0"
                    step="any"
                    value={costValue}
                    onChange={(e) => {
                      setCostValue(e.target.value);
                      setMoneyTouched(true);
                      setMoneyRevision((revision) => revision + 1);
                    }}
                    placeholder="التكلفة..."
                    className="min-w-0 flex-1 text-xs rounded-xl border border-slate-300 p-2.5 bg-white text-slate-800 font-bold focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                  <select
                    id="lab-accounting-currency-select"
                    disabled={isSubmitting}
                    value={currencyValue}
                    onChange={(e) => {
                      setCurrencyValue(e.target.value as Currency);
                      setMoneyTouched(true);
                      setMoneyRevision((revision) => revision + 1);
                    }}
                    className="w-28 shrink-0 text-xs rounded-xl border border-slate-300 p-2.5 bg-slate-50 text-slate-800 font-bold focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  >
                    <option value="YER">ريال يمني</option>
                    <option value="SAR">ريال سعودي</option>
                    <option value="USD">دولار</option>
                  </select>
                </div>
                <p id="lab-accounting-money-preview" data-preview-state={previewState}
                  data-preview-currency={currencyValue}
                  data-preview-source={moneyEdit.kind === "unchanged" ? "saved" : "current"}
                  className="text-[11px] text-indigo-600 mt-1" aria-live="polite">
                  {moneyEdit.kind === "invalid" ? moneyEdit.message
                    : previewState === "loading" ? "جارٍ تحميل سعر الصرف الحالي…"
                      : previewState === "unavailable" ? "معاينة الصرف غير متاحة. حدّث المعاينة للمحاولة؛ لم تُحفظ تكلفة جديدة."
                        : <>
                          {moneyEdit.kind === "unchanged" ? "المعادل المحفوظ: " : "معاينة المعادل الحالي: "}
                          <span className="font-bold">{baseAmount == null ? "غير مسجل" : `${formatAmount(baseAmount, baseCurrency)} ${CURRENCY_LABEL[baseCurrency]}`}</span>
                          {previewRate != null ? ` (بسعر صرف ${previewRate})` : ""}
                          {moneyEdit.kind === "unchanged" ? "؛ تعديل الربط وحده لا يغيّر التكلفة أو سعر الصرف." : "؛ يُرفض الحفظ إذا تغيّر السعر قبل الإرسال."}
                        </>}
                </p>
                {moneyEdit.kind === "edited" && (
                  <button id="lab-accounting-refresh-rate-btn" type="button" disabled={isSubmitting}
                    className="mt-1 text-[11px] font-bold text-indigo-700 underline"
                    onClick={() => { setErrorMsg(null); setMoneyRevision((revision) => revision + 1); }}>
                    تحديث معاينة سعر الصرف
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Double-Entry Accounting Voucher / Journal Preview */}
          <div className="rounded-xl border border-indigo-200 bg-gradient-to-b from-indigo-50/60 to-slate-50 p-3 sm:p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-indigo-950 flex items-center gap-1.5">
                <span>📋</span> معاينة القيد المحاسبي المزدوج (سند الاستحقاق قبل الترحيل)
              </span>
              <span className="text-[11px] font-mono text-indigo-700 bg-indigo-100/80 px-2 py-0.5 rounded">
                مرجع السند: PB-{order.payableId || order.id}
              </span>
            </div>

            <div id="lab-accounting-ledger" className="min-w-0 max-w-full overflow-x-auto">
              {/* Keep all six fields readable on narrow screens, with table
                  roles explicit because mobile rows use a grid layout. */}
              <table role="table" className="block w-full text-xs text-right border-collapse sm:table">
                <thead role="rowgroup" className="sr-only sm:not-sr-only sm:table-header-group">
                  <tr role="row" className="border-b border-indigo-200/80 text-slate-500 text-[11px]">
                    <th role="columnheader" scope="col" className="py-2 px-2">الطرف</th>
                    <th role="columnheader" scope="col" className="py-2 px-2">رمز الحساب</th>
                    <th role="columnheader" scope="col" className="py-2 px-2">اسم الحساب</th>
                    <th role="columnheader" scope="col" className="py-2 px-2">بند المصروف</th>
                    <th id="lab-accounting-debit-header" role="columnheader" scope="col" className="py-2 px-2 text-left">مدين</th>
                    <th id="lab-accounting-credit-header" role="columnheader" scope="col" className="py-2 px-2 text-left">دائن</th>
                  </tr>
                </thead>
                <tbody role="rowgroup" className="block divide-y divide-indigo-100/80 font-medium sm:table-row-group">
                  {/* Debit Line */}
                  <tr role="row" className="grid grid-cols-2 bg-white/60 sm:table-row">
                    <td role="cell" className="min-w-0 py-1 px-2 text-emerald-700 font-bold sm:py-2.5">
                      <span aria-hidden="true" className="text-[11px] font-normal text-slate-500 sm:hidden">الطرف: </span>
                      المدين (+مصروف)
                    </td>
                    <td role="cell" className="min-w-0 py-1 px-2 font-mono text-indigo-900 sm:py-2.5">
                      <span aria-hidden="true" className="text-[11px] font-normal text-slate-500 sm:hidden">رمز الحساب: </span>
                      {selectedExpenseAccObj.code}
                    </td>
                    <td role="cell" className="min-w-0 col-span-2 break-words py-1 px-2 text-slate-800 sm:py-2.5">
                      <span aria-hidden="true" className="text-[11px] font-normal text-slate-500 sm:hidden">اسم الحساب: </span>
                      {selectedExpenseAccObj.name}
                    </td>
                    <td role="cell" className="min-w-0 col-span-2 break-words py-1 px-2 text-slate-600 sm:py-2.5">
                      <span aria-hidden="true" className="text-[11px] font-normal text-slate-500 sm:hidden">بند المصروف: </span>
                      {selectedCategory?.name || "تكاليف المعامل"}
                    </td>
                    <td role="cell" className="min-w-0 break-words py-1 px-2 text-left font-bold text-emerald-700 font-mono sm:py-2.5">
                      <span id="lab-accounting-debit-label" aria-hidden="true" className="block text-[11px] font-normal text-slate-500 sm:hidden">مدين</span>
                      <span id="lab-accounting-debit-amount" className="block">
                        {costMajorValue == null ? "غير محدد" : costMajorValue.toLocaleString()} {currencyValue}
                      </span>
                    </td>
                    <td role="cell" className="min-w-0 py-1 px-2 text-left text-slate-400 font-mono sm:py-2.5">
                      <span aria-hidden="true" className="block text-[11px] font-normal text-slate-500 sm:hidden">دائن</span>
                      —
                    </td>
                  </tr>

                  {/* Credit Line */}
                  <tr role="row" className="grid grid-cols-2 bg-white/60 sm:table-row">
                    <td role="cell" className="min-w-0 py-1 px-2 text-rose-700 font-bold sm:py-2.5">
                      <span aria-hidden="true" className="text-[11px] font-normal text-slate-500 sm:hidden">الطرف: </span>
                      الدائن (+التزام)
                    </td>
                    <td role="cell" className="min-w-0 py-1 px-2 font-mono text-indigo-900 sm:py-2.5">
                      <span aria-hidden="true" className="text-[11px] font-normal text-slate-500 sm:hidden">رمز الحساب: </span>
                      {selectedPayableAccObj.code}
                    </td>
                    <td role="cell" className="min-w-0 col-span-2 break-words py-1 px-2 text-slate-800 sm:py-2.5">
                      <span aria-hidden="true" className="text-[11px] font-normal text-slate-500 sm:hidden">اسم الحساب: </span>
                      {selectedPayableAccObj.name} ({order.labName})
                    </td>
                    <td role="cell" className="min-w-0 col-span-2 py-1 px-2 text-slate-500 sm:py-2.5">
                      <span aria-hidden="true" className="text-[11px] font-normal text-slate-500 sm:hidden">بند المصروف: </span>
                      —
                    </td>
                    <td role="cell" className="min-w-0 py-1 px-2 text-left text-slate-400 font-mono sm:py-2.5">
                      <span aria-hidden="true" className="block text-[11px] font-normal text-slate-500 sm:hidden">مدين</span>
                      —
                    </td>
                    <td role="cell" className="min-w-0 break-words py-1 px-2 text-left font-bold text-rose-700 font-mono sm:py-2.5">
                      <span id="lab-accounting-credit-label" aria-hidden="true" className="block text-[11px] font-normal text-slate-500 sm:hidden">دائن</span>
                      <span id="lab-accounting-credit-amount" className="block">
                        {costMajorValue == null ? "غير محدد" : costMajorValue.toLocaleString()} {currencyValue}
                      </span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/* Verification Note */}
            <div className="text-[11px] text-slate-600 bg-white/70 p-2.5 rounded-lg border border-indigo-100 flex items-start gap-2">
              <span className="text-sm text-indigo-600 mt-0.5">ℹ️</span>
              <div>
                <strong>الربط الدقيق بالتقارير المالية:</strong> عند الترحيل النهائي، يُسجل المصروف فورياً
                في قائمة الدخل تحت بند{" "}
                <span className="text-indigo-900 font-bold">
                  {selectedCategory?.name || "تكاليف المعامل"}
                </span>{" "}
                ويُثبت الالتزام المالي للمعمل دون تكرار أو تأخير، مما يضمن دقة حساب تكلفة الزيارة
                وصافي أرباح العيادة.
              </div>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="pt-2 border-t border-slate-200 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <button
                id="lab-accounting-cancel-btn"
                type="button"
                onClick={onClose}
                className="px-4 py-2.5 rounded-xl border border-slate-300 text-slate-700 text-xs font-semibold hover:bg-slate-50 transition-colors"
              >
                إلغاء
              </button>
              {isAlreadyPosted && (
                <button
                  id="lab-accounting-unpost-btn"
                  type="button"
                  disabled={!canSubmit}
                  onClick={() => handleSubmit("unpost")}
                  className="px-3.5 py-2.5 rounded-xl border border-amber-300 text-amber-800 bg-amber-50 hover:bg-amber-100 text-xs font-semibold transition-colors disabled:opacity-50"
                  title="إلغاء الترحيل وإعادة الفاتورة كمسودة للمراجعة"
                >
                  إلغاء الترحيل مؤقتاً للمراجعة
                </button>
              )}
            </div>

            <div className="flex items-center gap-2">
              <button
                id="lab-accounting-save-mapping-btn"
                type="button"
                disabled={!canSubmit}
                onClick={() => handleSubmit("update_accounting")}
                className="px-4 py-2.5 rounded-xl border border-indigo-300 text-indigo-700 bg-indigo-50 hover:bg-indigo-100 text-xs font-bold transition-colors disabled:opacity-50"
              >
                {isSubmitting ? "جارٍ الحفظ..." : "حفظ تعديل بند المصروف"}
              </button>

              {!isAlreadyPosted ? (
                <button
                  id="lab-accounting-final-post-btn"
                  type="button"
                  disabled={!canSubmit}
                  onClick={() => handleSubmit("post")}
                  className="px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold shadow-md shadow-emerald-600/20 transition-all flex items-center gap-1.5 disabled:opacity-50"
                >
                  <span>✓</span>
                  <span>{isSubmitting ? "جارٍ الترحيل..." : "اعتماد وترحيل نهائي للقيد المحاسبي"}</span>
                </button>
              ) : (
                <button
                  id="lab-accounting-repost-btn"
                  type="button"
                  disabled={!canSubmit}
                  onClick={() => handleSubmit("post")}
                  className="px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold shadow-md shadow-indigo-600/20 transition-all flex items-center gap-1.5 disabled:opacity-50"
                >
                  <span>✓</span>
                  <span>{isSubmitting ? "جارٍ التحديث..." : "تحديث الربط وإعادة الترحيل"}</span>
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
