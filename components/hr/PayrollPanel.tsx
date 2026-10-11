"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Modal } from "@/components/Modal";
import {
  HR_PAYROLL_ITEM_STATUS_LABELS,
  type HrCurrency,
  type HrPayrollPeriodView,
  type HrPayrollRunView,
  type HrPayrollItemView,
  type HrPayrollDisbursementView,
} from "@/lib/hr-payroll-shared";
import { CURRENCIES, CURRENCY_SHORT, formatAmount, parseAmount, toInputAmount, type Currency } from "@/lib/money";
import { readPendingPayrollPayment, readPayrollPaymentConfirmation, readPayrollDisbursement,
  readPayrollReversalConfirmation, type PendingPayrollPayment } from "@/lib/hr-payroll-confirmation";

type PayrollPeriodItem = HrPayrollPeriodView;
type PayrollRunItem = HrPayrollRunView & { items?: HrPayrollItemView[] };
type PayrollItemDetail = HrPayrollItemView;
type PendingPayment = PendingPayrollPayment;
const pendingKey = (itemId: number) => `hr:payroll:pending:${itemId}`;
const reversalKey = (itemId: number) => `hr:payroll:pending-reversal:${itemId}`;

export function HrPayrollPanel() {
  const [periods, setPeriods] = useState<PayrollPeriodItem[]>([]);
  const [selectedPeriod, setSelectedPeriod] = useState<string>("");
  const [selectedCurrency, setSelectedCurrency] = useState<HrCurrency>("YER");
  const [runs, setRuns] = useState<PayrollRunItem[]>([]);
  const [activeRun, setActiveRun] = useState<PayrollRunItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Modals
  const [periodModalOpen, setPeriodModalOpen] = useState(false);
  const [newPeriodMonth, setNewPeriodMonth] = useState(new Date().toISOString().slice(0, 7));
  const [disburseModalOpen, setDisburseModalOpen] = useState(false);
  const [disburseItem, setDisburseItem] = useState<PayrollItemDetail | null>(null);
  const [disburseAmount, setDisburseAmount] = useState<string>("");
  const [disburseMethod, setDisburseMethod] = useState("cash");
  const [disburseRef, setDisburseRef] = useState("");
  const [disburseNotes, setDisburseNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const [pending, setPending] = useState<PendingPayment | null>(null);
  const [salaryPart, setSalaryPart] = useState("");
  const [commissionPart, setCommissionPart] = useState("");
  const runRequest = useRef(0);
  const currentRunScope = useRef(`${selectedPeriod}:${selectedCurrency}`);

  const loadPeriods = useCallback(async () => {
    try {
      const res = await fetch("/api/hr/payroll/periods", { cache: "no-store" });
      if (!res.ok) throw new Error("تعذّر تحميل فترات المسير.");
      const data = await res.json();
      setPeriods(data);
      if (data.length > 0 && !selectedPeriod) {
        setSelectedPeriod(String(data[0].id));
      }
      setError(null);
    } catch (err: any) {
      setError(err?.message || "حدث خطأ أثناء تحميل الفترات.");
    } finally {
      setLoading(false);
    }
  }, [selectedPeriod]);

  const loadRuns = useCallback(async () => {
    const scope = `${selectedPeriod}:${selectedCurrency}`;
    if (scope !== currentRunScope.current) return;
    const requestId = ++runRequest.current;
    const current = () => requestId === runRequest.current && scope === currentRunScope.current;
    setActiveRun(null); setRuns([]);
    if (!selectedPeriod) return;
    try {
      const res = await fetch(`/api/hr/payroll/runs?periodId=${selectedPeriod}`, { cache: "no-store" });
      if (!res.ok) throw new Error("تعذّر تحميل المسير للفترة المختارة.");
      const data = await res.json();
      if (!Array.isArray(data)) throw new Error("تعذّر التحقق من المسير للفترة المختارة.");
      const matching = data.find((r: PayrollRunItem) => r.currency === selectedCurrency);
      let detail: PayrollRunItem | null = null;
      if (matching) {
        const detailRes = await fetch(`/api/hr/payroll/runs?id=${matching.id}`, { cache: "no-store" });
        if (!detailRes.ok) throw new Error("تعذّر تحميل تفاصيل المسير للفترة المختارة.");
        detail = await detailRes.json();
        if (!detail || detail.id !== matching.id || String(detail.periodId) !== selectedPeriod
          || detail.currency !== selectedCurrency || !Array.isArray(detail.items)) {
          throw new Error("تعذّر التحقق من هوية المسير للفترة المختارة.");
        }
      }
      if (current()) { setRuns(data); setActiveRun(detail); }
    } catch {
      if (current()) { setActiveRun(null); setError("تعذّر تحميل المسير الحالي؛ أعد تحميل الفترة قبل المتابعة."); }
    }
  }, [selectedPeriod, selectedCurrency]);

  useEffect(() => {
    void loadPeriods();
  }, [loadPeriods]);

  useEffect(() => {
    currentRunScope.current = `${selectedPeriod}:${selectedCurrency}`;
    void loadRuns();
    return () => { runRequest.current += 1; currentRunScope.current = ""; };
  }, [loadRuns, selectedPeriod, selectedCurrency]);

  const handleOpenPeriod = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await fetch("/api/hr/payroll/periods", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ periodMonth: newPeriodMonth }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || "تعذّر فتح الفترة.");
      }
      setPeriodModalOpen(false);
      void loadPeriods();
    } catch (err: any) {
      alert(err.message || "حدث خطأ أثناء فتح الفترة.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleCalculateRun = async () => {
    if (!selectedPeriod) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/hr/payroll/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "calculate",
          periodId: selectedPeriod,
          currency: selectedCurrency,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || "تعذّر احتساب المسير.");
      }
      void loadRuns();
    } catch (err: any) {
      alert(err.message || "حدث خطأ أثناء احتساب المسير.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleApproveRun = async () => {
    if (!activeRun) return;
    if (!confirm("هل أنت متأكد من اعتماد هذا المسير؟ سيتم تسجيل الالتزام المالي في الذمم الدائنة.")) {
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/hr/payroll/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "approve",
          runId: activeRun.id,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || "تعذّر اعتماد المسير.");
      }
      alert("تم اعتماد مسير الرواتب وترحيله للمالية بنجاح.");
      void loadRuns();
    } catch (err: any) {
      alert(err.message || "حدث خطأ أثناء الاعتماد.");
    } finally {
      setSubmitting(false);
    }
  };

  const openDisburseForItem = (item: PayrollItemDetail) => {
    try {
      if (localStorage.getItem(reversalKey(item.id))) {
        setError("تحقق من عكس الصرف السابق قبل بدء صرف جديد."); return;
      }
      const saved = localStorage.getItem(pendingKey(item.id));
      let request = saved ? readPendingPayrollPayment(JSON.parse(saved), item.id) : null;
      if (saved && !request) throw new Error("Saved payout identity is invalid");
      if (request?.completed && request.remainingBefore !== item.remainingMinor) { localStorage.removeItem(pendingKey(item.id)); request = null; }
      setPending(request);
      setDisburseItem(item);
      setDisburseAmount(toInputAmount(request?.amountMinor ?? item.remainingMinor, item.currency));
      setSalaryPart(toInputAmount(request?.components.salaryMinor ?? item.salaryRemainingMinor, item.currency));
      setCommissionPart(toInputAmount(request?.components.commissionMinor ?? item.commissionRemainingMinor, item.currency));
      setDisburseRef(request?.referenceNumber ?? ""); setDisburseNotes(request?.notes ?? "");
      setDisburseModalOpen(true);
    } catch { setError("تعذّر استعادة الطلب المحفوظ؛ تحقق من الصرف السابق قبل المتابعة."); }
  };

  const handleDisburse = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!disburseItem || inFlight.current) return;
    inFlight.current = true; setSubmitting(true);
    try {
      const item = disburseItem;
      const prepare = async () => {
        if (localStorage.getItem(reversalKey(item.id))) throw new Error("تحقق من عكس الصرف السابق قبل بدء صرف جديد.");
        const saved = localStorage.getItem(pendingKey(item.id));
        if (saved) {
          const stored = readPendingPayrollPayment(JSON.parse(saved), item.id);
          if (!stored) throw new Error("تعذّر التحقق من الطلب المحفوظ؛ تحقق من الصرف السابق قبل المتابعة.");
          if (!stored.completed || stored.remainingBefore === item.remainingMinor) return stored;
        }
        const amountMinor = parseAmount(disburseAmount,item.currency) ?? NaN;
        const hybrid = item.salaryRemainingMinor > 0 && item.commissionRemainingMinor > 0;
        const components = hybrid ? { salaryMinor:parseAmount(salaryPart,item.currency) ?? NaN,commissionMinor:parseAmount(commissionPart,item.currency) ?? NaN }
          : { salaryMinor:item.salaryRemainingMinor > 0 ? amountMinor : 0,commissionMinor:item.salaryRemainingMinor > 0 ? 0 : amountMinor };
        if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || components.salaryMinor + components.commissionMinor !== amountMinor) throw new Error("يجب أن يساوي مجموع جزأي الراتب والعمولة مبلغ الصرف.");
        const request: PendingPayment = { itemId:item.id,amountMinor,remainingBefore:item.remainingMinor,components,paymentMethod:disburseMethod,
          referenceNumber:disburseRef || null,notes:disburseNotes || null,clientRequestId:crypto.randomUUID() };
        localStorage.setItem(pendingKey(item.id),JSON.stringify(request));
        return request;
      };
      // Cross-tab preparation is serialized; retries and reloads retain the exact submitted payload.
      const request = navigator.locks ? await navigator.locks.request(pendingKey(item.id),prepare) : await prepare();
      setPending(request);
      const res = await fetch("/api/hr/payroll/disburse", { method:"POST",headers:{ "Content-Type":"application/json" },body:JSON.stringify(request) });
      const result = await res.json();
      if (!res.ok) {
        // A definitive refusal has rolled back. An unknown outcome keeps the key and all fields frozen.
        if (res.status >= 400 && res.status < 500 && result.code
          && !["key_conflict", "forbidden", "authority_changed", "session_expired"].includes(result.code)) {
          localStorage.removeItem(pendingKey(item.id)); setPending(null);
        }
        throw new Error(result.message || "تعذّر تأكيد نتيجة الصرف؛ أعد الطلب نفسه.");
      }
      if (!readPayrollPaymentConfirmation(result, item, request)) {
        throw new Error("لم تتأكد نتيجة الصرف؛ احتُفظ بالطلب نفسه. تحقق من الحركة أو أعد الطلب بالمفتاح نفسه.");
      }
      localStorage.setItem(pendingKey(item.id),JSON.stringify({ ...request,completed:true })); setPending(null);
      setDisburseModalOpen(false); setDisburseItem(null); setError(null); await loadRuns();
    } catch (err) { setError(err instanceof Error ? err.message : "تعذّر تأكيد الصرف؛ أعد الطلب نفسه."); }
    finally { inFlight.current = false; setSubmitting(false); }
  };

  const handleReverse = async (item: PayrollItemDetail, disbursement: HrPayrollDisbursementView) => {
    if (inFlight.current) return;
    inFlight.current = true; setSubmitting(true);
    try {
      const saved = localStorage.getItem(reversalKey(item.id));
      let reason: string;
      if (saved) {
        const request: unknown = JSON.parse(saved);
        if (!request || typeof request !== "object" || Array.isArray(request)
          || !("itemId" in request) || request.itemId !== item.id
          || !("disbursementId" in request) || request.disbursementId !== disbursement.id
          || !("reason" in request) || typeof request.reason !== "string"
          || request.reason.trim().length < 2 || request.reason.trim().length > 500) {
          throw new Error("تعذّر التحقق من طلب العكس المحفوظ؛ راجع الحركة السابقة قبل المتابعة.");
        }
        reason = request.reason;
      } else {
        const entered = disbursement.reversedAt ? disbursement.reversalReason : prompt("سبب عكس الصرف");
        if (!entered) return;
        reason = entered.trim();
        if (reason.length < 2 || reason.length > 500) throw new Error("سبب عكس الصرف مطلوب، بين حرفين و500 حرف.");
        localStorage.setItem(reversalKey(item.id), JSON.stringify({itemId:item.id,disbursementId:disbursement.id,reason}));
      }
      const res = await fetch("/api/hr/payroll/disburse", {method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({action:"reverse",disbursementId:disbursement.id,reason})});
      const body = await res.json();
      if (!res.ok) throw new Error(body.message || "تعذّر تأكيد عكس الصرف.");
      if (!readPayrollReversalConfirmation(body, disbursement, reason)) {
        throw new Error("لم تتأكد نتيجة عكس الصرف؛ احتُفظ بطلب العكس. تحقق أو أعد عكس الحركة نفسها.");
      }
      localStorage.removeItem(reversalKey(item.id)); localStorage.removeItem(pendingKey(item.id));
      setError(null); await loadRuns();
    } catch (err) { setError(err instanceof Error ? err.message : "تعذّر تأكيد عكس الصرف."); }
    finally { inFlight.current = false; setSubmitting(false); }
  };

  const verifyPendingPayment = async () => {
    if (!pending || !disburseItem || inFlight.current) return;
    inFlight.current = true; setSubmitting(true);
    try {
      const res = await fetch(`/api/hr/payroll/disburse?clientRequestId=${encodeURIComponent(pending.clientRequestId)}`, { cache: "no-store" });
      const body: unknown = await res.json();
      const receipt = res.ok && body !== null && typeof body === "object" && !Array.isArray(body)
        ? readPayrollDisbursement((body as Record<string, unknown>).disbursement, disburseItem, pending) : null;
      if (!receipt) throw new Error("لم تتأكد نتيجة الصرف؛ احتُفظ بالمفتاح نفسه، ولا تبدأ عملية أخرى قبل التحقق.");
      if (receipt.reversedAt) localStorage.removeItem(pendingKey(disburseItem.id));
      else localStorage.setItem(pendingKey(disburseItem.id), JSON.stringify({ ...pending, completed: true }));
      setPending(null); setDisburseModalOpen(false); setDisburseItem(null); setError(null); await loadRuns();
    } catch (err) { setError(err instanceof Error ? err.message : "لم تتأكد نتيجة الصرف؛ احتُفظ بالمفتاح نفسه."); }
    finally { inFlight.current = false; setSubmitting(false); }
  };

  const currentPeriodObj = periods.find((p) => String(p.id) === selectedPeriod);

  return (
    <section aria-label="إدارة المسير والصرف" className="space-y-4">
      {/* Top Header: Period & Currency */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-navy-100 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <label className="mb-1 block text-xs font-semibold text-navy-500">فترة المسير:</label>
            <div className="flex items-center gap-2">
              <select
                value={selectedPeriod}
                onChange={(e) => {
                  if (e.target.value !== selectedPeriod) {
                    runRequest.current += 1; currentRunScope.current = `${e.target.value}:${selectedCurrency}`;
                    setActiveRun(null); setSelectedPeriod(e.target.value);
                  }
                }}
                className="rounded-xl border border-navy-200 bg-white px-3 py-2 text-sm font-semibold text-navy-800 outline-none"
              >
                {periods.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.periodKey} {p.status === "closed" ? "(مغلقة)" : "(مفتوحة)"}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => setPeriodModalOpen(true)}
                className="rounded-xl border border-navy-200 bg-navy-50 px-3 py-2 text-xs font-semibold text-navy-700 hover:bg-navy-100"
              >
                + شهر جديد
              </button>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold text-navy-500">العملة (عزل تام):</label>
            <div className="flex gap-1.5">
              {CURRENCIES.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => {
                    if (c !== selectedCurrency) {
                      runRequest.current += 1; currentRunScope.current = `${selectedPeriod}:${c}`;
                      setActiveRun(null); setSelectedCurrency(c as HrCurrency);
                    }
                  }}
                  className={`rounded-xl px-3 py-1.5 text-xs font-bold transition ${
                    selectedCurrency === c
                      ? "bg-navy-800 text-white shadow-sm"
                      : "border border-navy-200 bg-white text-navy-700 hover:bg-navy-50"
                  }`}
                >
                  {c} ({CURRENCY_SHORT[c]})
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Calculate & Approve Actions */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={submitting || currentPeriodObj?.status === "closed" || activeRun?.status === "approved"}
            onClick={handleCalculateRun}
            className="flex items-center gap-1.5 rounded-xl bg-navy-800 px-4 py-2.5 text-xs font-semibold text-white shadow-sm hover:bg-navy-700 disabled:opacity-50"
          >
            <span>⚡</span>
            <span>احتساب المسير ({selectedCurrency})</span>
          </button>

          {activeRun && activeRun.status === "draft" && (
            <button
              type="button"
              disabled={submitting || activeRun.items?.some((item) => item.blockerCodes.length > 0)}
              onClick={handleApproveRun}
              className="flex items-center gap-1.5 rounded-xl bg-emerald-700 px-4 py-2.5 text-xs font-semibold text-white shadow-sm hover:bg-emerald-800 disabled:opacity-50"
            >
              <span>✓</span>
              <span>اعتماد وترحيل للمالية</span>
            </button>
          )}

          {activeRun && (
            <a
              href={`/print/hr/payroll/${activeRun.id}`}
              target="_blank"
              rel="noreferrer"
              className="rounded-xl border border-navy-200 bg-white px-3 py-2.5 text-xs font-semibold text-navy-700 hover:bg-navy-50"
            >
              طباعة الكشف
            </a>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          {error}
        </div>
      )}

      {/* Summary Cards */}
      {activeRun ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
          <div className="rounded-2xl border border-navy-100 bg-white p-3 shadow-sm">
            <div className="text-xs font-semibold text-navy-500">الراتب الأساسي</div>
            <div className="mt-1 font-mono text-lg font-bold text-navy-900">
              {formatAmount(activeRun.totalBaseSalaryMinor, activeRun.currency as Currency)}
            </div>
          </div>
          <div className="rounded-2xl border border-navy-100 bg-white p-3 shadow-sm">
            <div className="text-xs font-semibold text-navy-500">البدلات</div>
            <div className="mt-1 font-mono text-lg font-bold text-navy-900">
              {formatAmount(activeRun.totalAllowancesMinor, activeRun.currency as Currency)}
            </div>
          </div>
          <div className="rounded-2xl border border-emerald-100 bg-emerald-50/50 p-3 shadow-sm">
            <div className="text-xs font-semibold text-emerald-700">نسب الأطباء</div>
            <div className="mt-1 font-mono text-lg font-bold text-emerald-800">
              {formatAmount(activeRun.totalCommissionsMinor, activeRun.currency as Currency)}
            </div>
          </div>
          <div className="rounded-2xl border border-navy-100 bg-white p-3 shadow-sm">
            <div className="text-xs font-semibold text-navy-500">المدفوع</div>
            <div className="mt-1 font-mono text-lg font-bold text-navy-900">
              {formatAmount(activeRun.totalPaidMinor, activeRun.currency as Currency)}
            </div>
          </div>
          <div className="rounded-2xl border border-rose-100 bg-rose-50/50 p-3 shadow-sm">
            <div className="text-xs font-semibold text-rose-700">الخصميات والغياب</div>
            <div className="mt-1 font-mono text-lg font-bold text-rose-800">
              {formatAmount(activeRun.totalDeductionsMinor, activeRun.currency as Currency)}
            </div>
          </div>
          <div className="rounded-2xl border border-navy-800 bg-navy-800 p-3 text-white shadow-sm">
            <div className="text-xs font-semibold text-navy-200">الصافي المستحق</div>
            <div className="mt-1 font-mono text-lg font-bold text-white">
              {formatAmount(activeRun.totalNetDueMinor, activeRun.currency as Currency)}
            </div>
          </div>
        </div>
      ) : (
        <div className="rounded-2xl border border-dashed border-navy-200 bg-white p-8 text-center text-sm text-navy-500">
          لم يتم احتساب مسير رواتب لعملة {selectedCurrency} في هذا الشهر بعد. اضغط على «احتساب المسير» للبدء.
        </div>
      )}

      {/* Breakdown Items Table */}
      {activeRun && activeRun.items && activeRun.items.length > 0 && (
        <div className="overflow-x-auto rounded-2xl border border-navy-100 bg-white shadow-sm">
          <table className="w-full text-right text-sm">
            <thead className="border-b border-navy-100 bg-navy-50/60 text-xs font-semibold text-navy-600">
              <tr>
                <th className="px-4 py-3">الموظف</th>
                <th className="px-4 py-3">الأساسي</th>
                <th className="px-4 py-3">البدلات</th>
                <th className="px-4 py-3">نسبة طبيب</th>
                <th className="px-4 py-3">المتبقي</th>
                <th className="px-4 py-3">خصم</th>
                <th className="px-4 py-3">الصافي</th>
                <th className="px-4 py-3">المصروف</th>
                <th className="px-4 py-3">الحالة</th>
                <th className="px-4 py-3 text-center">إجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-navy-100 font-mono text-xs">
              {activeRun.items.map((item) => {
                const hasCommission = item.commissionsMinor > 0;
                const isPaid = item.remainingMinor <= 0;

                return (
                  <tr key={item.id} className="transition hover:bg-navy-50/40">
                    <td className="px-4 py-3 font-sans font-semibold text-navy-900">
                      <div>{item.staffName || `موظف #${item.staffId}`}</div>
                      {item.staffJobTitle && <div className="text-xs text-navy-500">{item.staffJobTitle}</div>}
                      {item.blockerCodes.length > 0 && <div className="text-rose-700">يحتاج مراجعة شروط الأجر: {item.blockerCodes.join("، ")}</div>}
                    </td>
                    <td className="px-4 py-3">{formatAmount(item.baseSalaryMinor, activeRun.currency as Currency)}</td>
                    <td className="px-4 py-3">{formatAmount(item.allowancesMinor, activeRun.currency as Currency)}</td>
                    <td className="px-4 py-3">
                      {hasCommission ? (
                        <span className="font-bold text-emerald-700">
                          {formatAmount(item.commissionsMinor, activeRun.currency as Currency)}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {item.remainingMinor > 0 ? (
                        formatAmount(item.remainingMinor, activeRun.currency as Currency)
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-4 py-3 text-rose-700">
                      {item.deductionsMinor > 0 ? (
                        `-${formatAmount(item.deductionsMinor, activeRun.currency as Currency)}`
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-4 py-3 font-bold text-navy-900">
                      {formatAmount(item.netDueMinor, activeRun.currency as Currency)}
                    </td>
                    <td className="px-4 py-3 text-emerald-800">
                      {formatAmount(item.paidMinor, activeRun.currency as Currency)}
                    </td>
                    <td className="px-4 py-3 font-sans">
                      <span
                        className={`inline-block rounded-lg px-2 py-0.5 text-xs font-semibold ${
                          isPaid
                            ? "bg-emerald-100 text-emerald-800"
                            : item.status === "partially_paid"
                            ? "bg-blue-100 text-blue-800"
                            : "bg-amber-100 text-amber-800"
                        }`}
                      >
                        {(HR_PAYROLL_ITEM_STATUS_LABELS as Record<string, string>)[item.status] || item.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-sans text-center">
                      {!isPaid && activeRun.status === "approved" && currentPeriodObj?.status !== "closed" && (
                        <button
                          type="button"
                          onClick={() => openDisburseForItem(item)}
                          className="rounded-lg bg-navy-800 px-2.5 py-1 text-xs font-semibold text-white hover:bg-navy-700"
                        >
                          صرف
                        </button>
                      )}
                      {isPaid && <span className="text-xs text-emerald-700 font-bold">مصروف كامل</span>}
                      {item.disbursements?.map((d) => <div key={d.id} className="mt-2">
                        {d.parts.map((part) => <a key={part.expenseId} href={`/print/voucher/${part.expenseId}`} target="_blank" rel="noreferrer" className="block underline">سند {part.component === "salary" ? "الراتب" : "العمولة"} #{part.expenseId}</a>)}
                        {d.reversedAt && <span>معكوس: {d.reversalReason}</span>}
                        <button type="button" disabled={submitting} className="text-rose-700 underline"
                          onClick={() => void handleReverse(item, d)}>
                          {d.reversedAt ? "التحقق من عكس الصرف" : "عكس الصرف"} #{d.id}
                        </button>
                      </div>)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Open Period Modal */}
      {periodModalOpen && (
        <Modal onClose={() => setPeriodModalOpen(false)}>
          <form onSubmit={handleOpenPeriod} className="space-y-3">
            <h3 className="text-base font-bold text-navy-900">فتح فترة مسير رواتب جديدة</h3>
            <div>
              <label className="mb-1 block text-xs font-semibold text-navy-700">الشهر (YYYY-MM) *</label>
              <input
                required
                type="month"
                value={newPeriodMonth}
                onChange={(e) => setNewPeriodMonth(e.target.value)}
                className="w-full rounded-xl border border-navy-200 p-2.5 text-sm outline-none"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setPeriodModalOpen(false)}
                className="rounded-xl border border-navy-200 px-3 py-1.5 text-xs font-semibold text-navy-700"
              >
                إلغاء
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="rounded-xl bg-navy-800 px-4 py-1.5 text-xs font-semibold text-white"
              >
                {submitting ? "جاري الفتح..." : "فتح الفترة"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* Disburse Modal */}
      {disburseModalOpen && disburseItem && activeRun && (
        <Modal onClose={() => setDisburseModalOpen(false)}>
          <form onSubmit={handleDisburse} className="space-y-3">
            <h3 className="text-base font-bold text-navy-900">صرف مستحق راتب</h3>
            <div className="rounded-xl bg-navy-50/50 p-2.5 text-xs text-navy-700">
              الموظف: <span className="font-semibold">{disburseItem.staffName}</span> | المتبقي:{" "}
              <span className="font-semibold">
                {formatAmount(disburseItem.remainingMinor, activeRun.currency as Currency)}{" "}
                {activeRun.currency}
              </span>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-navy-700">المبلغ المصروف *</label>
              <input
                required
                type="number"
                step="any"
                disabled={!!pending || submitting}
                value={disburseAmount}
                onChange={(e) => setDisburseAmount(e.target.value)}
                className="w-full rounded-xl border border-navy-200 p-2.5 text-sm outline-none font-mono"
              />
            </div>
            {disburseItem.salaryRemainingMinor > 0 && disburseItem.commissionRemainingMinor > 0 && (
              <div className="grid grid-cols-2 gap-3">
                <label>جزء الراتب ({activeRun.currency})<input aria-label="جزء الراتب" disabled={!!pending || submitting} type="number" min="0" step="any" value={salaryPart} onChange={(e) => setSalaryPart(e.target.value)} className="w-full rounded-xl border p-2" /></label>
                <label>جزء العمولة ({activeRun.currency})<input aria-label="جزء العمولة" disabled={!!pending || submitting} type="number" min="0" step="any" value={commissionPart} onChange={(e) => setCommissionPart(e.target.value)} className="w-full rounded-xl border p-2" /></label>
              </div>
            )}
            {pending && <div className="space-y-2">
              <p role="status" className="text-sm text-amber-800">طلب محفوظ: عند عدم تأكد النتيجة، أعد الصرف بنفس البيانات والمفتاح.</p>
              <button type="button" disabled={submitting} onClick={() => void verifyPendingPayment()} className="rounded-lg border px-3 py-2 text-sm">التحقق من الصرف السابق</button>
            </div>}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs font-semibold text-navy-700">طريقة الدفع</label>
                <select
                  disabled={!!pending || submitting}
                  value={disburseMethod}
                  onChange={(e) => setDisburseMethod(e.target.value)}
                  className="w-full rounded-xl border border-navy-200 p-2.5 text-sm outline-none"
                >
                  <option value="cash">نقداً (الصندوق)</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-navy-700">رقم السند / المرجع</label>
                <input
                  type="text"
                  disabled={!!pending || submitting}
                  value={disburseRef}
                  onChange={(e) => setDisburseRef(e.target.value)}
                  placeholder="مثال: سند صرف #120"
                  className="w-full rounded-xl border border-navy-200 p-2.5 text-sm outline-none"
                />
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-navy-700">ملاحظات الصرف</label>
              <input
                type="text"
                disabled={!!pending || submitting}
                value={disburseNotes}
                onChange={(e) => setDisburseNotes(e.target.value)}
                className="w-full rounded-xl border border-navy-200 p-2.5 text-sm outline-none"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setDisburseModalOpen(false)}
                className="rounded-xl border border-navy-200 px-3 py-1.5 text-xs font-semibold text-navy-700"
              >
                إلغاء
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="rounded-xl bg-navy-800 px-4 py-1.5 text-xs font-semibold text-white"
              >
                {submitting ? "جاري الصرف..." : "تأكيد الصرف وتسجيل المصروف"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
