"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CURRENCIES, CURRENCY_LABEL, CLINIC_BASE_CURRENCY, balanceText, formatAmount, formatMoney, invoiceNet, isCurrency, parseAmount, type Balance, type Currency } from "@/lib/money";
import { useSession } from "./SessionProvider";
import { isAdmin } from "@/lib/roles";
import { friendlyDateLong } from "@/lib/reminders";
import { PLAN_STATUS_LABEL } from "@/lib/plans";
import { ServiceSelect } from "./ServiceSelect";
import { CollectPaymentModal } from "./CollectPaymentModal";
import { InvoiceCorrection } from "./InvoiceCorrection";
import { ReceiptCorrection } from "./ReceiptCorrection";
import { LegacyBalanceArrangementPanel, type LegacyArrangementView, type LegacyOpeningPosition } from "./LegacyBalanceArrangementPanel";
import { OpeningBalanceGuidance } from "./LegacyMoneyGuidance";
import { LegacyReconciliationPreview } from "./LegacyReconciliationPreview";
import { LegacyTreatmentForm } from "./LegacyTreatmentForm";
import { LegacyTreatmentAgreements } from "./LegacyTreatmentAgreements";
import { SITE_SCOPE_LABEL, allowedScopes, lineLinkage, type ToothScopeMode } from "@/lib/invoice-clinical-linkage";
import { ToothSelectionDialog } from "./dental/ToothSelectionDialog";
import { invoiceLineInputProblem, previewForRow, readPreviewLines, type PreviewState } from "./dental/invoice-preview-state";
import {
  PER_TOOTH_SPLIT_NOTICE, applyToothSelection, emptyToothFields, invoiceToothMode, removeRowAt, replaceRowService,
  selectionLabel, selectionOfRow, setRowScope, toothPayload, toothProblem, usesToothChart,
  type ToothRowLike, type ToothSelection,
} from "./dental/invoice-tooth-selection";
import { newIdempotencyKey } from "@/lib/idempotency-key";

/**
 * حساب المريض: الرصيد والفواتير والدفعات، وإنشاء فاتورة وقبض دفعة.
 *
 * الرصيد فوق كل شيء لأنه السؤال الذي يُسأل على الباب. وتحته سببه — الفواتير
 * والدفعات — لأن رقمًا بلا تفصيل يُجادَل عليه ولا يُثبَت.
 */

interface Service { id: number; name: string; category: string | null; priceMinor: number }
interface InvoiceItem { id: number; description: string; quantity: number; unitPriceMinor: number; totalMinor: number }
interface Invoice {
  id: number; invoiceNumber: string; status: "open" | "paid" | "cancelled";
  patientId?: number;
  totalMinor: number; discountMinor: number; note: string | null; createdAt: string; items: InvoiceItem[];
  baseCurrency: Currency;
}
interface Payment {
  id: number; receiptNumber: string; invoiceId: number | null; kind: "payment" | "refund";
  amountMinor: number; currency: Currency; exchangeRate: number; baseAmountMinor: number;
  method: string; note: string | null; createdAt: string;
  planId?: number | null; openingCurrency?: Currency | null;
}
interface OpeningBalance {
  patientId: number; amountMinor: number; asOfDate: string; note: string | null;
  /** (P1-5ب) عملة الرصيد — يبقى بها. */
  currency?: Currency;
}
interface PlanSummary {
  id: number; title: string; status: "active" | "completed" | "cancelled";
  totalMinor: number; consented: boolean; baseCurrency?: Currency;
  /** (INV-LEGACY) خطة اتفاقٍ تاريخي — مالها في الرصيد السابق لا في الخطة. */
  legacy?: boolean;
  legacyItemCount?: number;
  ordinaryItemsProgress?: { count: number; doneCount: number; doneMinor: number; remainingMinor: number } | null;
  installments: {
    paidMinor: number; remainingMinor: number; overdueMinor: number;
    nextDueDate: string | null; nextDueAmountMinor: number; paidCount: number; count: number;
  } | null;
  items: { count: number; doneCount: number; doneMinor: number; remainingMinor: number } | null;
}
interface Ledger {
  invoices: Invoice[]; payments: Payment[]; opening: OpeningBalance | null;
  /** (P1-5ب) الأرصدة الافتتاحية بعملاتها. */
  openings?: OpeningBalance[];
  /** (DAY1) من يضيف/يعدّل الرصيد السابق — من الخادم. */
  openingAccess?: { add: boolean; edit: boolean };
  balance: Balance; baseCurrency: Currency; plans: PlanSummary[];
  /* (TD-05) أرصدة مستقلة لكل عملة — الرصيد المفرد القديم هو دلو العملة الأساسية. */
  balances?: Record<Currency, Balance>;
  /** (RC-1) المتبقي غير المعكوس من كل سند قبض — يصل للمدير وحده. */
  receiptRemaining?: Record<string, number>;
  /** (P0-C) ترتيب تحصيل الرصيد القديم — ميتاداتا فقط، بلا principal جديد. */
  legacyBalanceArrangements?: LegacyArrangementView[];
  legacyOpeningPositions?: LegacyOpeningPosition[];
  legacyArrangementAccess?: { manage: boolean };
  /** Server-owned, canonical evidence. Absence says nothing about settlement. */
  installmentRecovery?: unknown;
}

const STATUS_LABEL: Record<Invoice["status"], string> = {
  open: "مفتوحة", paid: "مسدّدة", cancelled: "ملغاة",
};

const EMPTY_BALANCE: Balance = { billedMinor: 0, collectedMinor: 0, openingMinor: 0, dueMinor: 0 };

type InvoiceRecoveryView =
  | { kind: "recorded" | "unavailable" | "review" }
  | { kind: "recovery"; remainingMinor: number; currency: Currency; accountCreditReview: boolean };
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const positiveId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const nonnegativeMinor = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** The API's consumed wire contract, including existing optional/legacy fields.
 * Do not coerce, drop rows, invent zero or cast an object into financial truth.
 * Match db.ts toMinor/DTOs and the existing pure summary mappings: signed
 * historical values and nullable references are preserved, not reclassified.
 * Recovery evidence remains unknown and is checked independently per invoice. */
const signedMinor = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
const nullableText = (value: unknown): value is string | null => value === null || typeof value === "string";
const nullableId = (value: unknown): value is number | null => value === null || signedMinor(value);
const moneyFields = (value: Record<string, unknown>, keys: readonly string[]) => keys.every((key) => signedMinor(value[key]));
function isInvoiceItem(value: unknown): value is InvoiceItem {
  return record(value) && signedMinor(value.id) && typeof value.description === "string"
    && signedMinor(value.quantity) && signedMinor(value.unitPriceMinor) && signedMinor(value.totalMinor);
}
function isInvoice(value: unknown): value is Invoice {
  return record(value) && signedMinor(value.id) && typeof value.invoiceNumber === "string"
    && (value.patientId === undefined || signedMinor(value.patientId))
    && (value.status === "open" || value.status === "paid" || value.status === "cancelled")
    && signedMinor(value.totalMinor) && signedMinor(value.discountMinor) && isCurrency(value.baseCurrency)
    && nullableText(value.note) && typeof value.createdAt === "string"
    && Array.isArray(value.items) && value.items.every(isInvoiceItem);
}
function isPayment(value: unknown): value is Payment {
  return record(value) && signedMinor(value.id) && typeof value.receiptNumber === "string" && nullableId(value.invoiceId)
    && (value.kind === "payment" || value.kind === "refund") && signedMinor(value.amountMinor)
    && isCurrency(value.currency) && typeof value.exchangeRate === "number" && Number.isFinite(value.exchangeRate)
    && signedMinor(value.baseAmountMinor) && typeof value.method === "string" && nullableText(value.note)
    && typeof value.createdAt === "string" && (value.planId === undefined || nullableId(value.planId))
    && (value.openingCurrency === undefined || value.openingCurrency === null || isCurrency(value.openingCurrency));
}
function isOpening(value: unknown): value is OpeningBalance {
  return record(value) && signedMinor(value.patientId) && signedMinor(value.amountMinor)
    && typeof value.asOfDate === "string" && nullableText(value.note)
    && (value.currency === undefined || isCurrency(value.currency));
}
function isBalance(value: unknown): value is Balance {
  return record(value) && moneyFields(value, ["billedMinor", "collectedMinor", "openingMinor", "dueMinor"]);
}
function isPlanSummary(value: unknown): value is PlanSummary {
  if (!record(value) || !signedMinor(value.id) || typeof value.title !== "string"
    || (value.status !== "active" && value.status !== "completed" && value.status !== "cancelled")
    || !signedMinor(value.totalMinor) || typeof value.consented !== "boolean"
    || (value.baseCurrency !== undefined && !isCurrency(value.baseCurrency))
    || (value.legacy !== undefined && typeof value.legacy !== "boolean")) return false;
  if (value.legacy === true) {
    if (!positiveId(value.legacyItemCount)) return false;
    const ordinary = value.ordinaryItemsProgress;
    if (ordinary !== null && (!record(ordinary) || !nonnegativeMinor(ordinary.count) || !nonnegativeMinor(ordinary.doneCount)
      || !nonnegativeMinor(ordinary.doneMinor) || !nonnegativeMinor(ordinary.remainingMinor))) return false;
  }
  const installments = value.installments;
  if (installments !== null && (!record(installments)
    || !moneyFields(installments, ["paidMinor", "remainingMinor", "overdueMinor", "nextDueAmountMinor"])
    || !nullableText(installments.nextDueDate) || !signedMinor(installments.paidCount) || !signedMinor(installments.count))) return false;
  const items = value.items;
  return items === null || (record(items) && signedMinor(items.count) && signedMinor(items.doneCount)
    && moneyFields(items, ["doneMinor", "remainingMinor"]));
}
function isLegacyOpening(value: unknown): value is LegacyOpeningPosition {
  return record(value) && isCurrency(value.currency) && moneyFields(value, ["openingMinor", "settledMinor", "remainingMinor"]);
}
function isLegacyArrangement(value: unknown): value is LegacyArrangementView {
  if (!record(value) || !signedMinor(value.id) || !isCurrency(value.currency)
    || (value.cadence !== "per_visit" && value.cadence !== "monthly")
    || !moneyFields(value, ["installmentMinor", "startingDueMinor"]) || !nullableText(value.firstDueDate)
    || !nullableText(value.note) || !record(value.progress)) return false;
  return moneyFields(value.progress, ["currentOpeningDueMinor", "paidSinceStartMinor", "arrangementRemainingMinor",
    "suggestedMinor", "overdueMinor", "nextDueAmountMinor"])
    && nullableText(value.progress.nextDueDate) && typeof value.progress.completed === "boolean";
}
function isLedgerRead(value: unknown): value is Ledger {
  if (!record(value) || !Array.isArray(value.invoices) || !value.invoices.every(isInvoice)
    || !Array.isArray(value.payments) || !value.payments.every(isPayment)
    || !Array.isArray(value.plans) || !value.plans.every(isPlanSummary)
    || (value.opening !== null && !isOpening(value.opening)) || !isBalance(value.balance)
    || !isCurrency(value.baseCurrency)) return false;
  if (value.openings !== undefined && (!Array.isArray(value.openings) || !value.openings.every(isOpening))) return false;
  const balances = value.balances;
  if (balances !== undefined && (!record(balances) || !CURRENCIES.every((currency) => isBalance(balances[currency])))) return false;
  if (value.openingAccess !== undefined && (!record(value.openingAccess)
    || typeof value.openingAccess.add !== "boolean" || typeof value.openingAccess.edit !== "boolean")) return false;
  if (value.receiptRemaining !== undefined && (!record(value.receiptRemaining)
    || !Object.values(value.receiptRemaining).every(signedMinor))) return false;
  if (value.legacyBalanceArrangements !== undefined && (!Array.isArray(value.legacyBalanceArrangements)
    || !value.legacyBalanceArrangements.every(isLegacyArrangement))) return false;
  if (value.legacyOpeningPositions !== undefined && (!Array.isArray(value.legacyOpeningPositions)
    || !value.legacyOpeningPositions.every(isLegacyOpening))) return false;
  return value.legacyArrangementAccess === undefined || (record(value.legacyArrangementAccess)
    && typeof value.legacyArrangementAccess.manage === "boolean");
}

/** This validates an existing read projection, never derives settlement from
 * raw status, notes or the ledger's payment list. It authorizes no collection. */
function invoiceRecoveryView(invoice: Invoice, patientId: number, evidence: unknown, ready: boolean): InvoiceRecoveryView {
  if (invoice.status === "cancelled") return { kind: "recorded" };
  if (invoice.status !== "open" && invoice.status !== "paid") return { kind: "unavailable" };
  if (!ready) return { kind: "unavailable" };
  if (evidence === undefined) return { kind: "recorded" };
  if (!record(evidence) || !Array.isArray(evidence.recoveries) || !Array.isArray(evidence.reviews)) return { kind: "unavailable" };
  const rows: unknown[] = [...evidence.recoveries, ...evidence.reviews];
  // An unidentifiable entry could belong to this invoice; never silently drop it.
  if (rows.some((row) => !record(row) || !positiveId(row.invoiceId))) return { kind: "unavailable" };
  const recoveries = (evidence.recoveries as Record<string, unknown>[]).filter((row) => row.invoiceId === invoice.id);
  const reviews = (evidence.reviews as Record<string, unknown>[]).filter((row) => row.invoiceId === invoice.id);
  if (recoveries.length + reviews.length === 0) return { kind: "recorded" };
  if (recoveries.length + reviews.length !== 1 || !positiveId(patientId)
    || invoice.patientId !== patientId || !isCurrency(invoice.baseCurrency)
    || !nonnegativeMinor(invoice.totalMinor) || !nonnegativeMinor(invoice.discountMinor)) return { kind: "unavailable" };
  if (reviews.length === 1) {
    const review = reviews[0];
    return (review.planId === null || positiveId(review.planId)) && typeof review.reason === "string" && review.reason.trim().length > 0
      ? { kind: "review" } : { kind: "unavailable" };
  }
  const recovery = recoveries[0];
  if (recovery.kind !== "recoverable" || recovery.purpose !== "reversed-installment-recovery"
    || recovery.patientId !== patientId || !positiveId(recovery.planId)
    || !positiveId(recovery.originPaymentId) || !positiveId(recovery.creationAuditId)
    || recovery.rawInvoiceStatus !== invoice.status || recovery.currency !== invoice.baseCurrency
    || !positiveId(recovery.principalMinor) || recovery.principalMinor !== invoiceNet(invoice)
    || !nonnegativeMinor(recovery.linkedNetPaidMinor) || !positiveId(recovery.remainingMinor)
    || recovery.principalMinor - recovery.linkedNetPaidMinor !== recovery.remainingMinor
    || typeof recovery.actualAccountDueMinor !== "number" || !Number.isSafeInteger(recovery.actualAccountDueMinor)
    || !nonnegativeMinor(recovery.suggestedCashMinor)
    || recovery.suggestedCashMinor !== Math.min(recovery.remainingMinor, Math.max(0, recovery.actualAccountDueMinor))
    || typeof recovery.accountCreditReview !== "boolean"
    || recovery.accountCreditReview !== (recovery.actualAccountDueMinor < recovery.remainingMinor)
    || !Array.isArray(recovery.reversalPaymentIds) || recovery.reversalPaymentIds.length === 0
    || !recovery.reversalPaymentIds.every(positiveId)
    || new Set(recovery.reversalPaymentIds).size !== recovery.reversalPaymentIds.length) return { kind: "unavailable" };
  return { kind: "recovery", remainingMinor: recovery.remainingMinor, currency: invoice.baseCurrency, accountCreditReview: recovery.accountCreditReview };
}

/** Actual invoice-row presentation, shared with focused markup regressions. */
export function InvoiceSettlementStatus({ invoice, patientId, evidence, ready }: {
  invoice: Invoice; patientId: number; evidence: unknown; ready: boolean;
}) {
  const view = invoiceRecoveryView(invoice, patientId, evidence, ready);
  return (
    <span role="group" aria-label={`حالة تسوية الفاتورة ${invoice.invoiceNumber}`}
      className={view.kind === "recorded" ? undefined : "inline-block max-w-full align-top"}>
      <span>{view.kind === "recorded" ? "" : "الحالة المسجلة: "}{STATUS_LABEL[invoice.status]}</span>
      {view.kind === "recovery" ? (
        <span className="mt-1 block rounded-lg border border-amber-200 bg-amber-50 px-2 py-1 text-amber-900">
          <span className="block font-bold">متبقٍ مرتبط بالفاتورة بعد عكس السداد: {formatMoney(view.remainingMinor, view.currency)}</span>
          <span className="block">{view.accountCreditReview
            ? "المتبقي المرتبط بالفاتورة ليس مبلغًا للتحصيل؛ راجع رصيد الحساب بعملته"
            : "هذا متبقٍ مرتبط بالفاتورة؛ رصيد الحساب بعملته هو المرجع للمستحق الحالي"}</span>
        </span>
      ) : view.kind === "review" ? (
        <span className="mt-1 block font-bold text-amber-800">حالة السداد تحتاج مراجعة</span>
      ) : view.kind === "unavailable" ? (
        <span className="mt-1 block text-slate-500">تعذّر التحقق من حالة السداد؛ راجع رصيد الحساب بعملته</span>
      ) : null}
    </span>
  );
}

/* (TD-05) أدوات عرض الأرصدة متعددة العملات. */
function activeBalances(ledger: Ledger): { currency: Currency; bucket: Balance }[] {
  const balances = ledger.balances
    ?? { YER: ledger.balance, SAR: EMPTY_BALANCE, USD: EMPTY_BALANCE } as Record<Currency, Balance>;
  return CURRENCIES
    .map((currency) => ({ currency, bucket: balances[currency] ?? EMPTY_BALANCE }))
    .filter(({ bucket }) =>
      bucket.billedMinor !== 0 || bucket.collectedMinor !== 0
      || bucket.openingMinor !== 0 || bucket.dueMinor !== 0);
}

export function PatientLedger({ patientId, onClinicalChange }: { patientId: number; onClinicalChange?: () => void }) {
  const session = useSession();
  // A fresh patient/principal/permission owner cannot reuse another owner's read.
  const scope = JSON.stringify([patientId, session]);
  if (!session) return <p role="status" className="p-4 text-sm text-slate-500">غير مصرّح لك بعرض حساب المريض.</p>;
  return <PatientLedgerContent key={scope} patientId={patientId} onClinicalChange={onClinicalChange} />;
}

function PatientLedgerContent({ patientId, onClinicalChange }: { patientId: number; onClinicalChange?: () => void }) {
  // (TD-05) الأساس دستوري من الكود.
  const fallbackBase: Currency = CLINIC_BASE_CURRENCY;

  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [services, setServices] = useState<Service[]>([]);
  const [linkNotice, setLinkNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"none" | "invoice" | "opening" | "legacy">("none");
  /* (INV-LEGACY) إعادة قراءة لوحة الاتفاقات التاريخية بعد التسجيل. */
  const [legacyRefresh, setLegacyRefresh] = useState(0);
  /* القبض من المكوّن الموحّد — نفس المكون ونفس الواجهة البرمجية من كل الأبواب (AC-09). */
  const [collectOpen, setCollectOpen] = useState(false);
  const [lastReceiptId, setLastReceiptId] = useState<number | null>(null);
  const session = useSession();
  const admin = isAdmin(session?.role);
  /* (FIN-2) الفاتورة المفتوحة للتصحيح الآن، ورسالة نجاح التصحيح. */
  const [correcting, setCorrecting] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /* (RC-1) سند القبض المفتوح للتصحيح الآن. */
  const [correctingReceipt, setCorrectingReceipt] = useState<number | null>(null);

  const base = ledger?.baseCurrency ?? fallbackBase;
  /* (DAY1 — قرار المالك) الاستقبال يضيف الرصيد السابق، والتعديل والحذف للمدير. */
  const canAddOpening = ledger?.openingAccess?.add ?? admin;
  const canEditOpening = ledger?.openingAccess?.edit ?? admin;
  const canAddLegacy = !loading && !error && ledger?.openingAccess?.add === true;

  const readRef = useRef({ active: false, generation: 0, controller: null as AbortController | null });
  const load = useCallback(async () => {
    const lifetime = readRef.current;
    if (!lifetime.active) return;
    const generation = ++lifetime.generation;
    lifetime.controller?.abort();
    const controller = new AbortController(); lifetime.controller = controller;
    const current = () => lifetime.active && lifetime.generation === generation && !controller.signal.aborted;
    setLoading(true);
    try {
      // The optional catalogue must not delay a denied ledger response or retain
      // old financial evidence while its headers/body are still pending.
      void fetch("/api/services", { cache: "no-store", signal: controller.signal }).then(async (response) => {
        if (!current() || !response.ok) return;
        const nextServices: unknown = await response.json();
        if (current() && Array.isArray(nextServices)) setServices(nextServices);
      }).catch(() => {});
      const ledgerResponse = await fetch(`/api/patients/${patientId}/ledger`, { cache: "no-store", signal: controller.signal });
      if (!current()) return;
      // Retire denied data before awaiting an error body that may never arrive.
      if (!ledgerResponse.ok) {
        if (ledgerResponse.status === 401 || ledgerResponse.status === 403) setLedger(null);
        throw new Error(ledgerResponse.status === 401 || ledgerResponse.status === 403
          ? "غير مصرّح لك بعرض حساب المريض." : "تعذّر تحميل حساب المريض.");
      }
      const payload: unknown = await ledgerResponse.json();
      if (!current()) return;
      if (!isLedgerRead(payload)) throw new Error("تعذّر التحقق من بيانات حساب المريض.");
      setLedger(payload);
      setError(null);
    } catch (loadError) {
      if (!current()) return;
      setError(loadError instanceof Error ? loadError.message : "تعذّر التحميل.");
    } finally {
      if (current()) setLoading(false);
    }
  }, [patientId]);

  useEffect(() => {
    const lifetime = readRef.current; lifetime.active = true;
    void load();
    return () => { lifetime.active = false; lifetime.generation++; lifetime.controller?.abort(); };
  }, [load]);

  const send = useCallback(async (run: () => Promise<Response>) => {
    if (busy) return null;
    setBusy(true);
    try {
      const response = await run();
      const payload = await response.json().catch(() => null);
      if (!response.ok) { setError(payload?.message ?? "تعذّر التنفيذ."); return null; }
      setError(null);
      await load();
      return payload;
    } catch {
      setError("تعذّر الاتصال بالخادم.");
      return null;
    } finally {
      setBusy(false);
    }
  }, [busy, load]);

  if (loading && !ledger) {
    return <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">جارٍ التحميل…</p>;
  }
  if (!ledger && error) return <p role="alert" aria-label="خطأ حساب المريض" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</p>;

  return (
    <div>
      {error ? (
        <p role="alert" aria-label="خطأ حساب المريض" className="mb-3 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</p>
      ) : null}
      {notice ? (
        <p role="status" className="mb-3 rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-2 text-sm font-bold text-emerald-800">{notice}</p>
      ) : null}

      {ledger ? (
        /* (TD-05) رصيدٌ لكل عملة ذات نشاط: عملةٌ واحدة تُعرض كما كان دائمًا،
           وعملات اتفاقٍ متعددة تُعرض كلٌّ ببطاقتها الموسومة — لا رقمٌ واحد يمزجها. */
        activeBalances(ledger).map(({ currency, bucket }) => (
          <div key={currency} className={`mb-3 rounded-2xl border-2 p-4 text-center ${
            bucket.dueMinor > 0 ? "border-amber-300 bg-amber-50"
              : bucket.dueMinor < 0 ? "border-brand-blue bg-white"
              : "border-emerald-300 bg-emerald-50"
          }`}>
            <p className="text-xl font-extrabold">
              {bucket.dueMinor === 0 ? "المستحق الحالي مسدّد" : balanceText(bucket, currency)}
              {activeBalances(ledger).length > 1 ? (
                <span className="mr-2 rounded-full bg-white/70 px-2 py-0.5 text-[11px] font-bold text-slate-600">
                  {CURRENCY_LABEL[currency]}
                </span>
              ) : null}
            </p>
            <p className="mt-1 text-[11px] font-bold text-slate-500">
              مفوتر {formatMoney(bucket.billedMinor, currency)} · محصّل {formatMoney(bucket.collectedMinor, currency)}
              {bucket.openingMinor > 0
                ? ` · رصيد افتتاحي ${formatMoney(bucket.openingMinor, currency)}`
                : ""}
            </p>
          </div>
        ))
      ) : null}

      {ledger && !loading && !error ? (
        <LegacyReconciliationPreview patientId={patientId} ready
          positions={ledger.legacyOpeningPositions} payments={ledger.payments} />
      ) : null}

      {ledger ? (
        <LegacyBalanceArrangementPanel
          patientId={patientId}
          openingPositions={ledger.legacyOpeningPositions ?? []}
          arrangements={ledger.legacyBalanceArrangements ?? []}
          canManage={ledger.legacyArrangementAccess?.manage ?? false}
          onChanged={() => { void load(); }}
        />
      ) : null}

      <div className="mb-3 flex flex-wrap gap-1.5">
        <button onClick={() => setMode(mode === "invoice" ? "none" : "invoice")}
          className="rounded-xl bg-navy-800 px-4 py-2 text-xs font-bold text-white">
          {mode === "invoice" ? "إغلاق" : "فاتورة يدوية"}
        </button>
        {canAddLegacy ? (
          <button type="button" onClick={() => setMode(mode === "legacy" ? "none" : "legacy")}
            aria-pressed={mode === "legacy"}
            className="rounded-xl border border-indigo-300 bg-indigo-50 px-4 py-2 text-xs font-bold text-indigo-800">
            {mode === "legacy" ? "إغلاق" : "علاج بدأ قبل النظام"}
          </button>
        ) : null}
        <button onClick={() => setCollectOpen(true)}
          className="rounded-xl bg-brand-orange px-4 py-2 text-xs font-bold text-white">
          قبض دفعة
        </button>
        <a href={`/print/statement/${patientId}`} target="_blank" rel="noopener"
          className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-bold text-navy-800">
          كشف حساب
        </a>
        {canAddOpening ? (
          <button onClick={() => setMode(mode === "opening" ? "none" : "opening")}
            className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-bold text-navy-800">
            {mode === "opening" ? "إغلاق" : (ledger?.openings?.length ?? (ledger?.opening ? 1 : 0)) > 0
              ? (canEditOpening ? "تعديل الرصيد السابق" : "رصيد سابق") : "رصيد سابق (قبل النظام)"}
          </button>
        ) : null}
      </div>

      {lastReceiptId ? (
        <div className="mb-3 rounded-2xl border border-emerald-300 bg-emerald-50 p-3 text-center">
          <p className="mb-2 text-sm font-bold text-emerald-800">سُجّلت الدفعة.</p>
          <a href={`/print/receipt/${lastReceiptId}`} target="_blank" rel="noopener"
            onClick={() => setLastReceiptId(null)}
            className="inline-block rounded-xl bg-emerald-600 px-4 py-2 text-sm font-bold text-white">
            اطبع السند
          </a>
        </div>
      ) : null}

      {linkNotice ? (
        <p role="status" data-testid="invoice-clinical-notice" className="mb-3 rounded-xl border border-sky-200 bg-sky-50 p-2.5 text-xs font-bold text-sky-900">
          {linkNotice}
        </p>
      ) : null}

      {mode === "invoice" ? (
        <InvoiceForm key={patientId}
          patientId={patientId} base={base} services={services} busy={busy}
          onSubmit={async (body) => {
            const created = await send(() => fetch("/api/invoices", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ patientId, ...body }),
            })) as { clinical?: { links: { kind: string; planItemCreated: boolean; caseCreated: boolean; caseId: number | null }[] } } | null;
            if (readRef.current.active && created) {
              onClinicalChange?.();
              setMode("none");
              /* (INV-LINK D) ما فعلته الفاتورة بالعلاج — يُقال صراحةً بعد الحفظ. */
              const clinical = created.clinical?.links.filter((link) => link.kind === "clinical") ?? [];
              setLinkNotice(clinical.length === 0 ? null
                : `رُبطت الفاتورة بالعلاج: ${clinical.length} بند خطة${clinical.some((l) => l.planItemCreated) ? " (منها جديد)" : ""}`
                  + `${clinical.some((l) => l.caseCreated) ? " — وفُتحت حالة أولية تحتاج تقييم الطبيب" : clinical.some((l) => l.caseId) ? " — مربوطة بحالتها القائمة" : ""}.`);
            }
          }}
        />
      ) : null}

      {mode === "legacy" && canAddLegacy ? (
        <LegacyTreatmentForm
          patientId={patientId} base={base} services={services} busy={busy}
          positions={ledger?.legacyOpeningPositions}
          onCancel={() => setMode("none")}
          onSubmit={async (body) => {
            if (!canAddLegacy || !readRef.current.active) return;
            const saved = await send(() => fetch(`/api/patients/${patientId}/legacy-treatments`, {
              method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
            })) as { agreement?: { remainingMinor: number; caseId: number | null } } | null;
            if (readRef.current.active && saved?.agreement) {
              onClinicalChange?.();
              setMode("none");
              setLegacyRefresh((value) => value + 1);
              setLinkNotice(`سُجّل العلاج السابق للنظام: ${saved.agreement.remainingMinor > 0
                ? "المتبقي وحده دخل الحساب رصيدًا سابقًا" : "مسدَّد تاريخيًّا بلا رصيد"} — لا سند للمدفوع سابقًا`
                + `${saved.agreement.caseId ? "، والحالة موسومة «حالة بدأت قبل النظام»" : ""}.`);
            }
          }}
        />
      ) : null}

      {ledger && !loading && !error ? (
        <LegacyTreatmentAgreements patientId={patientId} refreshKey={legacyRefresh} onChanged={() => {
          if (!readRef.current.active) return; onClinicalChange?.(); void load();
        }} />
      ) : null}

      {/* التحصيل الموحّد — نفس مكون التحصيل من كل الأبواب (المواصفة §٢٦) */}
      <CollectPaymentModal
        patientId={patientId}
        patientName="المريض"
        isOpen={collectOpen}
        onClose={() => setCollectOpen(false)}
        onSuccess={(paymentId) => {
          setCollectOpen(false);
          setLastReceiptId(paymentId);
          void load();
        }}
        invoices={(ledger?.invoices ?? [])
          .filter((invoice) => invoice.status === "open")
          .map((invoice) => ({
            id: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
            totalMinor: invoice.totalMinor,
            discountMinor: invoice.discountMinor,
            /* (TD-05 owner review) عملة كل فاتورة معها — اختيارها يعرضها ويقترح
               تحصيلها بعملتها لا بعملة الدفاتر. */
            baseCurrency: invoice.baseCurrency,
          }))}
        /* (TD-05 owner review — Finding 5) خطة الاتفاق هدفٌ صريح للدفع المقدَّم
           قبل الفوترة — الدفعات عليها تسوّي دلو عملتها. */
        plans={(ledger?.plans ?? [])
          /* (INV-LEGACY) خطة الاتفاق التاريخي ليست هدف تحصيل: متبقيها يُحصَّل على الرصيد السابق. */
          .filter((plan) => plan.status === "active" && !plan.legacy)
          .map((plan) => ({
            id: plan.id,
            title: plan.title,
            baseCurrency: plan.baseCurrency,
          }))}
        /* (P1-5ب) رصيدٌ سابق مستحق بعملته — يُسدَّد بعملته. */
        openings={(ledger?.openings ?? [])
          .filter((opening) => opening.currency && (ledger?.balances?.[opening.currency]?.dueMinor ?? 0) > 0)
          .map((opening) => ({
            currency: opening.currency as Currency,
            dueMinor: Math.min(opening.amountMinor, ledger?.balances?.[opening.currency as Currency]?.dueMinor ?? 0),
          }))}
      />

      {mode === "opening" && canAddOpening ? (
        <OpeningForm
          base={base} busy={busy} canEdit={canEditOpening}
          openings={ledger?.openings ?? (ledger?.opening ? [{ ...ledger.opening, currency: base }] : [])}
          onSubmit={async (body) => {
            const saved = await send(() => fetch("/api/opening-balances", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ patientId, ...body }),
            }));
            if (saved) setMode("none");
          }}
          onClear={async (reason, currency) => {
            const cleared = await send(() => fetch(
              `/api/opening-balances?patientId=${patientId}&currency=${currency}&reason=${encodeURIComponent(reason)}`, { method: "DELETE" },
            ));
            if (cleared) setMode("none");
          }}
        />
      ) : null}

      {/* خطط العلاج — الجسر بين الاتفاق والمال. تُعرض بقصتها لا برصيدها:
          خطة الأقساط تُفوتر بأقساطها (سنداتها فواتير ودفعات أدناه)، وخطة البنود
          تُفوتر بزياراتها الموقّعة. الرصيد أعلاه يبقى الرقم المعتمد وحده. */}
      {ledger && ledger.plans.length > 0 ? (
        <section className="mb-4" aria-label="خطط العلاج">
          <h3 className="mb-2 text-sm font-bold">خطط العلاج ({ledger.plans.length})</h3>
          <ul className="space-y-2">
            {ledger.plans.map((plan) => {
              const ordinary = plan.legacy ? plan.ordinaryItemsProgress : plan.items;
              return (
              <li key={plan.id} className={`rounded-2xl border p-3 ${
                plan.status === "active" ? "border-slate-200 bg-white" : "border-slate-200 bg-slate-50 opacity-70"
              }`}>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-extrabold">{plan.title}</span>
                  <span className="flex items-center gap-1.5">
                    {plan.legacy ? (
                      <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-bold text-indigo-800">حالة بدأت قبل النظام</span>
                    ) : null}
                    {!plan.consented ? (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-800">مسوّدة</span>
                    ) : null}
                    <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-[10px] font-bold text-slate-600">
                      {PLAN_STATUS_LABEL[plan.status]}
                    </span>
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-1.5 text-center text-xs">
                  <div className="rounded-lg bg-slate-50 px-1.5 py-1.5">
                    <p className="font-extrabold">{formatMoney(plan.totalMinor, plan.baseCurrency ?? base)}</p>
                    <p className="text-[10px] text-slate-500">{plan.legacy ? "قيمة الخطة المتضمنة للتاريخ (ليست دَينًا)" : "المتفق عليه"}</p>
                  </div>
                  {plan.installments ? (
                    <>
                      <div className="rounded-lg bg-emerald-50 px-1.5 py-1.5">
                        <p className="font-extrabold text-emerald-800">{formatMoney(plan.installments.paidMinor, plan.baseCurrency ?? base)}</p>
                        <p className="text-[10px] text-emerald-700">المسدّد</p>
                      </div>
                      <div className="rounded-lg bg-slate-50 px-1.5 py-1.5">
                        <p className="font-extrabold">{formatMoney(plan.installments.remainingMinor, plan.baseCurrency ?? base)}</p>
                        <p className="text-[10px] text-slate-500">الباقي</p>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="rounded-lg bg-emerald-50 px-1.5 py-1.5">
                        <p className="font-extrabold text-emerald-800">{ordinary ? formatMoney(ordinary.doneMinor, plan.baseCurrency ?? base) : "غير متاح"}</p>
                        <p className="text-[10px] text-emerald-700">{plan.legacy ? "أُنجز من البنود الأخرى" : "أُنجز"}</p>
                      </div>
                      <div className="rounded-lg bg-slate-50 px-1.5 py-1.5">
                        <p className="font-extrabold">{ordinary ? formatMoney(ordinary.remainingMinor, plan.baseCurrency ?? base) : "غير متاح"}</p>
                        <p className="text-[10px] text-slate-500">{plan.legacy ? "باقي البنود الأخرى" : "بقي العلاج"}</p>
                      </div>
                    </>
                  )}
                </div>
                {plan.legacy ? <p role="status" data-testid="ledger-legacy-progress-unknown" className="mt-2 text-xs text-indigo-900">
                  {plan.legacyItemCount} بنود ذات تاريخ سابق: المنجَز قبل النظام والباقي سريريًّا غير معلومين من الاتفاق. الأرقام السابقة ليست دَينًا جديدًا؛ المستحق هو رصيد الحساب فقط.
                  {!plan.consented ? " موافقة العلاج الفعلية لم تُسجّل؛ حفظ المسودة متاح والتوقيع ينتظرها." : ""}
                </p> : null}
                {plan.installments?.overdueMinor ? (
                  <p className="mt-1.5 text-[11px] font-bold text-red-700">
                    متأخر: {formatMoney(plan.installments.overdueMinor, plan.baseCurrency ?? base)}
                  </p>
                ) : null}
                {plan.installments?.nextDueDate ? (
                  <p className="mt-1 text-[11px] text-slate-500">
                    القسط القادم {friendlyDateLong(plan.installments.nextDueDate)} ·{" "}
                    {formatMoney(plan.installments.nextDueAmountMinor, plan.baseCurrency ?? base)}
                  </p>
                ) : null}
                <p className="mt-1.5 text-[10px] leading-4 text-slate-400">
                  {plan.legacy
                    ? "متبقي الاتفاق التاريخي يُحصَّل من الرصيد السابق. البنود الأخرى تتبع فواتيرها المثبتة؛ لا تُحصَّل قيمة الخطة التاريخية كدفعة جديدة."
                    : plan.installments
                    ? "قبضُ القسط يُصدر فاتورة ودفعة تظهران في القائمتين أدناه."
                    : "تُفوتر بزياراتها: كلّ زيارة موقَّعة تُصدر فاتورةً في القائمة أدناه."}
                </p>
              </li>
              );
            })}
          </ul>
          <p className="mt-2 text-[11px] leading-4 text-slate-400">
            الخطة اتفاق لا دَين: تُدخل الحساب عند الفوترة فقط، ورصيد الحساب أعلاه هو الرقم
            المعتمد دائمًا. <a href={`?tab=plans`} className="font-bold text-navy-800 underline decoration-navy-300 underline-offset-4">إدارة الخطط</a>
          </p>
        </section>
      ) : null}

      <section className="mb-4" aria-label="الفواتير">
        <h3 className="mb-2 text-sm font-bold">الفواتير ({ledger?.invoices.length ?? 0})</h3>
        {!ledger?.invoices.length ? (
          <p className="rounded-2xl border border-slate-200 bg-white p-4 text-center text-sm text-slate-400">لا فواتير.</p>
        ) : (
          <ul className="space-y-2">
            {ledger.invoices.map((invoice) => (
              <li key={invoice.id} className={`rounded-2xl border p-3 ${
                invoice.status === "cancelled" ? "border-slate-200 bg-slate-50 opacity-60" : "border-slate-200 bg-white"
              }`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-extrabold">{invoice.invoiceNumber}</span>
                  <span className="text-[11px] text-slate-500">
                    {friendlyDateLong(invoice.createdAt.slice(0, 10))} · <InvoiceSettlementStatus invoice={invoice}
                      patientId={patientId} evidence={ledger.installmentRecovery}
                      ready={!loading && !error && ledger.invoices.filter((row) => row.id === invoice.id).length === 1} />
                  </span>
                </div>
                <ul className="mt-2 space-y-0.5">
                  {invoice.items.map((item) => (
                    <li key={item.id} className="flex justify-between gap-2 text-xs text-slate-600">
                      <span className="truncate">{item.description}{item.quantity > 1 ? ` × ${item.quantity}` : ""}</span>
                      <span className="shrink-0">{formatMoney(item.totalMinor, invoice.baseCurrency ?? base)}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-2">
                  <span className="text-sm font-extrabold">
                    {formatMoney(Math.max(0, invoice.totalMinor - invoice.discountMinor), invoice.baseCurrency ?? base)}
                    {invoice.baseCurrency && invoice.baseCurrency !== base ? (
                      <span className="mr-2 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-600">
                        {CURRENCY_LABEL[invoice.baseCurrency]}
                      </span>
                    ) : null}
                    {invoice.discountMinor > 0 ? (
                      <span className="mr-2 text-[11px] font-bold text-emerald-700">
                        خصم {formatMoney(invoice.discountMinor, invoice.baseCurrency ?? base)}
                      </span>
                    ) : null}
                  </span>
                  <span className="flex gap-2">
                    {admin && invoice.status !== "cancelled" && correcting !== invoice.id ? (
                      <button type="button" onClick={() => { setCorrecting(invoice.id); setNotice(null); }}
                        className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-bold text-amber-800">
                        تصحيح
                      </button>
                    ) : null}
                    <a href={`/print/invoice/${invoice.id}`} target="_blank" rel="noopener"
                      className="rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-bold text-navy-800">
                      طباعة
                    </a>
                  </span>
                </div>
                {invoice.note && invoice.note.startsWith("تصحيح للفاتورة") ? (
                  <p className="mt-1 text-[11px] font-bold text-amber-800">{invoice.note}</p>
                ) : null}
                {correcting === invoice.id ? (
                  <InvoiceCorrection
                    invoice={{ ...invoice, baseCurrency: invoice.baseCurrency ?? base }}
                    onCancel={() => setCorrecting(null)}
                    onDone={(message) => { setCorrecting(null); setNotice(message); void load(); }}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="الدفعات">
        <h3 className="mb-2 text-sm font-bold">الدفعات ({ledger?.payments.length ?? 0})</h3>
        {!ledger?.payments.length ? (
          <p className="rounded-2xl border border-slate-200 bg-white p-4 text-center text-sm text-slate-400">لا دفعات.</p>
        ) : (
          <ul className="space-y-2">
            {ledger.payments.map((payment) => (
              <li key={payment.id} className={`flex flex-wrap items-center justify-between gap-2 rounded-2xl border p-3 ${
                payment.kind === "refund" ? "border-red-200 bg-red-50" : "border-slate-200 bg-white"
              }`}>
                <div className="min-w-[8rem] flex-1">
                  <p className="text-sm font-extrabold">
                    {payment.kind === "refund" ? "−" : ""}{formatMoney(payment.amountMinor, payment.currency)}
                    {payment.currency !== base ? (
                      <span className="mr-2 text-[11px] font-normal text-slate-400">
                        = {formatMoney(payment.baseAmountMinor, base)} (سعر {payment.exchangeRate})
                      </span>
                    ) : null}
                  </p>
                  <p className="text-[11px] text-slate-500">
                    {payment.receiptNumber} · {friendlyDateLong(payment.createdAt.slice(0, 10))}
                  </p>
                </div>
                <span className="flex gap-2">
                  {admin && payment.kind === "payment" && (ledger.receiptRemaining?.[payment.id] ?? 0) > 0
                    && correctingReceipt !== payment.id ? (
                    <button type="button" onClick={() => { setCorrectingReceipt(payment.id); setNotice(null); }}
                      className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-bold text-amber-800">
                      تصحيح السند
                    </button>
                  ) : null}
                  <a href={`/print/receipt/${payment.id}`} target="_blank" rel="noopener"
                    className="rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-bold text-navy-800">
                    السند
                  </a>
                </span>
                {payment.note && (payment.note.startsWith("تصحيح السند") || payment.note.startsWith("بدل السند")) ? (
                  <p className="w-full text-[11px] font-bold text-amber-800">{payment.note}</p>
                ) : null}
                {correctingReceipt === payment.id ? (
                  <ReceiptCorrection
                    receipt={payment}
                    remainingMinor={ledger.receiptRemaining?.[payment.id] ?? payment.amountMinor}
                    invoices={ledger.invoices.map((invoice) => ({ ...invoice, baseCurrency: invoice.baseCurrency ?? base }))}
                    plans={ledger.plans}
                    openingCurrencies={(ledger.openings ?? (ledger.opening ? [ledger.opening] : []))
                      .filter((row) => row.amountMinor !== 0).map((row) => row.currency ?? base)}
                    onCancel={() => setCorrectingReceipt(null)}
                    onDone={(message, replacementId) => {
                      setCorrectingReceipt(null); setNotice(message);
                      if (replacementId !== null) setLastReceiptId(replacementId);
                      void load();
                    }}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

type InvoiceRow = ToothRowLike & { doctorId: string; serviceId: string; description: string; price: string; quantity: string; priceReason: string };
const blankInvoiceRow = (key: string): InvoiceRow => ({
  key, doctorId: "", serviceId: "", description: "", price: "", quantity: "1", priceReason: "", caseId: "", ...emptyToothFields("none"),
});

function InvoiceForm({ patientId, base, services, busy, onSubmit }: {
  patientId: number;
  base: Currency;
  services: Service[];
  busy: boolean;
  onSubmit: (body: Record<string, unknown>) => void;
}) {
  /* مفاتيح ثابتة للأسطر: اختيار عدة أسنان يقسم السطر إلى أسطر، فلا يصلح الترتيب مفتاحًا. */
  const rowSeq = useRef(0);
  const nextRowKey = () => `row-${++rowSeq.current}`;
  const [rows, setRows] = useState<InvoiceRow[]>(() => [blankInvoiceRow("row-0")]);
  /* (INV-LINK TOOTH) نافذة «تحديد الأسنان» مفتوحة لهذا السطر (بمفتاحه). */
  const [toothDialogFor, setToothDialogFor] = useState<string | null>(null);
  const [splitNotice, setSplitNotice] = useState<string | null>(null);
  /* (INV-LINK B) مفتاح الإعادة لهذا النموذج: نقرةٌ مزدوجة أو ردٌّ ضائع يعيد الفاتورة نفسها لا فاتورةً ثانية. */
  const [idempotencyKey] = useState(() => newIdempotencyKey("inv"));
  const [previewState, setPreviewState] = useState<PreviewState | null>(null);
  const [previewRetry, setPreviewRetry] = useState(0);
  const [doctorCatalog, setDoctorCatalog] = useState<{ patientId: number; rows: { id: number; name: string }[] } | null>(null);
  const doctors = doctorCatalog?.patientId === patientId ? doctorCatalog.rows : [];
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/parties?kind=doctor", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload: unknown = await response.json().catch(() => null);
        if (controller.signal.aborted) return;
        // Read only the already-authorized catalogue. Denied/malformed reads expose no fallback list.
        if (response.ok && Array.isArray(payload) && payload.every((entry) => record(entry)
          && positiveId(entry.id) && typeof entry.name === "string" && entry.kind === "doctor")) {
          setDoctorCatalog({ patientId, rows: payload.map((entry) => ({ id: entry.id as number, name: entry.name as string })) });
        } else setDoctorCatalog(null);
      }).catch(() => { if (!controller.signal.aborted) setDoctorCatalog(null); });
    return () => controller.abort();
  }, [patientId]);
  const [discount, setDiscount] = useState("");
  /* (FIN-4) الخصم وتغيير سعر خدمة الدليل قراران مسبَّبان — والحد من الإعدادات يفرضه الخادم. */
  const [discountReason, setDiscountReason] = useState("");
  /* (TD-05) عملة الفاتورة — اختيارٌ صريح (YER/SAR/USD) والافتراضي هو الأساس.
     سعر الدليل أساسيّ فلا يُقترح تلقائيًا بعملةٍ مختلفة. */
  const [currency, setCurrency] = useState<Currency>(base);


  // الحساب هنا بنفس دالة القراءة التي يستعملها الخادم: حسابٌ محلي بقواعد أخرى
  // يعطي رقمًا يخالف ما يُحفَظ، فيفقد المستخدم ثقته بالشاشة كلها.
  const total = useMemo(() => rows.reduce((sum, row) => {
    const service = services.find((item) => String(item.id) === row.serviceId);
    const typed = row.price.trim() ? parseAmount(row.price, currency) : null;
    const unit = typed ?? (currency === base && service ? service.priceMinor : 0);
    const quantity = Math.max(1, Math.round(Number(row.quantity) || 1));
    return sum + unit * quantity;
  }, 0), [rows, services, base, currency]);

  const previewAmount = (index: number) => {
    const row = rows[index];
    const service = services.find((item) => String(item.id) === row.serviceId);
    const typed = row.price.trim() ? parseAmount(row.price, currency) : null;
    const unit = typed ?? (currency === base && service ? service.priceMinor : 0);
    return unit * Math.max(1, Math.round(Number(row.quantity) || 1));
  };
  const discountMinor = discount.trim() ? parseAmount(discount, currency) ?? 0 : 0;
  const net = Math.max(0, total - discountMinor);

  /* (INV-LINK D) معاينة ما ستفعله الفاتورة بالعلاج: بند خطة قائم/جديد، حالة قائمة/أولية — قبل الحفظ. */
  const serviceOf = (serviceId: string) => services.find((item) => String(item.id) === serviceId);
  const isClinical = (serviceId: string) => {
    const service = serviceOf(serviceId);
    return service ? lineLinkage({ serviceId: service.id, category: service.category }).kind === "clinical" : false;
  };
  /* (INV-LINK TOOTH) كيف يُحدَّد سن البند — من فئة خدمته وحدها (المصدر نفسه الذي يفرضه الخادم). */
  const modeOf = (row: InvoiceRow): ToothScopeMode => invoiceToothMode(serviceOf(row.serviceId)?.category);
  const inputProblems = rows.map((row) => row.serviceId || row.description.trim()
    ? invoiceLineInputProblem({ price: row.price, quantity: row.quantity, currency,
      servicePriceMinor: serviceOf(row.serviceId)?.priceMinor ?? null }) : null);
  // Changing any row identity or linkage input invalidates evidence during render, before the debounce/effect.
  const previewKey = JSON.stringify({ patientId, currency, discount, discountReason, idempotencyKey, base, retry: previewRetry,
    catalog: services.map((service) => [service.id, service.category, service.priceMinor]),
    rows: rows.map((row, index) => ({ row, index })).filter(({ row }) => row.serviceId || row.description.trim())
      .map(({ row, index }) => ({ key: row.key, clinical: isClinical(row.serviceId), inputProblem: inputProblems[index],
        serviceId: row.serviceId ? Number(row.serviceId) : undefined, description: row.description,
        price: row.price, priceReason: row.priceReason, quantity: Number(row.quantity) || 1,
        caseId: isClinical(row.serviceId) && row.caseId ? Number(row.caseId) : undefined,
        doctorId: row.doctorId ? Number(row.doctorId) : undefined, ...toothPayload(modeOf(row), row) })),
  });
  // Forget old evidence rather than reviving it if inputs later return to an earlier value.
  if (previewState && previewState.requestKey !== previewKey) setPreviewState(null);
  useEffect(() => {
    const request = JSON.parse(previewKey) as {
      patientId: number; currency: Currency; discount: string; discountReason: string; idempotencyKey: string;
      rows: { key: string; clinical: boolean; [field: string]: unknown }[];
    };
    if (!request.rows.some((row) => row.clinical) || request.rows.some((row) => row.inputProblem)) return;
    const controller = new AbortController();
    const unavailable = () => {
      if (!controller.signal.aborted) setPreviewState({ requestKey: previewKey, status: "unavailable", byRow: new Map() });
    };
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      deadline = setTimeout(() => { unavailable(); controller.abort(); }, 15_000);
      void fetch("/api/invoices/clinical-preview", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ patientId: request.patientId, currency: request.currency,
          discount: request.discount, discountReason: request.discountReason, idempotencyKey: request.idempotencyKey,
          items: request.rows.map((row) => {
            const { key, clinical, inputProblem, ...item } = row;
            void key; void clinical; void inputProblem;
            return item;
          }),
        }),
      }).then(async (response) => {
        const payload: unknown = await response.json().catch(() => null);
        if (controller.signal.aborted) return;
        if (!response.ok && [400, 401, 403, 409, 422].includes(response.status)
          && record(payload) && typeof payload.message === "string" && payload.message.trim()) {
          setPreviewState({ requestKey: previewKey, status: "refused", message: payload.message.slice(0, 1500), byRow: new Map() });
          return;
        }
        const byRow = response.ok ? readPreviewLines(payload, request.rows) : null;
        if (!byRow) { unavailable(); return; }
        setPreviewState({ requestKey: previewKey, status: "ready", byRow });
      }).catch(unavailable).finally(() => clearTimeout(deadline));
    }, 350);
    return () => { controller.abort(); clearTimeout(timer); clearTimeout(deadline); };
  }, [previewKey]);
  const clinicalPreviewBlocked = rows.some((row) => isClinical(row.serviceId)
    && previewForRow(previewState, previewKey, row.key).status !== "ready");

  /* (INV-LINK TOOTH) لا يُحفظ بندٌ يحتاج سنًّا بلا سن — والخادم يرفضه أيضًا. */
  const toothProblems = rows.map((row) => row.serviceId ? toothProblem(modeOf(row), row) : null);
  const blockedLines = toothProblems.flatMap((problem, index) => problem ? [index + 1] : []);
  const dialogIndex = toothDialogFor === null ? -1 : rows.findIndex((row) => row.key === toothDialogFor);
  const dialogRow = dialogIndex >= 0 ? rows[dialogIndex] : null;

  const confirmTeeth = (key: string, serviceId: string, expectedMode: ToothScopeMode, selection: ToothSelection) => {
    const index = rows.findIndex((row) => row.key === key);
    if (index < 0 || rows[index].serviceId !== serviceId || modeOf(rows[index]) !== expectedMode) { setToothDialogFor(null); return; }
    const mode = modeOf(rows[index]);
    setRows((current) => {
      const at = current.findIndex((row) => row.key === key);
      return at < 0 || current[at].serviceId !== serviceId || modeOf(current[at]) !== expectedMode
        ? current : applyToothSelection(current, at, mode, selection, nextRowKey);
    });
    const teeth = [...new Set(selection.teeth)].sort((a, b) => a - b);
    setSplitNotice(mode === "per_tooth_episode" && teeth.length > 1 ? `${PER_TOOTH_SPLIT_NOTICE}: ${teeth.join("، ")}.` : null);
    setToothDialogFor(null);
  };

  const scopeButtons = (row: InvoiceRow, index: number, mode: ToothScopeMode) => {
    const scopes = allowedScopes(mode);
    if (scopes.length === 0) return null;
    return (
      <div role="group" aria-label="نطاق العلاج" className="flex flex-wrap rounded-xl border border-slate-200 bg-white p-0.5">
        {scopes.map((scope) => {
          const on = row.toothCode === null && row.scope === scope;
          return (
            <button key={scope} type="button" aria-pressed={on} data-testid={`scope-${scope}`}
              onClick={() => setRows((current) => setRowScope(current, index, on && mode === "arch" ? null : scope))}
              className={`min-h-[44px] rounded-lg px-3 text-xs font-bold transition-colors ${
                on ? "bg-navy-800 text-white shadow-sm" : "text-slate-600 hover:bg-slate-50"}`}>
              {SITE_SCOPE_LABEL[scope]}
            </button>
          );
        })}
      </div>
    );
  };

  const toothControl = (row: InvoiceRow, index: number) => {
    const mode = modeOf(row);
    if (mode === "none") return null;
    const label = selectionLabel(mode, row);
    const chosenTooth = row.toothCode !== null;
    const problem = toothProblems[index];
    const openButton = (text: string) => (
      <button type="button" onClick={() => setToothDialogFor(row.key)} data-testid={`invoice-tooth-button-${index}`}
        aria-haspopup="dialog" aria-invalid={problem ? true : undefined}
        className={`min-h-[44px] whitespace-nowrap rounded-xl border px-3 text-xs font-extrabold transition-colors ${
          problem ? "border-amber-400 bg-amber-50 text-amber-900 hover:bg-amber-100"
            : "border-navy-200 bg-white text-navy-900 hover:bg-navy-50"}`}>
        {text}
      </button>
    );
    return (
      <div className="flex w-full flex-wrap items-center gap-1.5" data-testid={`invoice-tooth-control-${index}`}>
        <span className="text-[11px] font-bold text-slate-500">{mode === "arch" ? "الفك:" : mode === "region" ? "النطاق:" : "الأسنان:"}</span>
        {scopeButtons(row, index, mode)}
        {mode !== "arch" && chosenTooth && label ? (
          <span data-testid={`invoice-tooth-chip-${index}`}
            className="inline-flex min-h-[32px] items-center gap-1 rounded-full border border-navy-200 bg-navy-50 px-3 text-xs font-extrabold text-navy-900">
            🦷 <span>{label}</span>
            {row.groupId && row.episodeTeeth && row.episodeTeeth.length > 1 ? (
              <span className="font-semibold text-slate-500">· هذا السطر: {row.toothCode}</span>
            ) : null}
          </span>
        ) : null}
        {usesToothChart(mode) ? openButton(chosenTooth ? "تغيير" : mode === "region" ? "🦷 سن محدد" : "🦷 تحديد الأسنان") : null}
      </div>
    );
  };

  return (
    <section className="mb-4 rounded-2xl border border-navy-800 bg-white p-4" aria-label="فاتورة جديدة">
      <h3 className="mb-3 text-sm font-bold">فاتورة جديدة</h3>
      <label className="mb-3 block w-48">
        <span className="mb-1 block text-[11px] font-bold text-slate-500">عملة الفاتورة</span>
        <select value={currency} onChange={(event) => setCurrency(event.target.value as Currency)}
          aria-label="عملة الفاتورة"
          className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm">
          {CURRENCIES.map((option) => (
            <option key={option} value={option}>{CURRENCY_LABEL[option]}</option>
          ))}
        </select>
      </label>
      {splitNotice ? (
        <p role="status" data-testid="invoice-split-notice"
          className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-900">
          {splitNotice}
        </p>
      ) : null}
      {rows.map((row, index) => (
        <div key={row.key} data-testid={`invoice-row-${index}`} data-row-key={row.key} data-tooth={row.toothCode ?? ""}
          className={`mb-3 rounded-xl border bg-slate-50/50 p-2.5 space-y-2 ${
            row.groupId ? "border-sky-200 border-s-4 border-s-sky-400" : "border-slate-100"}`}>
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-[14rem] flex-1">
              <ServiceSelect
                services={services}
                value={row.serviceId ? Number(row.serviceId) : null}
                onChange={(id, srv) => {
                  setRows((current) => replaceRowService(current, index, {
                    serviceId: id ? String(id) : "", doctorId: "",
                    price: currency === base && srv ? formatAmount(srv.priceMinor, base) : "",
                    description: srv ? srv.name : current[index].description,
                  }, invoiceToothMode(srv?.category)));
                }}
                base={base}
                allowManual={true}
                placeholder="— اختر الخدمة المصنفة أو بند يدوي —"
                ariaLabel="الخدمة"
              />
            </div>
            {!row.serviceId ? (
              <input
                value={row.description}
                onChange={(event) => setRows((current) => current.map((item, i) =>
                  i === index ? { ...item, description: event.target.value } : item))}
                placeholder="وصف البند المخصص"
                aria-label="وصف البند"
                className="min-w-[8rem] flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
              />
            ) : null}
            <div className="flex items-center gap-1.5">
              <label className="text-[11px] font-bold text-slate-500">السعر:</label>
              <input
                value={row.price}
                onChange={(event) => setRows((current) => current.map((item, i) =>
                  i === index ? { ...item, price: event.target.value } : item))}
                placeholder="السعر"
                aria-label="السعر"
                inputMode="decimal"
                dir="ltr"
                className="w-32 min-w-0 rounded-xl border border-slate-200 bg-white px-2.5 py-2 text-sm font-semibold tabular-nums text-center"
              />
            </div>
            {row.serviceId && (() => {
              const service = services.find((item) => String(item.id) === row.serviceId);
              const typed = row.price.trim() ? parseAmount(row.price, currency) : null;
              const differs = currency !== base ? typed !== null : service ? typed !== null && typed !== service.priceMinor : false;
              return differs ? (
                <input
                  value={row.priceReason}
                  onChange={(event) => setRows((current) => current.map((item, i) =>
                    i === index ? { ...item, priceReason: event.target.value } : item))}
                  placeholder="سبب تغيير السعر عن الدليل"
                  aria-label="سبب تغيير السعر"
                  maxLength={300}
                  className="min-w-[10rem] flex-1 rounded-xl border border-amber-200 bg-amber-50/50 px-3 py-2 text-xs"
                />
              ) : null;
            })()}
            <div className="flex items-center gap-1.5">
              <label className="text-[11px] font-bold text-slate-500">الكمية:</label>
              <input
                value={row.quantity}
                onChange={(event) => setRows((current) => current.map((item, i) =>
                  i === index ? { ...item, quantity: event.target.value } : item))}
                aria-label="الكمية"
                inputMode="numeric"
                dir="ltr"
                className="w-16 rounded-xl border border-slate-200 bg-white px-2 py-2 text-sm font-semibold text-center"
              />
            </div>
            {rows.length > 1 ? (
              <button
                type="button"
                onClick={() => setRows((current) => removeRowAt(current, index))}
                className="rounded-xl border border-slate-200 bg-white px-2.5 py-2 text-sm font-bold text-red-500 hover:bg-red-50"
                title="حذف البند"
              >
                ✕
              </button>
            ) : null}
            {isClinical(row.serviceId) ? (
              <label className="min-w-[12rem] flex-1">
                <span className="mb-1 block text-[11px] font-bold text-slate-500">الطبيب المكلّف بهذا العمل</span>
                <select aria-label="الطبيب المكلّف بالبند" data-testid={`invoice-provider-${index}`} value={row.doctorId}
                  onChange={(event) => setRows((current) => current.map((item) => item.key === row.key
                    ? { ...item, doctorId: event.target.value } : item))}
                  className="w-full rounded-xl border border-slate-200 bg-white px-2.5 py-2 text-xs">
                  <option value="">غير محدد — يحتاج مراجعة مالية</option>
                  {doctors.map((doctor) => <option key={doctor.id} value={doctor.id}>{doctor.name}</option>)}
                </select>
                {!doctorCatalog ? <span className="mt-1 block text-[10px] text-slate-500">قائمة الأطباء لم تُتحقق بعد؛ لا يُعيّن طبيب تلقائيًا.</span> : null}
              </label>
            ) : null}
            {toothControl(row, index)}
          </div>
          {inputProblems[index] ? <p role="alert" data-testid={`invoice-input-problem-${index}`}
            className="text-[11px] font-bold text-rose-800">{inputProblems[index]}</p> : null}
          {toothProblems[index] ? (
            <p data-testid={`invoice-tooth-problem-${index}`} className="text-[11px] font-bold text-amber-800">
              {toothProblems[index]}
            </p>
          ) : null}
          {(() => {
            if (!isClinical(row.serviceId)) return null;
            if (inputProblems[index]) return <div role="status" data-testid={`invoice-clinical-preview-${index}`} data-preview-state="invalid"
              className="text-[11px] font-bold text-rose-800">صحّح بيانات البند قبل معاينة الربط السريري.</div>;
            const evidence = previewForRow(previewState, previewKey, row.key);
            const preview = evidence.line;
            if (!preview) return (
              <div role="status" data-testid={`invoice-clinical-preview-${index}`} data-preview-state={evidence.status}
                className="rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] font-bold text-amber-900">
                {evidence.status === "refused" ? evidence.message ?? "راجع بيانات الفاتورة قبل الحفظ."
                  : evidence.status === "pending" ? "جارٍ التحقق من الربط السريري لهذا البند…"
                  : "تعذّر التحقق من الربط السريري. أعد المحاولة قبل حفظ الفاتورة."}
                {evidence.status === "unavailable" ? <button type="button" onClick={() => setPreviewRetry((value) => value + 1)}
                  className="ms-2 underline">إعادة المعاينة</button> : null}
              </div>
            );
            const caseText = !preview.case ? null
              : preview.case.mode === "existing" ? `سيتم الربط بالحالة الموجودة: ${preview.case.title ?? `#${preview.case.id}`}`
              : preview.case.mode === "new" ? "سيتم إنشاء حالة أولية تحتاج تقييم الطبيب"
              : preview.case.mode === "bridge" ? "سيتم الربط بحالة التقويم القائمة"
              : preview.case.mode === "choose" ? "للمريض أكثر من حالة مفتوحة لهذا التخصص — اختر الحالة"
              : null;
            return (
              <div role="status" data-testid={`invoice-clinical-preview-${index}`} data-preview-state={evidence.status}
                className={`rounded-lg border px-2.5 py-1.5 text-[11px] font-bold ${evidence.status === "refused" ? "border-rose-200 bg-rose-50 text-rose-800" : "border-sky-200 bg-sky-50 text-sky-900"}`}>
                {evidence.status === "ready" ? <p>هذه الفاتورة ستنشئ/تربط علاجًا سريريًّا للمريض — {preview.specialtyLabel}: {preview.item?.mode === "existing" ? (preview.item.id !== null ? `بند الخطة القائم #${preview.item.id}` : "بند خطة قائم لا يطابق هذا السطر") : "بند خطة جديد"}
                  {` · ${formatMoney(previewAmount(index), currency)}`}</p> : <p>لا يمكن حفظ هذا البند قبل معالجة سبب الرفض.</p>}
                {caseText && (evidence.status === "ready" || preview.case?.mode === "choose") ? <p>{caseText}</p> : null}
                {preview.case?.mode === "choose" || (preview.case?.options.length ?? 0) > 1 ? (
                  <select value={row.caseId} aria-label="الحالة"
                    onChange={(event) => setRows((current) => current.map((item, i) => i === index ? { ...item, caseId: event.target.value } : item))}
                    className="mt-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs">
                    <option value="">— اختر الحالة —</option>
                    {preview.case?.options.map((option) => <option key={option.id} value={option.id}>{option.title}</option>)}
                  </select>
                ) : null}
                {preview.refusalMessage ? <p>{preview.refusalMessage}</p> : null}
                {evidence.status === "ready" && (preview.financialReviewRequired || !row.doctorId) ? <p data-testid={`invoice-provider-review-${index}`}
                  className="mt-1 text-amber-900">نسبة هذا الالتزام للطبيب غير محسومة؛ تُحفظ الفاتورة، وتبقى المراجعة المالية مطلوبة قبل التوقيع.</p> : null}
              </div>
            );
          })()}
        </div>
      ))}

      <button type="button"
        onClick={() => setRows((current) => [...current, blankInvoiceRow(nextRowKey())])}
        className="mb-3 rounded-xl border border-slate-300 px-3 py-1.5 text-xs font-bold text-slate-600">
        + بند آخر
      </button>

      <div className="mb-3 flex flex-wrap items-end gap-2">
        <label className="w-32">
          <span className="mb-1 block text-[11px] font-bold text-slate-500">خصم</span>
          <input value={discount} onChange={(event) => setDiscount(event.target.value)}
            inputMode="decimal" dir="ltr" placeholder="0"
            className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" />
        </label>
        {discountMinor > 0 ? (
          <label className="min-w-[10rem] flex-1">
            <span className="mb-1 block text-[11px] font-bold text-slate-500">سبب الخصم</span>
            <input value={discountReason} onChange={(event) => setDiscountReason(event.target.value)}
              aria-label="سبب الخصم" maxLength={300} placeholder="مثل: مريض قديم"
              className="w-full rounded-xl border border-amber-200 bg-amber-50/50 px-3 py-2 text-sm" />
          </label>
        ) : null}
        <p className="flex-1 text-left text-sm font-extrabold">
          الإجمالي: {formatMoney(net, currency)}
          {discountMinor > 0 ? <span className="mr-2 text-[11px] font-normal text-slate-400">قبل الخصم {formatMoney(total, currency)}</span> : null}
        </p>
      </div>
      {/* الرقم المعتمد يُحسب على الخادم من البنود مهما أرسلت الواجهة؛ وهذا العرض
          يستعمل نفس دالة القراءة فيتطابق معه. */}

      {blockedLines.length > 0 ? (
        <p role="alert" data-testid="invoice-save-blocked"
          className="mb-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-900">
          لا يمكن حفظ الفاتورة قبل تحديد السن من مخطط الأسنان — {blockedLines.length === 1 ? `البند ${blockedLines[0]}` : `البنود ${blockedLines.join("، ")}`}.
        </p>
      ) : null}
      <button
        onClick={() => {
          if (busy || blockedLines.length > 0 || inputProblems.some(Boolean) || clinicalPreviewBlocked) return;
          onSubmit({
            currency,
            discount,
            discountReason,
            items: rows
              .filter((row) => row.serviceId || row.description.trim())
              .map((row) => ({
                serviceId: row.serviceId ? Number(row.serviceId) : undefined,
                doctorId: row.doctorId ? Number(row.doctorId) : undefined,
                description: row.description,
                price: row.price,
                priceReason: row.priceReason,
                quantity: Number(row.quantity) || 1,
                ...toothPayload(modeOf(row), row),
                caseId: isClinical(row.serviceId) && row.caseId ? Number(row.caseId) : undefined,
              })),
            idempotencyKey,
          });
        }}
        disabled={busy || blockedLines.length > 0 || inputProblems.some(Boolean) || clinicalPreviewBlocked || !rows.some((row) => row.serviceId || row.description.trim())}
        className="w-full rounded-xl bg-navy-800 py-2.5 text-sm font-extrabold text-white disabled:opacity-50"
      >
        احفظ الفاتورة
      </button>
      {dialogRow ? (
        <ToothSelectionDialog
          key={`${patientId}:${dialogRow.key}:${dialogRow.serviceId}:${modeOf(dialogRow)}`}
          patientId={patientId}
          mode={modeOf(dialogRow)}
          serviceName={serviceOf(dialogRow.serviceId)?.name ?? dialogRow.description}
          initial={selectionOfRow(dialogRow)}
          onConfirm={(selection) => confirmTeeth(dialogRow.key, dialogRow.serviceId, modeOf(dialogRow), selection)}
          onCancel={() => setToothDialogFor(null)}
        />
      ) : null}
    </section>
  );
}

/**
 * الرصيد الافتتاحي: ما كان على المريض قبل تشغيل النظام.
 *
 * شاشة صغيرة عمدًا وللمدير وحده — تُستعمل أيام إدخال البيانات القديمة ثم لا تكاد
 * تُفتح. والتاريخ حقلٌ لأنه هو ما يُؤرّخ به القيد وعمر الدَّين: «الأول من الشهر»
 * ليس كـ«قبل سنتين» في قائمة المتأخرين.
 */
function OpeningForm({ base, busy, canEdit, openings, onSubmit, onClear }: {
  base: Currency;
  busy: boolean;
  /** (DAY1) المدير يعدّل ويحذف؛ غيره يضيف لعملةٍ بلا رصيد فقط. */
  canEdit: boolean;
  /** (P1-5ب) الأرصدة القائمة بعملاتها — صفٌّ لكل عملة. */
  openings: OpeningBalance[];
  onSubmit: (body: Record<string, unknown>) => void;
  onClear: (reason: string, currency: Currency) => void;
}) {
  /* (P1-5ب) الرصيد بعملته — قرار المالك: السعودي يبقى سعوديًا والدولار دولارًا. */
  const [currency, setCurrency] = useState<Currency>(openings[0]?.currency ?? base);
  const existing = openings.find((opening) => (opening.currency ?? base) === currency) ?? null;
  const [amount, setAmount] = useState(
    existing ? formatAmount(existing.amountMinor, currency) : "",
  );
  const [asOfDate, setAsOfDate] = useState(existing?.asOfDate ?? "");
  const [note, setNote] = useState(existing?.note ?? "");
  const chooseCurrency = (next: Currency) => {
    setCurrency(next);
    const found = openings.find((opening) => (opening.currency ?? base) === next) ?? null;
    setAmount(found ? formatAmount(found.amountMinor, next) : "");
    setAsOfDate(found?.asOfDate ?? "");
    setNote(found?.note ?? "");
  };
  /* (P2-5) تعديل رصيدٍ قائم أو حذفه يحتاج سببًا يُحفظ في سجلّه. */
  const [reason, setReason] = useState("");

  return (
    <section className="mb-4 rounded-2xl border border-slate-300 bg-white p-4" aria-label="رصيد افتتاحي">
      <h3 className="mb-1 text-sm font-bold">الرصيد السابق المتبقي</h3>
      <div className="mb-3"><OpeningBalanceGuidance /></div>
      {existing ? (
        <p role="note" className="mb-3 text-[11px] font-semibold leading-5 text-slate-600">
          عند التصحيح، راجع مبلغ البداية فقط. الدفعات المسجّلة داخل البرنامج تُخصم تلقائيًا؛ لا تطرحها مرة أخرى من الرصيد السابق.
        </p>
      ) : null}

      <div className="mb-3 flex flex-wrap gap-2">
        <select value={currency} onChange={(event) => chooseCurrency(event.target.value as Currency)}
          aria-label="عملة الرصيد"
          className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-bold">
          {CURRENCIES.map((option) => (
            <option key={option} value={option}>{CURRENCY_LABEL[option]}</option>
          ))}
        </select>
        <input value={amount} onChange={(event) => setAmount(event.target.value)}
          placeholder={`المتبقي فقط (${CURRENCY_LABEL[currency]})`} aria-label="المبلغ"
          inputMode="decimal" dir="ltr" autoFocus
          className="min-w-[8rem] flex-1 rounded-xl border border-slate-200 px-3 py-2.5 text-base font-bold outline-none focus:border-brand-blue" />
        <input type="date" value={asOfDate} onChange={(event) => setAsOfDate(event.target.value)}
          aria-label="تاريخ الرصيد"
          className="w-44 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm" />
      </div>

      <input value={note} onChange={(event) => setNote(event.target.value)}
        placeholder="ملاحظة (اختياري) — مثل: متبقٍ من تقويم بدأ 2024" aria-label="ملاحظة"
        className="mb-3 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand-blue" />

      {existing && !canEdit ? (
        <p className="mb-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-bold text-slate-600">
          للمريض رصيدٌ سابق بهذه العملة ({formatAmount(existing.amountMinor, currency)}) — تعديله أو حذفه للمدير.
          اختر عملة أخرى لإضافة رصيدٍ بها.
        </p>
      ) : null}
      {existing && canEdit ? (
        <input value={reason} onChange={(event) => setReason(event.target.value)}
          placeholder="سبب التعديل أو الحذف (مطلوب) — يُحفظ في سجل الرصيد"
          aria-label="سبب التعديل"
          className="mb-3 w-full rounded-xl border border-warning-300 bg-warning-50 px-3 py-2 text-sm outline-none focus:border-brand-blue" />
      ) : null}

      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => onSubmit({ amount, currency, asOfDate: asOfDate || undefined, note: note.trim() || undefined, reason: reason.trim() || undefined })}
          disabled={busy || !amount.trim() || (existing !== null && (!canEdit || reason.trim().length < 3))}
          className="flex-1 rounded-xl bg-navy-800 py-2.5 text-sm font-extrabold text-white disabled:opacity-50"
        >
          احفظ الرصيد الافتتاحي
        </button>
        {existing && canEdit ? (
          <button onClick={() => onClear(reason.trim(), currency)} disabled={busy || reason.trim().length < 3}
            className="rounded-xl border border-red-300 bg-red-50 px-4 py-2.5 text-sm font-bold text-red-700 disabled:opacity-50">
            احذفه
          </button>
        ) : null}
      </div>
    </section>
  );
}
