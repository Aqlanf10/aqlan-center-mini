"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { isCurrency, type Currency } from "@/lib/money";
import { useClinicName, useSetting } from "@/components/SettingsProvider";
import { useSession } from "@/components/SessionProvider";
import { isAdmin } from "@/lib/roles";
import { expectedInBox, type ExpenseCategory } from "@/lib/expenses";
import { friendlyDateLong } from "@/lib/reminders";
import { clinicDateString } from "@/lib/schedule";
import { PageHeader } from "@/components/PageHeader";
import { financeLinks } from "@/components/financeLinks";
import { FinanceNavigation } from "@/components/FinanceNavigation";
import { CollectPaymentModal } from "@/components/CollectPaymentModal";
import { LabReconciliationModal } from "@/components/LabReconciliationModal";
import { CaseProfitabilityModal } from "@/components/CaseProfitabilityModal";

import { FinanceKpis, type FinanceTab } from "@/components/finance/FinanceKpis";
import { QuickCollectModal } from "@/components/finance/QuickCollectModal";
import {
  CashShiftTab,
  type ShiftData,
  type PaymentItem,
  type ExpenseItem,
  type PartyItem,
} from "@/components/finance/CashShiftTab";
import {
  ReceivablesLabsTab,
  type DebtPatientRow,
  type LabSummaryRow,
} from "@/components/finance/ReceivablesLabsTab";
import {
  CommissionsProfitabilityTab,
  type CommissionRowItem,
} from "@/components/finance/CommissionsProfitabilityTab";
import { AccountingReportsTab } from "@/components/finance/AccountingReportsTab";
import type { LabDeliveryRisk } from "@/lib/lab-reconciliation";

interface Feed {
  open: ShiftData | null;
  totals: { byCurrency: Record<Currency, number>; baseTotalMinor: number; paymentCount: number };
  expenseTotals: {
    byCategory: Record<ExpenseCategory, number>;
    byCurrency: Record<Currency, number>;
    baseTotalMinor: number;
    count: number;
  };
  payments: PaymentItem[];
  expenses: ExpenseItem[];
  recent: ShiftData[];
}

interface PlansSummary {
  activePlansCount: number;
  overdueCount: number;
}

interface LabReconciliationOverview {
  labs: LabSummaryRow[];
  risks: LabDeliveryRisk[];
  totalRisksCount: number;
}

interface CommissionsData {
  rows: CommissionRowItem[];
  totals: {
    totalDueMinor: number;
    totalEarnedMinor: number;
    totalAccruedMinor: number;
    totalPaidMinor: number;
  };
  isPersonalOnly: boolean;
}

interface AccountBalanceItem {
  code: string;
  name: string;
  kind: "asset" | "liability" | "equity" | "revenue" | "expense";
  debitMinor: number;
  creditMinor: number;
}

interface AccountingData {
  balances: AccountBalanceItem[];
  entryCount: number;
}

export default function FinancePage() {
  const session = useSession();
  const admin = isAdmin(session?.role);
  const clinicName = useClinicName();
  const clinicPhone = useSetting("clinic.phone");
  const baseSetting = useSetting("finance.base_currency");
  const base: Currency = isCurrency(baseSetting) ? baseSetting : "YER";
  const today = useMemo(() => clinicDateString(new Date(), "Asia/Aden"), []);

  // التبويب النشط
  const [activeTab, setActiveTab] = useState<FinanceTab>("cash");

  // البيانات المالية الرئيسية
  const [feed, setFeed] = useState<Feed | null>(null);
  const [parties, setParties] = useState<PartyItem[]>([]);
  const [debtRows, setDebtRows] = useState<DebtPatientRow[]>([]);
  const [plansStats, setPlansStats] = useState<PlansSummary>({ activePlansCount: 0, overdueCount: 0 });
  const [labOverview, setLabOverview] = useState<LabReconciliationOverview | null>(null);
  const [commissionsData, setCommissionsData] = useState<CommissionsData | null>(null);
  const [commissionsError, setCommissionsError] = useState<string | null>(null);
  const [accountingData, setAccountingData] = useState<AccountingData | null>(null);

  // حالات التحميل والعمليات
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // النوافذ المنبثقة التفاعلية
  const [isQuickCollectOpen, setIsQuickCollectOpen] = useState(false);
  const [selectedCollectPatient, setSelectedCollectPatient] = useState<{
    id: number;
    name: string;
    dueMinor?: number;
  } | null>(null);
  const [isLabReconcileOpen, setIsLabReconcileOpen] = useState(false);
  const [selectedLabPartyId, setSelectedLabPartyId] = useState<number | null>(null);
  const [isProfitabilityOpen, setIsProfitabilityOpen] = useState(false);

  // سندات تم إصدارها للتو
  const [lastVoucherId, setLastVoucherId] = useState<number | null>(null);
  const [lastReceiptId, setLastReceiptId] = useState<number | null>(null);

  // حالات الفتح السريع في تبويب الصندوق
  const [spending, setSpending] = useState(false);
  const [closing, setClosing] = useState(false);

  // تحميل كافة البيانات المالية بالتوازي
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const promises: Promise<Response>[] = [
        fetch("/api/shifts", { cache: "no-store" }),
        fetch("/api/parties", { cache: "no-store" }),
        fetch("/api/finance/debts", { cache: "no-store" }),
        fetch("/api/plans", { cache: "no-store" }),
        fetch("/api/finance/lab-reconciliation", { cache: "no-store" }),
        fetch("/api/finance/commissions", { cache: "no-store" }),
      ];

      // إذا كان المستخدم مديراً، جلب ملخص اليومية المحاسبية وميزان المراجعة
      if (admin) {
        promises.push(fetch("/api/accounting", { cache: "no-store" }));
      }

      const results = await Promise.allSettled(promises);

      const [shiftsRes, partiesRes, debtsRes, plansRes, labReconcileRes, commissionsRes, accountingRes] =
        results;

      // ١. الصندوق والورديات
      if (shiftsRes.status === "fulfilled" && shiftsRes.value.ok) {
        setFeed((await shiftsRes.value.json()) as Feed);
      } else if (shiftsRes.status === "fulfilled") {
        const p = await shiftsRes.value.json().catch(() => null);
        throw new Error(p?.message ?? "تعذّر تحميل بيانات الصندوق.");
      }

      // ٢. جهات التعامل والموردين
      if (partiesRes.status === "fulfilled" && partiesRes.value.ok) {
        setParties(await partiesRes.value.json());
      }

      // ٣. ديون المرضى
      if (debtsRes.status === "fulfilled" && debtsRes.value.ok) {
        const debtPayload = await debtsRes.value.json();
        setDebtRows(debtPayload.rows || []);
      }

      // ٤. خطط الأقساط العلاجية
      if (plansRes.status === "fulfilled" && plansRes.value.ok) {
        const plansPayload = await plansRes.value.json();
        const plans: { status: string; progress?: { overdueMinor: number } }[] =
          plansPayload.plans || [];
        const active = plans.filter((p) => p.status === "active");
        const overdue = active.filter((p) => (p.progress?.overdueMinor || 0) > 0);
        setPlansStats({ activePlansCount: active.length, overdueCount: overdue.length });
      }

      // ٥. تسويات معامل الأسنان ومخاطر التسليم
      if (labReconcileRes.status === "fulfilled" && labReconcileRes.value.ok) {
        setLabOverview(await labReconcileRes.value.json());
      }

      // ٦. عمولات الأطباء (مع مراعاة الصلاحيات)
      if (commissionsRes.status === "fulfilled" && commissionsRes.value.ok) {
        const commPayload = await commissionsRes.value.json();
        setCommissionsData({
          rows: commPayload.rows || [],
          totals: commPayload.totals || {
            totalDueMinor: 0,
            totalEarnedMinor: 0,
            totalAccruedMinor: 0,
            totalPaidMinor: 0,
          },
          isPersonalOnly: Boolean(commPayload.isPersonalOnly),
        });
        setCommissionsError(null);
      } else if (commissionsRes.status === "fulfilled" && commissionsRes.value.status === 403) {
        setCommissionsError("الاطلاع على كشف عمولات الأطباء محجوز للمدير أو الطبيب المصرح له.");
      }

      // ٧. الدفاتر المحاسبية (للمدير)
      if (accountingRes && accountingRes.status === "fulfilled" && accountingRes.value.ok) {
        const accPayload = await accountingRes.value.json();
        setAccountingData({
          balances: accPayload.balances || [],
          entryCount: accPayload.entryCount || 0,
        });
      }

      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "تعذّر تحميل البيانات المالية.");
    } finally {
      setLoading(false);
    }
  }, [admin]);

  useEffect(() => {
    void load();
  }, [load]);

  // احتساب النقدية المتوقعة بالدرج
  const expected = useMemo(() => {
    if (!feed?.open) return null;
    return expectedInBox(feed.open.opening, feed.totals.byCurrency, feed.expenseTotals.byCurrency);
  }, [feed]);

  // إجمالي ديون المرضى
  const totalDebtsMinor = useMemo(() => {
    return debtRows.reduce((acc, r) => acc + (r.dueMinor || 0), 0);
  }, [debtRows]);

  // إجمالي مستحقات المعامل
  const totalLabPayablesMinor = useMemo(() => {
    return labOverview?.labs.reduce((acc, l) => acc + (l.unsettledCostMinor || 0), 0) ?? 0;
  }, [labOverview]);

  const unsettledLabOrdersCount = useMemo(() => {
    return labOverview?.labs.reduce((acc, l) => acc + (l.unsettledOrdersCount || 0), 0) ?? 0;
  }, [labOverview]);

  // فتح الوردية
  const handleOpenShift = useCallback(
    async (openingAmounts: Record<Currency, string>) => {
      if (busy) return;
      setBusy(true);
      try {
        const res = await fetch("/api/shifts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ opening: openingAmounts }),
        });
        const payload = await res.json().catch(() => null);
        if (!res.ok) {
          setError(payload?.message ?? "تعذّر فتح الوردية.");
          return;
        }
        setError(null);
        await load();
      } catch {
        setError("تعذّر الاتصال بالخادم.");
      } finally {
        setBusy(false);
      }
    },
    [busy, load]
  );

  // إغلاق الوردية
  const handleCloseShift = useCallback(
    async (countedAmounts: Record<Currency, string>, noteText: string) => {
      if (busy || !feed?.open) return;
      setBusy(true);
      try {
        const res = await fetch("/api/shifts", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: feed.open.id, counted: countedAmounts, note: noteText }),
        });
        const payload = await res.json().catch(() => null);
        if (!res.ok) {
          setError(payload?.message ?? "تعذّر إغلاق الوردية.");
          return;
        }
        setClosing(false);
        setError(null);
        await load();
      } catch {
        setError("تعذّر الاتصال بالخادم.");
      } finally {
        setBusy(false);
      }
    },
    [busy, feed, load]
  );

  // تسجيل سند صرف نثري
  const handleCreateExpense = useCallback(
    async (form: {
      category: ExpenseCategory;
      partyId: string;
      payee: string;
      amount: string;
      currency: Currency;
      note: string;
    }) => {
      if (busy) return;
      setBusy(true);
      try {
        const res = await fetch("/api/expenses", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(form),
        });
        const payload = await res.json().catch(() => null);
        if (!res.ok) {
          setError(payload?.message ?? "تعذّر تسجيل سند الصرف.");
          return;
        }
        setLastVoucherId((payload as { id: number }).id);
        setSpending(false);
        setError(null);
        await load();
        return (payload as { id: number }).id;
      } catch {
        setError("تعذّر الاتصال بالخادم.");
      } finally {
        setBusy(false);
      }
    },
    [busy, load]
  );

  // حذف سند صرف (للمدير مع التدقيق)
  const handleRemoveExpense = useCallback(
    async (voucherId: number, voucherNumber: string) => {
      if (busy) return;
      if (
        !window.confirm(
          `تأكيد حذف سند الصرف ${voucherNumber}؟\nسيُمحى من حسابات الوردية ويُسجّل إجراء الحذف في سجل التدقيق المحاسبي.`
        )
      ) {
        return;
      }
      setBusy(true);
      try {
        const res = await fetch(`/api/expenses?id=${voucherId}`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: "حذف من الصندوق المالي" }),
        });
        const payload = await res.json().catch(() => null);
        if (!res.ok) {
          setError(payload?.message ?? "تعذّر حذف السند.");
          return;
        }
        setError(null);
        await load();
      } catch {
        setError("تعذّر الاتصال بالخادم.");
      } finally {
        setBusy(false);
      }
    },
    [busy, load]
  );

  // إعادة تحميل عمولات الأطباء لفترة محددة
  const handleCommissionDateChange = useCallback(
    async (start: string, end: string) => {
      try {
        const res = await fetch(`/api/finance/commissions?from=${start}&to=${end}`, {
          cache: "no-store",
        });
        if (res.ok) {
          const payload = await res.json();
          setCommissionsData({
            rows: payload.rows || [],
            totals: payload.totals || {
              totalDueMinor: 0,
              totalEarnedMinor: 0,
              totalAccruedMinor: 0,
              totalPaidMinor: 0,
            },
            isPersonalOnly: Boolean(payload.isPersonalOnly),
          });
          setCommissionsError(null);
        }
      } catch {
        /* تجاهل الخطأ المؤقت */
      }
    },
    []
  );

  return (
    <main className="mx-auto max-w-5xl p-4 pb-28">
      {/* الترويسة الرئيسية والروابط الرسمية */}
      <PageHeader
        title="الإدارة والرقابة المالية الطبية"
        subtitle={`${clinicName} — العمليات المالية — ${friendlyDateLong(today)}`}
        links={financeLinks("/finance")}
      />

      {/* شريط التنقل بالركائز الأربع المعيارية للمركز */}
      <FinanceNavigation currentHref="/finance" />

      {/* رسالة الخطأ العامة إن وُجدت */}
      {error ? (
        <div role="alert" className="mb-5 rounded-2xl border border-red-200 bg-red-50 p-4 text-xs font-bold text-red-800">
          <p>{error}</p>
        </div>
      ) : null}

      {/* لوحة المؤشرات الحيوية الخمس وشريط الإجراءات السريعة والتبويبات الأربعة */}
      <FinanceKpis
        activeTab={activeTab}
        onTabChange={setActiveTab}
        baseCurrency={base}
        isShiftOpen={Boolean(feed?.open)}
        openedBy={feed?.open?.openedBy}
        expectedInBox={expected}
        shiftTotals={feed?.totals ?? null}
        expenseTotals={feed?.expenseTotals ?? null}
        totalDebtsMinor={totalDebtsMinor}
        debtorsCount={debtRows.length}
        overduePlansCount={plansStats.overdueCount}
        totalLabPayablesMinor={totalLabPayablesMinor}
        unsettledLabOrdersCount={unsettledLabOrdersCount}
        onOpenQuickCollect={() => setIsQuickCollectOpen(true)}
        onOpenNewExpense={() => {
          setActiveTab("cash");
          setSpending(true);
        }}
        onOpenCloseShift={() => {
          setActiveTab("cash");
          setClosing(true);
        }}
        onOpenLabReconcile={() => {
          setSelectedLabPartyId(null);
          setIsLabReconcileOpen(true);
        }}
        onOpenProfitability={() => setIsProfitabilityOpen(true)}
      />

      {/* محتوى التبويبات الأربعة */}
      {loading && !feed ? (
        <div className="rounded-3xl border border-slate-200 bg-white p-12 text-center text-xs text-slate-400">
          جارٍ تحميل المنظومة المالية…
        </div>
      ) : activeTab === "cash" ? (
        /* التبويب ١: الصندوق والعمليات اليومية */
        <CashShiftTab
          shift={feed?.open ?? null}
          payments={feed?.payments ?? []}
          expenses={feed?.expenses ?? []}
          recentShifts={feed?.recent ?? []}
          expectedInBox={expected}
          baseCurrency={base}
          parties={parties}
          isAdmin={admin}
          busy={busy}
          onOpenShift={handleOpenShift}
          onCloseShift={handleCloseShift}
          onCreateExpense={handleCreateExpense}
          onRemoveExpense={handleRemoveExpense}
          onOpenQuickCollect={() => setIsQuickCollectOpen(true)}
          lastVoucherId={lastVoucherId}
          onClearLastVoucher={() => setLastVoucherId(null)}
          lastReceiptId={lastReceiptId}
          onClearLastReceipt={() => setLastReceiptId(null)}
          spending={spending}
          setSpending={setSpending}
          closing={closing}
          setClosing={setClosing}
        />
      ) : activeTab === "receivables" ? (
        /* التبويب ٢: الذمم والتحصيل والمعامل */
        <ReceivablesLabsTab
          debtRows={debtRows}
          baseCurrency={base}
          clinicName={clinicName}
          clinicPhone={clinicPhone}
          labSummaries={labOverview?.labs ?? []}
          labRisks={labOverview?.risks ?? []}
          onOpenCollectForPatient={(p) => {
            setSelectedCollectPatient(p);
          }}
          onOpenLabReconcileForParty={(partyId) => {
            setSelectedLabPartyId(partyId);
            setIsLabReconcileOpen(true);
          }}
        />
      ) : activeTab === "commissions" ? (
        /* التبويب ٣: عمولات الأطباء والربحية */
        <CommissionsProfitabilityTab
          rows={commissionsData?.rows ?? []}
          baseCurrency={base}
          isPersonalOnly={commissionsData?.isPersonalOnly ?? false}
          isAdmin={admin}
          onOpenProfitability={() => setIsProfitabilityOpen(true)}
          onDateRangeChange={handleCommissionDateChange}
          loading={loading}
          error={commissionsError}
        />
      ) : (
        /* التبويب ٤: الدفاتر والتقارير المحاسبية */
        <AccountingReportsTab
          balances={accountingData?.balances ?? []}
          baseCurrency={base}
          isAdmin={admin}
          entryCount={accountingData?.entryCount ?? 0}
        />
      )}

      {/* نافذة اختيار المريض لإصدار سند قبض سريع */}
      <QuickCollectModal
        isOpen={isQuickCollectOpen}
        onClose={() => setIsQuickCollectOpen(false)}
        onSelectPatient={(p) => {
          setSelectedCollectPatient(p);
        }}
        debtors={debtRows}
        currency={base}
      />

      {/* نافذة تحصيل الدفعة وإصدار سند القبض والطباعة */}
      {selectedCollectPatient ? (
        <CollectPaymentModal
          patientId={selectedCollectPatient.id}
          patientName={selectedCollectPatient.name}
          isOpen={Boolean(selectedCollectPatient)}
          onClose={() => setSelectedCollectPatient(null)}
          onSuccess={(paymentId) => {
            setSelectedCollectPatient(null);
            setLastReceiptId(paymentId);
            void load();
          }}
          suggestedMinor={selectedCollectPatient.dueMinor}
          contextLabel={
            selectedCollectPatient.dueMinor && selectedCollectPatient.dueMinor > 0
              ? `سداد مديونية مستحقة: ${selectedCollectPatient.name}`
              : undefined
          }
        />
      ) : null}

      {/* معالج تسوية ومطابقة كشوفات المعامل */}
      {isLabReconcileOpen ? (
        <LabReconciliationModal
          initialPartyId={selectedLabPartyId}
          onClose={() => {
            setIsLabReconcileOpen(false);
            setSelectedLabPartyId(null);
          }}
          onSuccess={() => {
            setIsLabReconcileOpen(false);
            setSelectedLabPartyId(null);
            void load();
          }}
        />
      ) : null}

      {/* محاكي فحص وهوامش ربحية الحالات السريرية */}
      {isProfitabilityOpen ? (
        <CaseProfitabilityModal
          currency={base}
          onClose={() => setIsProfitabilityOpen(false)}
        />
      ) : null}
    </main>
  );
}
