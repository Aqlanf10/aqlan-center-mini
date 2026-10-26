"use client";

import { invoiceOfferedPrice, INVOICE_ZERO_CONVERSION_MESSAGE } from "@/lib/invoice-price-quote";

import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {Calculator, FileText, Link2, Plus, Save, Trash2} from "lucide-react";
import { CURRENCIES, CURRENCY_LABEL, CLINIC_BASE_CURRENCY, balanceText, formatAmount, formatMoney, invoiceNet, isCurrency, parseAmount, type Balance, type Currency } from "@/lib/money";
import { useSession } from "./SessionProvider";
import { OpeningCorrectionPreview } from "./OpeningCorrectionPreview";
import { canHandleMoney, isAdmin } from "@/lib/roles";
import { friendlyDateLong } from "@/lib/reminders";
import { PLAN_STATUS_LABEL } from "@/lib/plans";
import { ServiceSelect } from "./ServiceSelect";
import { CollectPaymentModal } from "./CollectPaymentModal";
import { InvoiceCorrection } from "./InvoiceCorrection";
import { restoreInvoiceRevision, type InvoiceRevisionCommand } from "@/lib/invoice-revision-view";
import { ReceiptCorrection, ReceiptCorrectionTrigger } from "./ReceiptCorrection";
import { ReceiptProvenance } from "./ReceiptProvenance";
import { receiptProvenanceFor } from "@/lib/receipt-provenance";
import { LegacyBalanceArrangementPanel, type LegacyArrangementView, type LegacyOpeningPosition } from "./LegacyBalanceArrangementPanel";
import { OpeningBalanceGuidance } from "./LegacyMoneyGuidance";
import { LegacyReconciliationPreview } from "./LegacyReconciliationPreview";
import { AccountSecondaryActions } from "./AccountSecondaryActions";
import { readInvoiceCommandReceipt, type InvoiceTemplateReceiptExpectation, type InvoiceTemplateReceiptExpectedLine } from "@/lib/invoice-template-receipt";
import { readInvoiceCommandResponse } from "@/lib/invoice-command-transport";
import { canLeaveTreatmentEntry } from "@/lib/treatment-entry-navigation";
import { invoiceCommandForOwner, invoiceCommandHasTemplate, invoiceCommandOutcome, retainInvoiceCommand, type InvoiceCommandLease, type InvoiceCommandOutcome } from "@/lib/invoice-command-recovery";
import { InvoiceTemplatePicker, type InvoiceTemplateDraft } from "./InvoiceTemplatePicker";
import type { InvoiceTemplatePreview } from "@/lib/invoice-template";
import { readInvoiceTemplatePreview, type InvoiceTemplatePreviewRow } from "./dental/invoice-template-preview";
import { TreatmentEntryChoice } from "./TreatmentEntryChoice";
import { HistoricalDocuments } from "./HistoricalDocuments";
import {MoneyCommandRecovery} from "./MoneyCommandRecovery";
import {MONEY_JOURNAL_EVENT} from "./useDurableMoneyAttempt";
import {restoreMoneyCommand,type DurableMoneyCommand} from "@/lib/durable-money-command";
import { HistoricalCorrection } from "./HistoricalCorrection";
import {restoreHistoricalCorrection,type HistoricalCorrectionCommand,type HistoricalDocumentView} from "@/lib/historical-correction-view";
import { parseHistoricalDocument } from "@/lib/legacy-treatment-document";
import { readHistoricalPreview, readHistoricalReceipt, type HistoricalPreview, type HistoricalReceiptExpectation } from "@/lib/historical-document-receipt";
import { LegacyTreatmentAgreements } from "./LegacyTreatmentAgreements";
import { DebtRepaymentEditor, readDebtRepaymentDraft, type DebtRepaymentDraft } from "./DebtRepaymentEditor";
import { DebtRepaymentPanel, restoreDebtCommand, type DebtRepaymentCommand } from "./DebtRepaymentPanel";
import { readFinancialJournal, reserveFinancialCommand, acknowledgeFinancialCommand, FinancialRecoveryError, type FinancialCommand, type FinancialRecoveryControl } from "@/lib/financial-command-journal";
import { clinicDateString } from "@/lib/schedule";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";
import { SITE_SCOPE_LABEL, allowedScopes, lineLinkage, invoiceQuantityAllowed, validateLineSite, type ToothScopeMode } from "@/lib/invoice-clinical-linkage";
import { ToothSelectionDialog } from "./dental/ToothSelectionDialog";
import { invoiceLineInputProblem, previewForRow } from "./dental/invoice-preview-state";
import {
  readInvoiceSelectionPreview, selectInvoiceItem, selectInvoicePlan, selectionForOwner,
  type InvoiceSelection, type InvoiceSelectionPreviewState,
} from "./dental/invoice-selection-state";
import {
  applyHistoricalToothSelection, emptyToothFields, invoiceToothMode,
  selectionLabel, selectionOfRow, setRowScope, toothPayload, toothProblem, usesToothChart,
  type ToothRowLike, type ToothSelection,
} from "./dental/invoice-tooth-selection";
import { selectManualLine } from "./invoice-manual-line";
import {
  applyGroupedToothSelection, buildInvoiceDisplayGroups, patchDisplayGroupRows, removeDisplayGroupRows,
  replaceDisplayGroupService, selectionOfDisplayGroup, splitDisplayGroupRow,
  type InvoiceDisplayGroup,
} from "./dental/invoice-display-groups";
import { newIdempotencyKey } from "@/lib/idempotency-key";
import { invoiceCatalogPrice, type InvoiceCatalogService } from "@/lib/invoice-catalog-price";
import workspace from "./InvoiceWorkspace.module.css";

/**
 * حساب المريض: الرصيد والفواتير والدفعات، وإنشاء فاتورة وقبض دفعة.
 *
 * الرصيد فوق كل شيء لأنه السؤال الذي يُسأل على الباب. وتحته سببه — الفواتير
 * والدفعات — لأن رقمًا بلا تفصيل يُجادَل عليه ولا يُثبَت.
 */

interface Service extends InvoiceCatalogService { id: number; name: string; category: string | null; priceMinor: number; priceProvisional?: boolean }
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
  currentAgreement?: { totalMinor: number; paidMinor: number; remainingMinor: number };
  agreementReviewRequired?: boolean;
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
  /** Display evidence is validated independently and never controls collection. */
  receiptProvenance?: unknown;
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

type InvoiceSubmission = { lease: InvoiceCommandLease; expected: InvoiceTemplateReceiptExpectation | HistoricalReceiptExpectation; netMinor: number };
type InvoiceCommandState = { submission: InvoiceSubmission; original: InvoiceSubmission; outcome: InvoiceCommandOutcome | "pending"; editing: boolean };
const isHistoricalRecovery = (value: InvoiceCommandState | null) => !!value && "kind" in value.original.expected && value.original.expected.kind === "historical";
type RetainedInvoiceRecovery = { patientId: number; principal: string; command: InvoiceCommandState };
const durableJson = (value: unknown) => JSON.stringify(value, (key, item) => key === "owner" ? undefined : item);
function durableInvoiceCommand(state: InvoiceCommandState): FinancialCommand {
  const body = JSON.parse(state.original.lease.serialized) as Record<string, unknown>;
  if (typeof body.idempotencyKey !== "string") throw new FinancialRecoveryError("invalid");
  return { kind: "invoice", key: body.idempotencyKey, original: durableJson(state.original), payload: durableJson(state) };
}
function restoreInvoiceCommand(command: FinancialCommand, patientId: number): InvoiceCommandState {
  const value: unknown = JSON.parse(command.payload);
  if (!record(value) || !record(value.original) || !record(value.submission)) throw new FinancialRecoveryError("invalid");
  const owner = {};
  for (const one of [value.original, value.submission]) {
    if (!record(one.lease) || typeof one.lease.serialized !== "string" || !record(one.expected)
      || one.expected.patientId !== patientId || !isCurrency(one.expected.currency) || !nonnegativeMinor(one.netMinor)) throw new FinancialRecoveryError("invalid");
    const body: unknown = JSON.parse(one.lease.serialized);
    if (!record(body) || body.idempotencyKey !== command.key || body.patientId !== undefined && body.patientId !== patientId) throw new FinancialRecoveryError("invalid");
    if (one.expected.kind === "historical") {
      if (!record(one.expected.input) || !record(one.expected.preview) || !Array.isArray(one.expected.input.lines)
        || !Array.isArray(one.expected.preview.lines) || one.expected.input.lines.length !== one.expected.preview.lines.length) throw new FinancialRecoveryError("invalid");
    } else if (!Array.isArray(one.expected.lines)||body.visitId!==one.expected.visitId) throw new FinancialRecoveryError("invalid");
    one.lease.owner = owner; one.expected.owner = owner;
  }
  if (durableJson(value.original) !== command.original) throw new FinancialRecoveryError("invalid");
  return { ...(value as unknown as InvoiceCommandState), outcome: "uncertain", editing: false };
}

interface PatientLedgerProps {
  patientId: number;
  /** Trusted calling visit context; independent entry leaves this undefined. */
  visitId?:number;
  selectionContextKey?: string;
  onClinicalChange?: () => void;
  entryRequestKey?: number;
  onEntryRequestConsumed?: (key: number) => void;
  onNavigationGuardChange?: (guard: () => boolean) => () => void;
  accountDetails?: ReactNode;
}

export function PatientLedger({ patientId, visitId, selectionContextKey = "", onClinicalChange, entryRequestKey = 0, onEntryRequestConsumed, onNavigationGuardChange, accountDetails }: PatientLedgerProps) {
  const session = useSession();
  // A fresh patient/principal/permission owner cannot reuse another owner's read.
  const scope = JSON.stringify([patientId, session, visitId??null]);
  const principal = JSON.stringify([session?.username, session?.role]);
  const [recoveries, setRecoveries] = useState<ReadonlyMap<string, RetainedInvoiceRecovery>>(() => new Map());
  const [debtRecoveries,setDebtRecoveries]=useState<ReadonlyMap<string,DebtRepaymentCommand>>(()=>new Map());
  const [revisionRecoveries,setRevisionRecoveries]=useState<ReadonlyMap<string,InvoiceRevisionCommand>>(()=>new Map());
  const [historicalRecoveries,setHistoricalRecoveries]=useState<ReadonlyMap<string,HistoricalCorrectionCommand>>(()=>new Map());
  const [moneyRecoveries,setMoneyRecoveries]=useState<ReadonlyMap<string,DurableMoneyCommand>>(()=>new Map());
  const recoveryKey = JSON.stringify([patientId, principal]);
  const recoveryOwner = useMemo(() => ({ scope }), [scope]);
  const recoveryLifetime = useRef<{ owner: object | null; active: boolean }>({ owner: null, active: false });
  const [journal, setJournal] = useState<{ scope: string; revision: number; error: string | null } | null>(null);
  const [restoredCommandKey, setRestoredCommandKey] = useState("");
  useLayoutEffect(() => {
    recoveryLifetime.current = { owner: recoveryOwner, active: true };
    return () => { if (recoveryLifetime.current.owner === recoveryOwner) recoveryLifetime.current.active = false; };
  }, [recoveryOwner]);
  const adoptDurable = useCallback((command: FinancialCommand | null) => {
    if (recoveryLifetime.current.owner !== recoveryOwner || !recoveryLifetime.current.active) return;
    const invoice = command?.kind === "invoice" ? restoreInvoiceCommand(command, patientId) : null;
    const debt = command?.kind === "debt" ? restoreDebtCommand(command, patientId, session?.username ?? "") : null;
    const revision = command?.kind === "invoice-correction" ? restoreInvoiceRevision(command,patientId,session?.username??"") : null;
    const historical=command?.kind==="historical-correction"?restoreHistoricalCorrection(command,patientId,session?.username??""):null;
    const money=command&&(command.kind==="collection"||command.kind==="receipt-correction")?restoreMoneyCommand(command,patientId,session?.username??""):null;
    if (command && !invoice && !debt && !revision && !historical && !money) throw new FinancialRecoveryError("invalid");
    setRecoveries(current => { const next = new Map(current); if (invoice) next.set(recoveryKey, { patientId, principal, command: invoice }); else next.delete(recoveryKey); return next; });
    setDebtRecoveries(current => { const next = new Map(current); if (debt) next.set(recoveryKey, debt); else next.delete(recoveryKey); return next; });
    setRevisionRecoveries(current=>{const next=new Map(current);if(revision)next.set(recoveryKey,revision);else next.delete(recoveryKey);return next;});
    setHistoricalRecoveries(current=>{const next=new Map(current);if(historical)next.set(recoveryKey,historical);else next.delete(recoveryKey);return next;});
    setMoneyRecoveries(current=>{const next=new Map(current);if(money)next.set(recoveryKey,money);else next.delete(recoveryKey);return next;});
    setRestoredCommandKey(invoice ? command!.key : "");
  }, [patientId, principal, recoveryKey, recoveryOwner, session?.username, setRecoveries, setDebtRecoveries,setRevisionRecoveries,setHistoricalRecoveries,setMoneyRecoveries]);
  useEffect(() => {
    if (!session?.username) return;
    let active = true,generation=0;
    const read=()=>{const request=++generation;void readFinancialJournal({ actor: session.username, patientId }).then(saved => {
      if (!active||request!==generation) return;
      adoptDurable(saved.command); setJournal({ scope, revision: saved.revision, error: null });
    }).catch(() => { if (active&&request===generation) setJournal({ scope, revision: 0, error: new FinancialRecoveryError("unavailable").message }); });};
    read();window.addEventListener(MONEY_JOURNAL_EVENT,read);
    return () => { active = false;window.removeEventListener(MONEY_JOURNAL_EVENT,read); };
  }, [scope, patientId, session?.username, adoptDurable]);
  const financialRecovery: FinancialRecoveryControl = {
    ready: journal?.scope === scope && !journal.error,
    revision: journal?.scope === scope ? journal.revision : 0,
    error: journal?.scope === scope ? journal.error : null,
    reserve: async (command, revision) => {
      if (!session || journal?.scope !== scope || journal.error || recoveryLifetime.current.owner !== recoveryOwner || !recoveryLifetime.current.active) return false;
      try {
        const saved = await reserveFinancialCommand({ actor: session.username, patientId }, revision, command);
        if (recoveryLifetime.current.owner !== recoveryOwner || !recoveryLifetime.current.active) return false;
        if (saved.command?.key !== command.key || saved.command.kind !== command.kind || saved.command.original !== command.original) {
          adoptDurable(saved.command);setJournal({scope,revision:saved.revision,error:null});return false;
        }
        return true;
      } catch (error) {
        if (recoveryLifetime.current.owner === recoveryOwner && recoveryLifetime.current.active) setJournal({ scope, revision, error: error instanceof FinancialRecoveryError ? error.message : new FinancialRecoveryError("unavailable").message });
        return false;
      }
    },
    acknowledge: async command => {
      if (!session) throw new FinancialRecoveryError("unavailable");
      const saved = await acknowledgeFinancialCommand({ actor: session.username, patientId }, command);
      if (recoveryLifetime.current.owner === recoveryOwner && recoveryLifetime.current.active) setJournal({ scope, revision: saved.revision, error: null });
    },
  };
  const recovery = recoveries.get(recoveryKey) ?? null;
  if (!session) return <p role="status" className="p-4 text-sm text-slate-500">غير مصرّح لك بعرض حساب المريض.</p>;
  return <PatientLedgerContent key={scope} patientId={patientId} visitId={visitId} selectionContextKey={selectionContextKey} onClinicalChange={onClinicalChange} entryRequestKey={entryRequestKey} onEntryRequestConsumed={onEntryRequestConsumed} onNavigationGuardChange={onNavigationGuardChange}
    accountDetails={accountDetails} financialRecovery={financialRecovery} restoredCommandKey={restoredCommandKey}
    debtRecovery={debtRecoveries.get(recoveryKey)??null}
    moneyRecovery={moneyRecoveries.get(recoveryKey)??null} onMoneyRecoveryChange={command=>{
      if(recoveryLifetime.current.owner!==recoveryOwner||!recoveryLifetime.current.active)return;
      setMoneyRecoveries(current=>{const next=new Map(current);if(command)next.set(recoveryKey,command);else next.delete(recoveryKey);return next;});
    }}
    historicalRecovery={historicalRecoveries.get(recoveryKey)??null}
    onHistoricalRecoveryChange={command=>{
      if(recoveryLifetime.current.owner!==recoveryOwner||!recoveryLifetime.current.active)return;
      setHistoricalRecoveries(current=>{const next=new Map(current);if(command)next.set(recoveryKey,command);else next.delete(recoveryKey);return next;});
    }}
    revisionRecovery={revisionRecoveries.get(recoveryKey)??null}
    onRevisionRecoveryChange={command=>{
      if(recoveryLifetime.current.owner!==recoveryOwner||!recoveryLifetime.current.active)return;
      setRevisionRecoveries(current=>{const next=new Map(current);if(command)next.set(recoveryKey,command);else next.delete(recoveryKey);return next;});
    }}
    onDebtRecoveryChange={command=>{
      if(recoveryLifetime.current.owner!==recoveryOwner||!recoveryLifetime.current.active)return;
      setDebtRecoveries(current=>{const next=new Map(current);if(command)next.set(recoveryKey,command);else next.delete(recoveryKey);return next;});
    }}
    recovery={recovery?.patientId === patientId && recovery.principal === principal ? recovery.command : null}
    onRecoveryChange={command => {
      if (recoveryLifetime.current.owner !== recoveryOwner || !recoveryLifetime.current.active) return;
      setRecoveries(current => { const next = new Map(current); if (command) next.set(recoveryKey, { patientId, principal, command }); else next.delete(recoveryKey); return next; });
    }} />;
}

function PatientLedgerContent({ patientId, visitId, selectionContextKey = "", onClinicalChange, entryRequestKey = 0, onEntryRequestConsumed, onNavigationGuardChange, recovery, onRecoveryChange, debtRecovery,onDebtRecoveryChange,revisionRecovery,onRevisionRecoveryChange,historicalRecovery,onHistoricalRecoveryChange,moneyRecovery,onMoneyRecoveryChange,accountDetails,financialRecovery,restoredCommandKey }: PatientLedgerProps & { recovery: InvoiceCommandState | null; onRecoveryChange: (command: InvoiceCommandState | null) => void;debtRecovery:DebtRepaymentCommand|null;onDebtRecoveryChange:(command:DebtRepaymentCommand|null)=>void;financialRecovery:FinancialRecoveryControl;restoredCommandKey:string;moneyRecovery:DurableMoneyCommand|null;onMoneyRecoveryChange:(command:DurableMoneyCommand|null)=>void;historicalRecovery:HistoricalCorrectionCommand|null;onHistoricalRecoveryChange:(command:HistoricalCorrectionCommand|null)=>void;revisionRecovery:InvoiceRevisionCommand|null;onRevisionRecoveryChange:(command:InvoiceRevisionCommand|null)=>void }) {
  // (TD-05) الأساس دستوري من الكود.
  const fallbackBase: Currency = CLINIC_BASE_CURRENCY;

  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [services, setServices] = useState<Service[]>([]);
  const [linkNotice, setLinkNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"none" | "entry" | "invoice" | "opening" | "legacy">("none");
  /* (INV-LEGACY) إعادة قراءة لوحة الاتفاقات التاريخية بعد التسجيل. */
  const [legacyRefresh, setLegacyRefresh] = useState(0);
  /* القبض من المكوّن الموحّد — نفس المكون ونفس الواجهة البرمجية من كل الأبواب (AC-09). */
  const [collectOpen, setCollectOpen] = useState(false);
  const [lastReceiptId, setLastReceiptId] = useState<number | null>(null);
  const session = useSession();
  const admin = isAdmin(session?.role);
  /* (FIN-2) الفاتورة المفتوحة للتصحيح الآن، ورسالة نجاح التصحيح. */
  const [historicalCorrecting,setHistoricalCorrecting]=useState<HistoricalDocumentView|null>(null);
  const [correcting, setCorrecting] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /* (RC-1) سند القبض المفتوح للتصحيح الآن. */
  const [correctingReceipt, setCorrectingReceipt] = useState<number | null>(null);

  const base = ledger?.baseCurrency ?? fallbackBase;
  /* (DAY1 — قرار المالك) الاستقبال يضيف الرصيد السابق، والتعديل والحذف للمدير. */
  const canAddOpening = ledger?.openingAccess?.add ?? admin;
  const canEditOpening = ledger?.openingAccess?.edit ?? admin;
  const canAddLegacy = !loading && !error && ledger?.openingAccess?.add === true;
  const canStartTreatment = financialRecovery.ready && !moneyRecovery && !historicalRecovery && !historicalCorrecting && !revisionRecovery && correcting===null && !loading && !error && !!session && canHandleMoney(session.role);
  const readRef = useRef({ active: false, authorized: false, generation: 0, controller: null as AbortController | null });
  const writePending = useRef(false);
  const invoiceUnresolved = useRef(false);
  const debtHeld=useRef(false);
  const holdDebt=useCallback((held:boolean)=>{debtHeld.current=held;},[]);
  const consumedEntryRequest = useRef(0);
  const hasEntryDraft = mode === "invoice" || mode === "legacy" || mode === "opening";
  const financialBlocked = !financialRecovery.ready || !!recovery || !!debtRecovery || !!revisionRecovery || correcting!==null || !!historicalRecovery || !!historicalCorrecting || !!moneyRecovery;
  const shownRestoredKey=useRef("");
  useEffect(() => {
    if (recovery && restoredCommandKey && shownRestoredKey.current !== restoredCommandKey) {
      shownRestoredKey.current=restoredCommandKey;setMode(isHistoricalRecovery(recovery) ? "legacy" : "invoice");
    }
  }, [recovery, restoredCommandKey]);
  const canLeave = useCallback(() => {
    return canLeaveTreatmentEntry({ active: readRef.current.active, pending: !!moneyRecovery || !!historicalRecovery || !!revisionRecovery || debtHeld.current || !!debtRecovery&&debtRecovery.outcome!=="refused" || writePending.current || invoiceUnresolved.current || !!recovery && !recovery.editing || busy, hasDraft: hasEntryDraft || correcting!==null || !!historicalCorrecting },
      () => window.confirm("هناك مسودة فاتورة أو اتفاق غير محفوظة. مغادرة الشاشة لا تلغي طلبًا سبق إرساله. هل تريد المغادرة؟"));
  }, [busy, hasEntryDraft, recovery,debtRecovery,revisionRecovery,correcting,historicalRecovery,historicalCorrecting,moneyRecovery]);
  useLayoutEffect(() => onNavigationGuardChange?.(canLeave), [canLeave, onNavigationGuardChange]);
  useEffect(() => {
    if (entryRequestKey <= consumedEntryRequest.current || revisionRecovery || correcting!==null || historicalRecovery || historicalCorrecting || moneyRecovery) return;
    consumedEntryRequest.current = entryRequestKey;
    setLinkNotice(null); setNotice(null);
    setMode(recovery ? isHistoricalRecovery(recovery) ? "legacy" : "invoice" : "entry");
    onEntryRequestConsumed?.(entryRequestKey);
  }, [entryRequestKey, onEntryRequestConsumed, recovery,revisionRecovery,correcting,historicalRecovery,historicalCorrecting,moneyRecovery]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!moneyRecovery&&!historicalRecovery&&!historicalCorrecting&&!revisionRecovery&&correcting===null&&!debtHeld.current&&!debtRecovery&&!writePending.current && !invoiceUnresolved.current && !recovery && !hasEntryDraft) return;
      event.preventDefault(); event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [hasEntryDraft, recovery,debtRecovery,revisionRecovery,correcting,historicalRecovery,historicalCorrecting,moneyRecovery]);
  const changeMode = (next: typeof mode) => {
    if (!readRef.current.active || moneyRecovery || historicalRecovery || historicalCorrecting || revisionRecovery || correcting!==null || debtHeld.current || writePending.current || invoiceUnresolved.current || busy || (next !== "none" && (loading || error))) return;
    if (next === mode) return;
    if (hasEntryDraft && !canLeave()) return;
    // A newly admitted draft may stop at preview refusal without ever sending a write.
    if (next !== "none") { setLinkNotice(null); setNotice(null); }
    setMode(next === "entry" && recovery ? isHistoricalRecovery(recovery) ? "legacy" : "invoice" : next);
  };

  const load = useCallback(async () => {
    const lifetime = readRef.current;
    if (!lifetime.active) return;
    const generation = ++lifetime.generation;
    lifetime.controller?.abort();
    const controller = new AbortController(); lifetime.controller = controller;
    const current = () => lifetime.active && lifetime.generation === generation && !controller.signal.aborted;
    lifetime.authorized = false; setLoading(true);
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
      lifetime.authorized = true; setLedger(payload);
      setError(null);
    } catch (loadError) {
      if (!current()) return;
      setError(loadError instanceof Error ? loadError.message : "تعذّر التحميل.");
    } finally {
      if (current()) setLoading(false);
    }
  }, [patientId]);

  const notifyFinancialChange = useCallback(() => {
    if (readRef.current.active) onClinicalChange?.();
  }, [onClinicalChange]);

  useEffect(() => {
    const lifetime = readRef.current; lifetime.active = true;
    void load();
    return () => { lifetime.active = false; lifetime.generation++; lifetime.controller?.abort(); };
  }, [load]);

  const send = useCallback(async (run: (signal?: AbortSignal) => Promise<Response>, inspect?: (response: Response, payload: unknown) => boolean, boundedInvoice = false) => {
    if (writePending.current || busy || !financialRecovery.ready || !readRef.current.active || !readRef.current.authorized) return null;
    writePending.current = true;
    setBusy(true);
    // Success feedback belongs to the completed write, never to this new command.
    setLinkNotice(null); setNotice(null);
    const retireDenied = (response: Response) => {
      if (!readRef.current.active || response.status !== 401 && response.status !== 403) return;
      readRef.current.authorized = false; readRef.current.generation++; readRef.current.controller?.abort();
      setLedger(null); setServices([]); setCollectOpen(false); setCorrecting(null); setCorrectingReceipt(null);
      setError("انتهت صلاحية قراءة الحساب. أعد تسجيل الدخول ثم تحقّق من الحساب؛ الطلب غير المؤكد محفوظ في هذه الصفحة.");
    };
    try {
      const completed = boundedInvoice ? await readInvoiceCommandResponse(signal => run(signal), retireDenied)
        : await run().then(async response => { retireDenied(response); return { response, payload: await response.json().catch(() => null) }; });
      const { response, payload } = completed;
      const accepted = inspect?.(response, payload) ?? true;
      if (!response.ok) {
        setWriteError(record(payload) && typeof payload.message === "string" ? payload.message : "تعذّر التنفيذ."); return null;
      }
      if (!accepted) { setWriteError("لم يُتحقّق من نتيجة الفاتورة. احتُفظ بالطلب نفسه لإعادة التحقق."); return null; }
      setWriteError(null);
      // Opening writes notify after the accepted acknowledgement, before their
      // ledger GET can stall. Bounded invoice owners retain their own notification.
      if (!boundedInvoice) notifyFinancialChange();
      if (boundedInvoice) void load(); else await load();
      return payload;
    } catch {
      setWriteError("تعذّر الاتصال بالخادم.");
      return null;
    } finally {
      writePending.current = false;
      setBusy(false);
    }
  }, [busy, load, financialRecovery.ready, notifyFinancialChange]);

  if (loading && !ledger) {
    return <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">جارٍ التحميل…</p>;
  }
  if (!ledger && error) return <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
    <p role="alert" aria-label="خطأ حساب المريض">{error}</p>
    <button type="button" className="mt-2 min-h-11 rounded-lg border px-3" onClick={() => void load()}>إعادة التحقق من الحساب</button>
  </div>;

  return (
    <div>
      {error ? (
        <p role="alert" aria-label="خطأ حساب المريض" className="mb-3 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</p>
      ) : null}
      {writeError ? <p role="alert" aria-label="تعذّر حفظ إجراء الحساب" className="mb-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{writeError}</p> : null}
      {notice ? (
        <p role="status" className="mb-3 rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-2 text-sm font-bold text-emerald-800">{notice}</p>
      ) : null}

      {ledger && !loading && !error ? (
        /* (TD-05) رصيدٌ لكل عملة ذات نشاط: عملةٌ واحدة تُعرض كما كان دائمًا،
           وعملات اتفاقٍ متعددة تُعرض كلٌّ ببطاقتها الموسومة — لا رقمٌ واحد يمزجها. */
        activeBalances(ledger).map(({ currency, bucket }) => (
          <div key={currency} data-testid="account-canonical-balance" data-currency={currency} className={`mb-3 rounded-2xl border-2 p-4 text-center ${
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

      {ledger && (loading || error) ? <p role="status" data-testid="account-balance-unavailable" className="mb-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm">
        {loading ? "جارٍ التحقق من رصيد الحساب…" : "رصيد الحساب غير متاح حتى تنجح إعادة القراءة؛ لا يُعدّ ذلك رصيدًا صفريًا."}
      </p> : null}

      <div className="mb-3 flex flex-wrap gap-1.5">
        <button type="button" data-testid="treatment-entry-open" disabled={busy || (!canStartTreatment && mode === "none")}
          onClick={() => changeMode(mode === "none" || mode === "opening" ? "entry" : "none")}
          aria-expanded={mode === "entry" || mode === "invoice" || mode === "legacy"}
          className="min-h-11 rounded-xl bg-navy-800 px-4 py-2 text-xs font-bold text-white disabled:opacity-50">
          {mode === "entry" || mode === "invoice" || mode === "legacy" ? "إغلاق الفاتورة / الاتفاق" : "فاتورة / اتفاق علاج"}
        </button>
        <button disabled={financialBlocked} onClick={() => {if(!financialBlocked&&!debtHeld.current&&!invoiceUnresolved.current)setCollectOpen(true);}}
          className="rounded-xl bg-brand-orange px-4 py-2 text-xs font-bold text-white">
          قبض دفعة
        </button>
        <a href={`/print/statement/${patientId}`} target="_blank" rel="noopener"
          className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-bold text-navy-800">
          كشف حساب
        </a>
        {canAddOpening ? <AccountSecondaryActions>
          <p className="my-2 max-w-sm text-slate-500">الرصيد السابق دون علاج محدد فقط؛ العلاج السابق للنظام يُسجّل من الفاتورة / الاتفاق.</p>

          <button type="button" disabled={financialBlocked || busy || loading || !!error} onClick={() => changeMode(mode === "opening" ? "none" : "opening")}
            className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-bold text-navy-800">
            {mode === "opening" ? "إغلاق" : (ledger?.openings?.length ?? (ledger?.opening ? 1 : 0)) > 0
              ? (canEditOpening ? "تعديل الرصيد السابق" : "رصيد سابق") : "رصيد سابق (قبل النظام)"}
          </button>

        </AccountSecondaryActions> : null}
      </div>

      {financialRecovery.error ? <p role="alert" className="my-3 text-sm text-rose-800">{financialRecovery.error}</p> : null}

      {mode === "entry" ? <TreatmentEntryChoice canAddLegacy={canAddLegacy}
        disabled={!canStartTreatment || busy || !!recovery} onSelect={changeMode} /> : null}

      {mode === "invoice" ? (
        <InvoiceForm key={patientId}
          originControl={<TreatmentEntryChoice canAddLegacy={canAddLegacy} activeMode="invoice" disabled={!canStartTreatment || busy || !!recovery} onSelect={changeMode}/>}
          patientId={patientId} visitId={visitId} base={base} services={services} onReloadCatalogue={()=>void load()} busy={busy} selectionContextKey={selectionContextKey}
          financialRecovery={financialRecovery}
          canChangeDraft={() => financialRecovery.ready && !debtRecovery && readRef.current.active && readRef.current.authorized && !writePending.current}
          onRecoveryHold={value => { invoiceUnresolved.current = value; }}
          recovery={recovery} onRecoveryChange={onRecoveryChange}
          onSubmit={async (body, validateReceipt) => {
            // Every invoice uses its retained actor/patient command and complete acknowledgement.
            if (!validateReceipt) return "uncertain";
            let outcome: InvoiceCommandOutcome = "uncertain";
            const created = await send(signal => fetch("/api/invoices", {
              method: "POST", headers: { "Content-Type": "application/json" }, signal,
              body: JSON.stringify({ patientId, ...body }),
            }), (response, payload) => {
              outcome = invoiceCommandOutcome(response.status, payload, validateReceipt?.(payload) === true, response.redirected);
              return outcome === "saved";
            }, true) as { clinical?: { links: { kind: string; planItemCreated: boolean; caseCreated: boolean; caseId: number | null }[] } } | null;
            if (readRef.current.active && created) {
              onClinicalChange?.();
              setMode("none");
              /* (INV-LINK D) ما فعلته الفاتورة بالعلاج — يُقال صراحةً بعد الحفظ. */
              const clinical = created.clinical?.links.filter((link) => link.kind === "clinical") ?? [];
              setLinkNotice(clinical.length === 0 ? null
                : `رُبطت الفاتورة بالعلاج: ${clinical.length} بند خطة${clinical.some((l) => l.planItemCreated) ? " (منها جديد)" : ""}`
                  + `${clinical.some((l) => l.caseCreated) ? " — وفُتحت حالة أولية تحتاج تقييم الطبيب" : clinical.some((l) => l.caseId) ? " — مربوطة بحالتها القائمة" : ""}.`);
            }
            return outcome;
          }}
        />
      ) : null}

      {mode === "legacy" && canAddLegacy ? <InvoiceForm key={`historical-${patientId}`}
        originControl={<TreatmentEntryChoice canAddLegacy={canAddLegacy} activeMode="legacy" disabled={!canStartTreatment || busy || !!recovery} onSelect={changeMode}/>}
        historical patientId={patientId} base={base} services={services} onReloadCatalogue={()=>void load()} busy={busy} selectionContextKey={selectionContextKey}
        financialRecovery={financialRecovery}
        canChangeDraft={() => financialRecovery.ready && !debtRecovery && readRef.current.active && readRef.current.authorized && !writePending.current}
        recovery={recovery} onRecoveryHold={value=>{invoiceUnresolved.current=value;}} onRecoveryChange={onRecoveryChange}
        onSubmit={async(body,validateReceipt)=>{
          if(!validateReceipt)return "uncertain";
          let outcome:InvoiceCommandOutcome="uncertain";
          const saved=await send(signal=>fetch(`/api/patients/${patientId}/historical-documents`,{method:"POST",headers:{"Content-Type":"application/json"},signal,body:JSON.stringify(body)}),
            (response,payload)=>{outcome=invoiceCommandOutcome(response.status,payload,validateReceipt(payload),response.redirected);return outcome==="saved";},true);
          if(readRef.current.active&&saved){onClinicalChange?.();setMode("none");setLegacyRefresh(value=>value+1);
            setLinkNotice("حُفظ الاتفاق التاريخي وربطت بنوده بالخطة والحالات. المتبقي وحده أضيف إلى الرصيد السابق، دون فاتورة أو سند للمدفوع القديم.");}
          return outcome;
        }}/>:null}

      {ledger && !loading && !error ? (
        <LegacyReconciliationPreview patientId={patientId} ready
          positions={ledger.legacyOpeningPositions} payments={ledger.payments} />
      ) : null}

      {mode==="none"&&session&&canHandleMoney(session.role)?<DebtRepaymentPanel patientId={patientId} refreshKey={ledger}
        financialRecovery={financialRecovery}
        recovery={debtRecovery} onRecoveryChange={onDebtRecoveryChange} onHold={holdDebt}
        enabled={financialRecovery.ready&&!moneyRecovery&&!historicalRecovery&&!historicalCorrecting&&!recovery&&!revisionRecovery&&correcting===null&&!!ledger&&!loading&&!error&&!busy&&mode==="none"} onChanged={()=>{void load();onClinicalChange?.();}}/>:null}

      {mode==="none"&&ledger&&!loading&&!error?<HistoricalDocuments patientId={patientId} refreshKey={ledger} enabled={!financialBlocked&&!busy&&!collectOpen&&correctingReceipt===null} onCorrect={document=>{if(!financialBlocked){setHistoricalCorrecting(document);setNotice(null);}}} />:null}
      {moneyRecovery?<MoneyCommandRecovery command={moneyRecovery} onDone={(message,paymentId)=>{onMoneyRecoveryChange(null);setNotice(message);if(paymentId!==null)setLastReceiptId(paymentId);void load();notifyFinancialChange();}}/>:null}
      {admin&&(historicalRecovery||historicalCorrecting)?<HistoricalCorrection key={historicalRecovery?.documentId??historicalCorrecting!.id}
        original={historicalRecovery?.original??historicalCorrecting!} recovery={historicalRecovery} onRecoveryChange={onHistoricalRecoveryChange} financialRecovery={financialRecovery}
        onCancel={()=>setHistoricalCorrecting(null)} onDone={message=>{setHistoricalCorrecting(null);setNotice(message);void load();onClinicalChange?.();}}/>:null}

      {ledger ? (
        <LegacyBalanceArrangementPanel
          patientId={patientId}
          openingPositions={ledger.legacyOpeningPositions ?? []}
          arrangements={ledger.legacyBalanceArrangements ?? []}
          canManage={ledger.legacyArrangementAccess?.manage ?? false}
          onChanged={() => { void load(); }}
        />
      ) : null}

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

      {ledger && !loading && !error ? (
        <div id="saved-historical-agreements"><LegacyTreatmentAgreements patientId={patientId} refreshKey={legacyRefresh} onChanged={() => {
          if (!readRef.current.active) return; onClinicalChange?.(); void load();
        }} /></div>
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
          notifyFinancialChange();
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
          patientId={patientId} base={base} busy={busy} canEdit={canEditOpening}
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
      {ledger && !loading && !error && (ledger.plans.length > 0 || accountDetails) ? (
        <details className="mb-4 rounded-xl border border-slate-200 p-3" aria-label="تفاصيل العلاج والخطط" data-testid="account-treatment-details">
          <summary className="min-h-11 cursor-pointer text-sm font-bold">تفاصيل العلاج والخطط ({ledger.plans.length}) — ليست رصيد الحساب</summary>
          {accountDetails}
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
                    <p className="font-extrabold">{formatMoney(plan.currentAgreement?.totalMinor ?? plan.totalMinor, plan.baseCurrency ?? base)}</p>
                    <p className="text-[10px] text-slate-500">{plan.currentAgreement ? "إجمالي الاتفاق المالي الحالي" : plan.agreementReviewRequired ? "قيمة الخطة المسجلة؛ الرصيد الحالي غير متاح" : plan.legacy ? "قيمة الخطة المتضمنة للتاريخ (ليست دَينًا)" : "قيمة العمل المتفق عليه (ليست رصيد الحساب)"}</p>
                  </div>
                  {plan.currentAgreement || plan.installments ? (
                    <>
                      <div className="rounded-lg bg-emerald-50 px-1.5 py-1.5">
                        <p className="font-extrabold text-emerald-800">{formatMoney(plan.currentAgreement?.paidMinor ?? plan.installments!.paidMinor, plan.baseCurrency ?? base)}</p>
                        <p className="text-[10px] text-emerald-700">المسدّد</p>
                      </div>
                      <div className="rounded-lg bg-slate-50 px-1.5 py-1.5">
                        <p className="font-extrabold">{formatMoney(plan.currentAgreement?.remainingMinor ?? plan.installments!.remainingMinor, plan.baseCurrency ?? base)}</p>
                        <p className="text-[10px] text-slate-500">باقي الاتفاق (ليس المستحق الحالي)</p>
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
                  {plan.currentAgreement ? "التحصيل إيصال على الأصل المعتمد وفواتير فروق التعديل، دون إنشاء أصل الاتفاق مرة ثانية." : plan.agreementReviewRequired ? "الرصيد الحالي غير متاح؛ راجع مصدر الاتفاق قبل التحصيل." : plan.legacy
                    ? "متبقي الاتفاق التاريخي يُحصَّل من الرصيد السابق. البنود الأخرى تتبع فواتيرها المثبتة؛ لا تُحصَّل قيمة الخطة التاريخية كدفعة جديدة."
                    : plan.installments
                    ? "قبضُ القسط يُصدر فاتورة ودفعة تظهران في القائمتين أدناه."
                    : "تتبع البنود مصدر تغطيتها المثبت؛ العمل الذي دخل فاتورة لا يُحصَّل مرة ثانية عند الزيارة."}
                </p>
              </li>
              );
            })}
          </ul>
          <p className="mt-2 text-[11px] leading-4 text-slate-400">
            الخطة اتفاق لا دَين: تُدخل الحساب عند الفوترة فقط، ورصيد الحساب أعلاه هو الرقم
            المعتمد دائمًا. <a href={`?tab=plans`} className="font-bold text-navy-800 underline decoration-navy-300 underline-offset-4">إدارة الخطط</a>
          </p>
        </details>
      ) : null}

      <section id="saved-invoices" className="mb-4" aria-label="الفواتير">
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
                  <span className="flex max-w-full flex-wrap items-start gap-x-1 text-[11px] leading-5 text-slate-500">
                    <span>{friendlyDateLong(invoice.createdAt.slice(0, 10))} ·</span>
                    <span className="max-w-full">
                      <InvoiceSettlementStatus invoice={invoice}
                        patientId={patientId} evidence={ledger.installmentRecovery}
                        ready={!loading && !error && ledger.invoices.filter((row) => row.id === invoice.id).length === 1} />
                    </span>
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
                      <button type="button" disabled={financialBlocked||mode!=="none"||busy||loading||!!error||collectOpen||correctingReceipt!==null} onClick={() => { if (!financialBlocked) { setCorrecting(invoice.id); setNotice(null); } }}
                        className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-bold text-amber-800">
                        تصحيح الفاتورة
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
              </li>
            ))}
          </ul>
        )}
      </section>

      {admin&&(revisionRecovery||correcting!==null)?<InvoiceCorrection key={revisionRecovery?.invoiceId??correcting!}
        patientId={patientId} invoiceId={revisionRecovery?.invoiceId??correcting!} recovery={revisionRecovery}
        onRecoveryChange={onRevisionRecoveryChange} financialRecovery={financialRecovery}
        onCancel={()=>setCorrecting(null)} onDone={message=>{setCorrecting(null);setNotice(message);void load();onClinicalChange?.();}}/>:null}

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
                  {admin && payment.kind === "payment"
                    && correctingReceipt !== payment.id ? (
                    <ReceiptCorrectionTrigger patientId={patientId} paymentId={payment.id} remainingMinor={ledger.receiptRemaining?.[payment.id] ?? 0}
                      onClick={() => { if (!financialBlocked) { setCorrectingReceipt(payment.id); setNotice(null); } }}
                      className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-bold text-amber-800" />
                  ) : null}
                  <a href={`/print/receipt/${payment.id}`} target="_blank" rel="noopener"
                    className="rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-bold text-navy-800">
                    السند
                  </a>
                </span>
                <ReceiptProvenance paymentId={payment.id} currency={payment.currency}
                  provenance={receiptProvenanceFor(ledger.receiptProvenance, payment.id, payment.amountMinor, payment.kind, payment.receiptNumber)} />
                {correctingReceipt === payment.id ? (
                  <ReceiptCorrection
                    receipt={payment} patientId={patientId}
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
                      notifyFinancialChange();
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

type InvoiceRow = ToothRowLike & { displayGroupId?: string | null; doctorId: string; serviceId: string; description: string; price: string; quantity: string; priceReason: string; manual?: boolean };
const blankInvoiceRow = (key: string): InvoiceRow => ({
  key, doctorId: "", serviceId: "", description: "", price: "", quantity: "1", priceReason: "", caseId: "", ...emptyToothFields("none"),
});

function InvoiceForm({ patientId, visitId, base, services, onReloadCatalogue, busy, historical = false, selectionContextKey = "", canChangeDraft, onRecoveryHold, recovery, onRecoveryChange, onSubmit, financialRecovery, originControl }: {
  patientId: number;visitId?:number;
  base: Currency;
  services: Service[];
  onReloadCatalogue:()=>void;
  busy: boolean;
  historical?: boolean;
  originControl?: ReactNode;
  selectionContextKey?: string;
  canChangeDraft: () => boolean;
  onRecoveryHold: (hold: boolean) => void;
  recovery: InvoiceCommandState | null;
  onRecoveryChange: (command: InvoiceCommandState | null) => void;
  onSubmit: (body: Record<string, unknown>, validateReceipt?: (payload: unknown) => boolean) => Promise<InvoiceCommandOutcome>;
  financialRecovery: FinancialRecoveryControl;
}) {
  const summaryId = useId();
  const formSession = useSession();
  const canSubmit = canHandleMoney(formSession?.role);
  const authorityKey = JSON.stringify([formSession,visitId??null]);
  const authority = useMemo(() => ({ authorityKey, canSubmit }), [authorityKey, canSubmit]);
  // Preserve the revision this draft started from; another tab's completed save
  // must invalidate this draft rather than silently minting another operation.
  const journalRevision = useRef(financialRecovery.revision);
  /* مفاتيح ثابتة للأسطر: اختيار عدة أسنان يقسم السطر إلى أسطر، فلا يصلح الترتيب مفتاحًا. */
  const rowSeq = useRef(0);
  const nextRowKey = () => `row-${++rowSeq.current}`;
  const [rows, setRows] = useState<InvoiceRow[]>(() => [blankInvoiceRow("row-0")]);
  const [repaymentDraft,setRepaymentDraft] = useState<DebtRepaymentDraft>({mode:"full",rows:[]});
  /* (INV-LINK TOOTH) نافذة «تحديد الأسنان» مفتوحة لهذا السطر (بمفتاحه). */
  const [toothDialogFor, setToothDialogFor] = useState<string | null>(null);
  const [splitNotice, setSplitNotice] = useState<string | null>(null);
  /* (INV-LINK B) مفتاح الإعادة لهذا النموذج: نقرةٌ مزدوجة أو ردٌّ ضائع يعيد الفاتورة نفسها لا فاتورةً ثانية. */
  const [idempotencyKey, setIdempotencyKey] = useState(() => newIdempotencyKey("inv"));
  const [previewState, setPreviewState] = useState<(InvoiceSelectionPreviewState & { owner: object; template?: InvoiceTemplatePreview; rows?: InvoiceTemplatePreviewRow[] }) | null>(null);
  const [selection, setSelection] = useState<InvoiceSelection | null>(null);
  const [previewRetry, setPreviewRetry] = useState(0);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [templateDraft, setTemplateDraft] = useState<InvoiceTemplateDraft | null>(null);
  const [templateCatalogReady, setTemplateCatalogReady] = useState(false);
  const [reviewedTemplate, setReviewedTemplate] = useState<{ owner: object; version: string } | null>(null);
  const commandRef = useRef<InvoiceCommandState | null>(null);
  const [commandState, setCommandState] = useState<InvoiceCommandState | null>(null);
  const commandLocked = !!commandState && !commandState.editing || !!recovery && !commandState;
  const editorEnabled = () => canChangeDraft() && (!commandRef.current && !recovery || commandRef.current?.editing === true);
  // Current permission, not a captured render, owns every grouped editor action.
  const editorMounted = useRef(true);
  const canEditRows = useRef<() => boolean>(() => false);
  canEditRows.current = () => editorMounted.current && editorEnabled() && canSubmit && !busy;
  useLayoutEffect(() => { editorMounted.current = true; return () => { editorMounted.current = false; }; }, []);
  const recordCommand = (next: InvoiceCommandState) => {
    commandRef.current = next; setCommandState(next); onRecoveryChange(next.outcome === "saved" ? null : next);
  };
  const submitCommand = async (body: Record<string, unknown>, expected: InvoiceTemplateReceiptExpectation | HistoricalReceiptExpectation | null, retry: false | "current" | "original" = false) => {
    if (!canSubmit || !canChangeDraft() || busy || commandRef.current?.outcome === "pending") return;
    if (!retry && commandRef.current && !commandRef.current.editing) return;
    const previous = commandRef.current;
    const submission = retry ? retry === "original" ? previous?.original : previous?.submission
      : expected ? { lease: retainInvoiceCommand(authority, body), expected, netMinor: net } : null;
    if (!submission || submission.lease.owner !== authority || submission.expected.owner !== authority) return;
    const exact = invoiceCommandForOwner(submission.lease, authority);
    if (!exact) return;
    const pending: InvoiceCommandState = { submission, original: previous?.original ?? submission, outcome: "pending", editing: false };
    recordCommand(pending); onRecoveryHold(true); setToothDialogFor(null);
    let outcome: InvoiceCommandOutcome = "uncertain";
    try {
      const durable = durableInvoiceCommand(pending);
      if (!await financialRecovery.reserve(durable, journalRevision.current)) {
        commandRef.current = null; setCommandState(null); return;
      }
      // Recheck the current owner after asynchronous storage, before POST.
      if (!canChangeDraft() || submission.lease.owner !== authority) return;
      outcome = await onSubmit(exact, payload => commandRef.current === pending
        && ("kind" in submission.expected ? readHistoricalReceipt(payload, submission.expected, authority) : readInvoiceCommandReceipt(payload, submission.expected, authority)) !== null);
      if (outcome === "saved") await financialRecovery.acknowledge(durable);
    }
    catch { outcome = "uncertain"; /* Includes failed durable acknowledgement after a verified server reply. */ }
    if (commandRef.current !== pending) return;
    recordCommand({ ...pending, outcome }); onRecoveryHold(outcome !== "saved");
  };
  const [doctorCatalog, setDoctorCatalog] = useState<{ patientId: number; owner: object; rows: { id: number; name: string }[] } | null>(null);
  const doctors = doctorCatalog?.patientId === patientId && doctorCatalog.owner === authority ? doctorCatalog.rows : [];
  useEffect(() => {
    if (!canSubmit) return;
    const controller = new AbortController();
    void fetch("/api/parties?kind=doctor", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload: unknown = await response.json().catch(() => null);
        if (controller.signal.aborted) return;
        // Read only the already-authorized catalogue. Denied/malformed reads expose no fallback list.
        if (response.ok && Array.isArray(payload) && payload.every((entry) => record(entry)
          && positiveId(entry.id) && typeof entry.name === "string" && entry.kind === "doctor")) {
          setDoctorCatalog({ patientId, owner: authority, rows: payload.map((entry) => ({ id: entry.id as number, name: entry.name as string })) });
        } else setDoctorCatalog(null);
      }).catch(() => { if (!controller.signal.aborted) setDoctorCatalog(null); });
    return () => controller.abort();
  }, [patientId, authority, canSubmit]);
  const [historicalPaid, setHistoricalPaid] = useState("");
  const [historicalDate, setHistoricalDate] = useState("");
  const [historicalNote, setHistoricalNote] = useState("");
  const [discount, setDiscount] = useState("");
  /* (FIN-4) الخصم وتغيير سعر خدمة الدليل قراران مسبَّبان — والحد من الإعدادات يفرضه الخادم. */
  const [discountReason, setDiscountReason] = useState("");
  // Agreement currency changes replace each amount with its own catalogue price.
  // A manual amount belongs to its original currency and is never reinterpreted.
  const [currency, setCurrency] = useState<Currency>(base);
  const changeCurrency = (next: Currency) => {
    if (!editorEnabled() || next === currency) return;
    setSplitNotice(null);
    setCurrency(next); setDiscount(""); setDiscountReason(""); setHistoricalPaid("");
    setRepaymentDraft({mode:"full",rows:[]});
    setRows(current => current.map(row => {
      const service = services.find(one => String(one.id) === row.serviceId);
      const price = service ? invoiceOfferedPrice(service, next) : null;
      return { ...row, price: price === null ? "" : formatAmount(price, next), priceReason: "" };
    }));
  };
  const selectorServices = services.map(service => {
    const price = invoiceOfferedPrice(service, currency);
    return { ...service, priceConfigured: price !== null,
      priceIn: { [currency]: { minor: price, source: service.invoiceQuotes?.[currency]?.source ?? (price === null ? "none" as const : "catalog" as const) } } };
  });


  // الحساب هنا بنفس دالة القراءة التي يستعملها الخادم: حسابٌ محلي بقواعد أخرى
  // يعطي رقمًا يخالف ما يُحفَظ، فيفقد المستخدم ثقته بالشاشة كلها.
  const manualTotal = useMemo(() => rows.reduce((sum, row) => {
    const service = services.find((item) => String(item.id) === row.serviceId);
    const typed = row.price.trim() ? parseAmount(row.price, currency) : null;
    const unit = typed ?? (service ? invoiceOfferedPrice(service, currency) : null) ?? 0;
    const quantity = Math.max(1, Math.round(Number(row.quantity) || 1));
    return sum + unit * quantity;
  }, 0), [rows, services, currency]);

  const previewAmount = (index: number) => {
    const row = rows[index];
    const service = services.find((item) => String(item.id) === row.serviceId);
    const typed = row.price.trim() ? parseAmount(row.price, currency) : null;
    const unit = typed ?? (service ? invoiceOfferedPrice(service, currency) : null) ?? 0;
    return unit * Math.max(1, Math.round(Number(row.quantity) || 1));
  };

  /* (INV-LINK D) معاينة ما ستفعله الفاتورة بالعلاج: بند خطة قائم/جديد، حالة قائمة/أولية — قبل الحفظ. */
  const serviceOf = (serviceId: string) => services.find((item) => String(item.id) === serviceId);
  const isClinical = (serviceId: string) => {
    const service = serviceOf(serviceId);
    return service ? lineLinkage({ serviceId: service.id, category: service.category }).kind === "clinical" : false;
  };
  /* (INV-LINK TOOTH) كيف يُحدَّد سن البند — من فئة خدمته وحدها (المصدر نفسه الذي يفرضه الخادم). */
  const modeOf = (row: InvoiceRow): ToothScopeMode => invoiceToothMode(serviceOf(row.serviceId)?.category);
  const inputProblems = rows.map(row => {
    if (!row.serviceId && !row.description.trim()) return null;
    const service = serviceOf(row.serviceId);
    const catalogue = service ? invoiceOfferedPrice(service, currency) : null;
    if(service?.invoiceQuotes?.[currency]?.source === "converted" && service.invoiceQuotes[currency]?.minor === 0
      && (!row.price.trim() || (parseAmount(row.price,currency)??0)<=0)) return INVOICE_ZERO_CONVERSION_MESSAGE;
    if (service && invoiceCatalogPrice(service, currency) === null
      && !(service.invoiceQuotes?.[currency]?.source === "converted" && parseAmount(row.price, currency) === catalogue)
      && (row.priceReason.trim().length < 3) && row.price.trim() && (parseAmount(row.price, currency) ?? 0) > 0) return "اكتب سبب التسعير اليدوي لهذه الخدمة قبل الحفظ.";
    if (service && catalogue === null && (!row.price.trim() || (parseAmount(row.price, currency) ?? 0) <= 0)) {
      return "لا يوجد سعر مقرر بهذه العملة؛ اكتب قيمة الاتفاق صراحةً أو اطلب تسعير الخدمة. لا يُحفظ سعر صفري تلقائيًا.";
    }
    return invoiceLineInputProblem({ price: row.price, quantity: row.quantity, currency, servicePriceMinor: catalogue });
  });
  // Keep text/price/tooth drafts; only explicit identity selections expire on changed work/context.
  const selectionScope = JSON.stringify({ patientId, currency, base, selectionContextKey, templateDraft,
    catalog: services.map((service) => [service.id, service.name, service.category, invoiceOfferedPrice(service, currency), service.isActive, service.invoiceQuotes?.[currency]]),
    rows: rows.map(({ displayGroupId, ...row }) => { void displayGroupId; return row; }) });
  const selectionOwner = useMemo(() => ({ selectionScope, authority }), [selectionScope, authority]);
  const selected = selectionForOwner(selection, selectionOwner);
  // Changing any row identity or linkage input invalidates evidence during render, before the debounce/effect.
  const previewKey = JSON.stringify({ patientId, visitId, currency, discount, discountReason, historicalPaid, historicalDate, historicalNote, idempotencyKey, base, retry: previewRetry,
    authorityKey, selectionContextKey, existingPlanId: selected.existingPlanId, templateDraft,
    catalog: services.map((service) => [service.id, service.name, service.category, invoiceOfferedPrice(service, currency), service.isActive, service.invoiceQuotes?.[currency]]),
    rows: rows.map((row, index) => ({ row, index })).filter(({ row }) => row.serviceId || row.description.trim())
      .map(({ row, index }) => ({ key: row.key, clinical: isClinical(row.serviceId), inputProblem: inputProblems[index],
        serviceId: row.serviceId ? Number(row.serviceId) : undefined, description: row.description,
        catalogPriceMinor: serviceOf(row.serviceId) ? invoiceCatalogPrice(serviceOf(row.serviceId)!, currency) : undefined,
        priceQuote: serviceOf(row.serviceId)?.invoiceQuotes?.[currency],
        price: row.price, priceReason: row.priceReason, quantity: Number(row.quantity) || 1,
        caseId: isClinical(row.serviceId) && row.caseId ? Number(row.caseId) : undefined,
        planItemId: isClinical(row.serviceId) ? selected.itemIds.get(row.key) ?? null : null,
        doctorId: row.doctorId ? Number(row.doctorId) : undefined, ...toothPayload(modeOf(row), row) })),
  });
  // A state-owned generation survives ordinary renders, but never revives an earlier A after A -> B -> A.
  // React restarts this component before committing when the guarded render-time adjustment runs.
  const [previewGeneration, setPreviewGeneration] = useState(() => ({ previewKey, authority }));
  const previewOwner = previewGeneration.previewKey === previewKey && previewGeneration.authority === authority
    ? previewGeneration : { previewKey, authority };
  if (previewOwner !== previewGeneration) setPreviewGeneration(previewOwner);
  // Forget old evidence rather than reviving it if inputs later return to an earlier value.
  if (previewState && (previewState.requestKey !== previewKey || previewState.owner !== previewOwner)) setPreviewState(null);
  useEffect(() => {
    if (historical || !canSubmit || commandLocked) return;
    const request = JSON.parse(previewKey) as {
      patientId: number; visitId?:number; currency: Currency; discount: string; discountReason: string; idempotencyKey: string;
      existingPlanId: number | null;
      templateDraft: InvoiceTemplateDraft | null;
      rows: { key: string; clinical: boolean; planItemId?: number | null; [field: string]: unknown }[];
    };
    if ((!request.templateDraft && !request.rows.length) || request.rows.some((row) => row.inputProblem)) return;
    const controller = new AbortController();
    const unavailable = () => {
      if (!controller.signal.aborted) setPreviewState({ owner: previewOwner, requestKey: previewKey, status: "unavailable", byRow: new Map() });
    };
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      deadline = setTimeout(() => { unavailable(); controller.abort(); }, 15_000);
      void fetch("/api/invoices/clinical-preview", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ patientId: request.patientId, ...(request.visitId!==undefined?{visitId:request.visitId}:{}), currency: request.currency,
          existingPlanId: request.existingPlanId,
          ...(request.templateDraft ? { templateSelection: request.templateDraft.selection } : {}),
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
          setPreviewState({ owner: previewOwner, requestKey: previewKey, status: "refused", message: payload.message.slice(0, 1500), byRow: new Map() });
          return;
        }
        const evidence = response.ok ? request.templateDraft
          ? readInvoiceTemplatePreview(payload, request.rows, request.existingPlanId, {
              template: request.templateDraft.template, selection: request.templateDraft.selection, catalogServices: services, currency,
            })
          : readInvoiceSelectionPreview(payload, request.rows, request.existingPlanId) : null;
        if (!evidence) { unavailable(); return; }
        setPreviewState({ owner: previewOwner, requestKey: previewKey, status: "ready", ...evidence });
      }).catch(unavailable).finally(() => clearTimeout(deadline));
    }, 350);
    return () => { controller.abort(); clearTimeout(timer); clearTimeout(deadline); };
  }, [previewKey, previewOwner, canSubmit, commandLocked, services, historical, currency]);
  const currentPreview = previewState?.owner === previewOwner ? previewState : null;
  const selectionEvidence = currentPreview?.requestKey === previewKey && currentPreview.status === "ready" ? currentPreview.selections : undefined;
  const currentTemplate = currentPreview?.requestKey === previewKey && currentPreview.status === "ready" ? currentPreview.template ?? null : null;
  const templatePreviewBlocked = !!templateDraft && (!templateCatalogReady || !currentTemplate
    || currentTemplate.lines.some(line => previewForRow(currentPreview, previewKey, currentPreview?.rows?.[line.line]?.key ?? "missing-template-row").status !== "ready"));
  const templateReviewed = !templateDraft || !!currentTemplate && reviewedTemplate?.owner === previewOwner && reviewedTemplate.version === currentTemplate.version;
  const total = manualTotal + (currentTemplate?.lines.reduce((sum, line) => sum + line.quantity * line.unitPriceMinor, 0) ?? 0);
  const totalInvalid = !Number.isSafeInteger(total) || total < 0;
  const parsedDiscount = discount.trim() ? parseAmount(discount, currency) : 0;
  const discountInvalid = parsedDiscount === null;
  const discountMinor = parsedDiscount ?? 0;
  const net = Math.max(0, total - discountMinor);
  const historicalPaidMinor = historicalPaid.trim() ? parseAmount(historicalPaid, currency) : 0;
  const historicalRemaining = historicalPaidMinor !== null && historicalPaidMinor >= 0 && historicalPaidMinor <= net ? net - historicalPaidMinor : null;
  const historicalSource = {
    patientId,currency,discount,discountReason,idempotencyKey,previouslyPaidAmount:historicalPaid,historicalAsOf:historicalDate,note:historicalNote.trim()||null,
    items:(JSON.parse(previewKey) as {rows:Record<string,unknown>[]}).rows.map(row=>{
      const {key,clinical,inputProblem,planItemId,...item}=row;void key;void clinical;void inputProblem;void planItemId;return item;
    }),repaymentTerms:{mode:"full",installments:[]},repaymentRemainingMinor:0,repaymentVersion:0,repaymentSourceHash:null,
  };
  const historicalKey=JSON.stringify(historicalSource);
  const historicalServices=new Map(services.map(service=>[service.id,{...service,priceSarMinor:service.priceSarMinor??null,priceUsdMinor:service.priceUsdMinor??null,
    priceConfigured:service.priceConfigured??false,priceProvisional:service.priceProvisional??false,isActive:service.isActive===true,sortOrder:0}]));
  const historicalParsed=historical?parseHistoricalDocument(historicalSource,historicalServices,new Set(doctors.map(doctor=>doctor.id)),
    {today:clinicDateString(new Date(),CLINIC_ZONE_FALLBACK),role:formSession?.role??"",maxDiscountPercent:100,rates:Object.fromEntries((["SAR","USD"] as const).map(code=>[code,services.find(service=>service.invoiceQuotes?.[code]?.source==="converted")?.invoiceQuotes?.[code]?.rate??null]))}):null;
  const [historicalState,setHistoricalState]=useState<{owner:object;status:"ready"|"unavailable"|"refused";message?:string;preview?:HistoricalPreview}|null>(null);
  const currentHistorical=historicalState?.owner===previewOwner?historicalState:null;
  useEffect(()=>{
    if(!historical||!canSubmit||commandLocked||!historicalParsed?.ok)return;
    const input=historicalParsed.value;const controller=new AbortController();let deadline:ReturnType<typeof setTimeout>|undefined;
    const unavailable=()=>{if(!controller.signal.aborted)setHistoricalState({owner:previewOwner,status:"unavailable",message:"تعذّر التحقق من الاتفاق؛ أعد المعاينة."});};
    const timer=setTimeout(()=>{deadline=setTimeout(()=>{unavailable();controller.abort();},15000);
      void fetch(`/api/patients/${patientId}/historical-documents/preview`,{method:"POST",headers:{"Content-Type":"application/json"},signal:controller.signal,body:historicalKey})
        .then(async response=>{const payload:unknown=await response.json().catch(()=>null);if(controller.signal.aborted)return;
          if(!response.ok&&record(payload)&&typeof payload.message==="string"){setHistoricalState({owner:previewOwner,status:"refused",message:payload.message.slice(0,1500)});return;}
          const preview=response.ok?readHistoricalPreview(payload,input):null;if(!preview){unavailable();return;}
          setHistoricalState({owner:previewOwner,status:"ready",preview});
        }).catch(unavailable).finally(()=>clearTimeout(deadline));
    },350);
    return()=>{controller.abort();clearTimeout(timer);clearTimeout(deadline);};
  // The serialized intent and preview lifetime cover every clinical/financial input.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[historical,historicalKey,previewOwner,canSubmit,commandLocked,previewRetry,doctorCatalog]);
  const historicalEvidence=currentHistorical?.status==="ready"?currentHistorical.preview:null;
  const debtRemaining = historical ? historicalEvidence?.remainingMinor??historicalRemaining??0 : net;
  const repayment = readDebtRepaymentDraft(repaymentDraft,currency,debtRemaining);
  const clinicalPreviewBlocked = historical ? !historicalEvidence || historicalEvidence.requiresAllocationReview || historicalEvidence.lines.some(line=>line.case.mode==="choose") : (rows.some(row=>row.serviceId||row.description.trim()) && currentPreview?.status!=="ready") || rows.some((row) => isClinical(row.serviceId)
    && previewForRow(currentPreview, previewKey, row.key).status !== "ready");

  /* (INV-LINK TOOTH) لا يُحفظ بندٌ يحتاج سنًّا بلا سن — والخادم يرفضه أيضًا. */
  const toothProblems = rows.map((row) => row.serviceId ? toothProblem(modeOf(row), row) : null);
  const blockedLines = toothProblems.flatMap((problem, index) => problem ? [index + 1] : []);
  const expectedReceipt = (): InvoiceTemplateReceiptExpectation | null => {
    if (templateDraft && (!currentTemplate || !currentPreview || templatePreviewBlocked) || clinicalPreviewBlocked || discountInvalid || !repayment.ok) return null;
    const expectedLines: InvoiceTemplateReceiptExpectedLine[] = [];
    const append = (source: "manual" | "template", value: { serviceId: number | null; doctorId: number | null; description: string; quantity: number; unitPriceMinor: number; toothCode: number | null; surfaces: string | null }, key: string, category: string | null) => {
      const linkage = lineLinkage({ serviceId: value.serviceId, category });
      const proof = currentPreview?.byRow.get(key);
      const scheduled = source === "template" || linkage.kind === "clinical";
      if (scheduled && (!proof?.item || !proof.case || proof.case.mode === "choose")) return false;
      const planItem: InvoiceTemplateReceiptExpectedLine["planItem"] = !scheduled ? { mode: "none" }
        : proof!.item!.mode === "existing" && proof!.item!.id !== null ? { mode: "existing", id: proof!.item!.id } : { mode: "new" };
      let caseChoice: InvoiceTemplateReceiptExpectedLine["case"] = !scheduled || proof!.case!.mode === "none" ? { mode: "none" }
        : proof!.case!.mode === "existing" && proof!.case!.id !== null ? { mode: "existing", id: proof!.case!.id }
        : proof!.case!.mode === "bridge" ? { mode: "bridge" } : { mode: "new" };
      if (source === "manual" && linkage.kind === "clinical" && linkage.specialty === "restorative" && planItem.mode === "existing" && caseChoice.mode === "none") {
        const candidate = currentPreview?.selections?.itemChoices.get(key)?.find(one => one.id === planItem.id);
        if (!candidate) return false;
        if (candidate.clinicalCaseId !== null) caseChoice = { mode: "existing", id: candidate.clinicalCaseId };
      }
      expectedLines.push({ source, ...value, kind: linkage.kind, specialty: linkage.kind === "clinical" ? linkage.specialty : null,
        scheduled, planItem, case: caseChoice }); return true;
    };
    for (const row of rows.filter(one => one.serviceId || one.description.trim())) {
      const service = serviceOf(row.serviceId);
      const fields = toothPayload(modeOf(row), row);
      const site = validateLineSite({ category: service?.category ?? null, ...fields, toothCode: fields.toothCode ?? null });
      const price = row.price.trim() ? parseAmount(row.price, currency) : service ? invoiceOfferedPrice(service, currency) : null;
      if (!site.ok || price === null || !append("manual", { serviceId: service?.id ?? null, doctorId: row.doctorId ? Number(row.doctorId) : null,
        description: service?.name ?? row.description.trim().slice(0, 160), quantity: Math.max(1, Math.round(Number(row.quantity) || 1)), unitPriceMinor: price,
        toothCode: site.site.toothCode, surfaces: site.site.surfaces }, row.key, service?.category ?? null)) return null;
    }
    for (const line of currentTemplate?.lines ?? []) {
      const key = currentPreview?.rows?.[line.line]?.key, service = services.find(one => one.id === line.serviceId);
      if (!key || !service || !append("template", { serviceId: line.serviceId, doctorId: line.doctorId, description: line.description,
        quantity: line.quantity, unitPriceMinor: line.unitPriceMinor, toothCode: line.toothCode, surfaces: line.surfaces }, key, service.category)) return null;
    }
    return { owner: authority, patientId,...(visitId!==undefined?{visitId}:{}), currency, discountMinor, note: null, expectedPlanId: selected.existingPlanId, lines: expectedLines,repaymentTerms:repayment.value };
  };
  // Presentation only: every child remains in the original ordered preview/save payload.
  // A chosen batch never absorbs another source merely because its price matches.
  const displayContext = {
    currency,
    modeOf,
    priceValue: (row: InvoiceRow) => row.price.trim() ? parseAmount(row.price, currency)
      : serviceOf(row.serviceId) ? invoiceOfferedPrice(serviceOf(row.serviceId)!, currency) : null,
    provenance: (row: InvoiceRow) => {
      const chosen = selected.itemIds.get(row.key);
      const proof = currentPreview?.byRow.get(row.key);
      const itemId = chosen ?? (proof?.item?.mode === "existing" ? proof.item.id : null);
      const source = (selectionEvidence?.itemChoices.get(row.key) ?? []).find(item => item.id === itemId);
      return itemId !== null && itemId !== undefined
        ? source ? `existing-plan:${source.planId}` : `unverified-item:${itemId}`
        : "new-manual-invoice";
    },
  };
  const displayGroups = buildInvoiceDisplayGroups(historical ? rows.map(row => ({ ...row, displayGroupId: null })) : rows, displayContext);
  const groupForRow = (key: string) => displayGroups.find(group => group.keys.includes(key));
  const editGroup = (keys: readonly string[], patch: Partial<InvoiceRow>) => {
    if (canEditRows.current()) setRows(current => canEditRows.current() ? patchDisplayGroupRows(current, keys, patch, displayContext) : current);
  };
  const dialogIndex = toothDialogFor === null ? -1 : rows.findIndex((row) => row.key === toothDialogFor);
  const dialogRow = dialogIndex >= 0 ? rows[dialogIndex] : null;
  const dialogGroup = dialogRow ? groupForRow(dialogRow.key) : undefined;

  const confirmTeeth = (key: string, serviceId: string, expectedMode: ToothScopeMode, selection: ToothSelection) => {
    if (!canEditRows.current()) return;
    const index = rows.findIndex((row) => row.key === key);
    if (index < 0 || rows[index].serviceId !== serviceId || modeOf(rows[index]) !== expectedMode) { setToothDialogFor(null); return; }
    const mode = modeOf(rows[index]);
    const members = groupForRow(key)?.keys ?? [key];
    if (!historical && (mode === "per_tooth_episode" || mode === "multi_tooth_episode" || mode === "tooth_surfaces")) {
      const occupied = rows.find(other => !members.includes(other.key) && other.serviceId === serviceId
        && other.toothCode !== null && selection.teeth.includes(other.toothCode));
      if (occupied) {
        setSplitNotice(`سن ${occupied.toothCode} موجود في بند آخر لهذه الخدمة؛ عدّل بنده نفسه أو أزله منه أولًا.`);
        setToothDialogFor(null); return;
      }
    }
    setRows((current) => {
      const at = current.findIndex((row) => row.key === key);
      return !canEditRows.current() || at < 0 || current[at].serviceId !== serviceId || modeOf(current[at]) !== expectedMode
        ? current : historical ? applyHistoricalToothSelection(current, at, mode, selection, nextRowKey)
          : applyGroupedToothSelection(current, at, mode, selection, nextRowKey, { ...displayContext, memberKeys: groupForRow(key)?.keys });
    });
    const teeth = [...new Set(selection.teeth)].sort((a, b) => a - b);
    setSplitNotice(!historical && (mode === "per_tooth_episode" || mode === "multi_tooth_episode" || mode === "tooth_surfaces") && teeth.length > 1
      ? `الخدمة في بند واحد: ${teeth.length} أسنان × سعر الوحدة. يُحفظ ربط كل سن بالعلاج.` : null);
    setToothDialogFor(null);
  };

  const scopeButtons = (row: InvoiceRow, index: number, mode: ToothScopeMode) => {
    const scopes = allowedScopes(mode);
    if (scopes.length === 0) return null;
    return <select aria-label="نطاق العلاج" data-testid={`invoice-scope-${index}`} value={row.toothCode===null?row.scope??"":""}
      onChange={event=>setRows(current=>setRowScope(current,index,event.target.value?event.target.value as typeof scopes[number]:null))}>
      <option value="">اختر النطاق</option>
      {scopes.map(scope=><option key={scope} value={scope}>{SITE_SCOPE_LABEL[scope]}</option>)}
    </select>;
  };

  const toothControl = (row: InvoiceRow, index: number, group: InvoiceDisplayGroup<InvoiceRow>) => {
    const mode = modeOf(row);
    if (mode === "none") return null;
    const groupedTeeth = !historical && (mode === "per_tooth_episode" || mode === "multi_tooth_episode" || mode === "tooth_surfaces");
    const label = groupedTeeth && group.teeth.length ? `الأسنان: ${group.teeth.map(tooth =>
      mode === "tooth_surfaces" && group.surfacesByTooth[tooth] ? `${tooth} (${group.surfacesByTooth[tooth]})` : tooth).join("، ")}` : selectionLabel(mode, row);
    const chosenTooth = row.toothCode !== null;
    const problem = toothProblems[index];
    const openButton = (text: string) => (
      <button type="button" onClick={() => { if (canEditRows.current()) setToothDialogFor(row.key); }} data-testid={`invoice-tooth-button-${index}`}
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
            className={`inline-flex min-h-[32px] items-center gap-1 ${groupedTeeth && group.teeth.length > 1 ? "rounded-xl" : "rounded-full"} border border-navy-200 bg-navy-50 px-3 text-xs font-extrabold text-navy-900`}>
            🦷 <span>{label}</span>
            {!groupedTeeth && row.groupId && row.episodeTeeth && row.episodeTeeth.length > 1 ? (
              <span className="font-semibold text-slate-500">· هذا السطر: {row.toothCode}</span>
            ) : null}
          </span>
        ) : null}
        {usesToothChart(mode) ? openButton(chosenTooth ? "تغيير" : mode === "region" ? "🦷 سن محدد" : "🦷 تحديد الأسنان") : null}
      </div>
    );
  };

  if (!canSubmit) return <p role="status" className="text-sm text-slate-500">لا توجد صلاحية لإصدار فاتورة في الجلسة الحالية.</p>;
  return (
    <section className={`mb-4 ${workspace.workspace} ${historical ? workspace.legacy : ""}`} aria-label={historical ? "اتفاق تاريخي متعدد البنود" : "فاتورة جديدة"} data-testid="invoice-workspace">
      <header className={workspace.header}>
        <FileText size={24} aria-hidden="true"/><div><h3>{historical ? "اتفاق علاج بدأ قبل النظام" : "فاتورة واتفاق علاج جديد"}</h3>
        <p>الخدمات والأسنان والأسعار، ثم مراجعة الاتفاق وحفظه.</p></div>
      </header>
      {originControl}
      <div className={workspace.body}>
      {historical ? <p role="status" className={workspace.historicalNotice}>
        توثيق اتفاق سابق وربطه بالعلاج. يدخل المتبقي رصيدًا افتتاحيًا فقط، دون فاتورة أو سند للمدفوع قبل النظام.
      </p> : null}
      {!commandState && recovery ? <div role="status" className="mb-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs">
        <p>يوجد طلب سابق غير محسوم لهذا المريض والمستخدم. لا تبدأ فاتورة بديلة قبل التحقق من الطلب الأصلي.</p>
        <button type="button" disabled={busy} className="mt-2 min-h-11 rounded-lg border px-3 font-bold" onClick={() => {
          if (!canChangeDraft() || !canSubmit) return;
          const adopt = (one: InvoiceSubmission): InvoiceSubmission => ({ ...one, lease: { ...one.lease, owner: authority }, expected: { ...one.expected, owner: authority } });
          const restored: InvoiceCommandState = { ...recovery, original: adopt(recovery.original), submission: adopt(recovery.submission), outcome: "uncertain", editing: false };
          const body = invoiceCommandForOwner(restored.original.lease, authority);
          if (!body || typeof body.idempotencyKey !== "string") return;
          setIdempotencyKey(body.idempotencyKey); recordCommand(restored); onRecoveryHold(true);
        }}>استعادة الطلب للتحقق بنفس المفتاح</button>
      </div> : null}
      {commandState && commandState.outcome !== "saved" ? <div role="status" data-testid="invoice-command-recovery" className="mb-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs">
        <p>{commandState.outcome === "pending" ? "جارٍ إرسال الطلب المعتمد؛ لا تغيّر بياناته." : commandState.outcome === "uncertain"
          ? "نتيجة الطلب غير مؤكدة. احتُفظ بنفس بيانات الاتفاق والمفتاح؛ أعد التحقق من نفس الطلب."
          : "لم يُعتمد هذا الطلب. يمكنك إعادة الطلب نفسه، أو تأكيد تعديل المسودة مع إبقاء المفتاح الأصلي."}</p>
        <p className="mt-1 font-bold">الطلب الأصلي: {formatMoney(commandState.original.netMinor, commandState.original.expected.currency)}</p>
        {commandState.submission.lease.serialized !== commandState.original.lease.serialized ? <p className="mt-1 font-bold">الطلب المعدّل: {formatMoney(commandState.submission.netMinor, commandState.submission.expected.currency)}</p> : null}
        <button type="button" disabled={busy || commandState.outcome === "pending" || commandState.submission.lease.owner !== authority}
          onClick={() => void submitCommand({}, null, "current")}
          className="mt-2 min-h-11 rounded-lg border px-3 font-bold">{historical?"إعادة نفس طلب الاتفاق":"إعادة نفس طلب الفاتورة"}</button>
        {commandState.submission.lease.serialized !== commandState.original.lease.serialized ? <button type="button" disabled={busy || commandState.outcome === "pending"}
          onClick={() => void submitCommand({}, null, "original")} className="mr-2 mt-2 min-h-11 rounded-lg border px-3 font-bold">التحقق من الطلب الأصلي قبل التعديل</button> : null}
        {(commandState.outcome === "busy" || commandState.outcome === "refused") && !commandState.editing ? <button type="button" disabled={busy}
          onClick={() => { const current = commandRef.current;
            if (!canChangeDraft() || !current || current.submission.lease.owner !== authority || current.outcome !== "busy" && current.outcome !== "refused") return;
            if (!window.confirm("سيبقى المفتاح الأصلي والطلب السابق محفوظين. إذا حُفظت فاتورة بهذا المفتاح فلن تُنشأ فاتورة أخرى عند تعديل المسودة. هل تريد تعديلها وإعادة معاينتها؟")) return;
            recordCommand({ ...current, editing: true }); onRecoveryHold(false);
            setReviewedTemplate(null); setPreviewRetry(value => value + 1);
          }} className="mr-2 mt-2 min-h-11 rounded-lg border px-3">تعديل المسودة بعد الرفض</button> : null}
      </div> : null}
      <fieldset disabled={busy || commandLocked} className="min-w-0">
      <div className={workspace.layout}>
      <div className={workspace.services}>
      <div className={workspace.meta}>
        <label><span>{historical ? "عملة الاتفاق" : "عملة الفاتورة"}</span>
          <select value={currency} onChange={event=>changeCurrency(event.target.value as Currency)} aria-label={historical ? "عملة الاتفاق" : "عملة الفاتورة"}>
            {CURRENCIES.map(option=><option key={option} value={option}>{CURRENCY_LABEL[option]}</option>)}
          </select>
        </label>
        {historical?<label><span>تاريخ الاتفاق الأصلي</span><input aria-label="تاريخ المعلومات التاريخية" value={historicalDate} onChange={event=>{if(canEditRows.current())setHistoricalDate(event.target.value);}} type="date"/></label>
          :<div><span>تاريخ الإصدار</span><time dir="ltr">{clinicDateString(new Date(),CLINIC_ZONE_FALLBACK)}</time></div>}
      </div>
      {historical ? <label className="mb-3 block text-xs font-bold">ملاحظة الاتفاق التاريخي<input aria-label="ملاحظة الاتفاق التاريخي" className="mt-1 w-full" maxLength={300} value={historicalNote} onChange={event=>{if(canEditRows.current())setHistoricalNote(event.target.value);}}/></label> : null}
      <h4 className={workspace.sectionTitle}>الخدمات العلاجية</h4>
      {!historical ? <button type="button" disabled={busy} aria-expanded={templateOpen}
        onClick={() => { if (editorEnabled()) setTemplateOpen(open => !open); }}
        className="mb-3 min-h-11 rounded-xl border border-sky-300 px-3 text-sm font-bold">{templateOpen ? "إخفاء اختيار القالب" : "اختيار قالب علاج"}</button> : null}
      {templateOpen ? <InvoiceTemplatePicker patientId={patientId} authorityKey={authorityKey}
        services={services} doctors={doctors} disabled={busy || commandLocked} draft={templateDraft}
        allowManual={!commandState && !recovery} onCatalogReady={setTemplateCatalogReady}
        onChange={draft => {
          if (!draft && (commandRef.current || recovery)) return;
          if (editorEnabled() && canSubmit && !busy) setTemplateDraft(draft);
        }}
        evidence={currentTemplate && currentPreview ? { template: currentTemplate, byRow: currentPreview.byRow } : null} /> : null}
      {!templateDraft && (commandState && invoiceCommandHasTemplate(commandState.original.lease) || recovery && invoiceCommandHasTemplate(recovery.original.lease)) ? <p role="status" className="mb-3 text-xs text-amber-800">الطلب المحفوظ مرتبط بقالب. تحقّق من الطلب الأصلي، أو اختر قالبًا صراحةً بعد السماح بالتعديل؛ لن يُرسل طلب يدوي بديل.</p> : null}
      {templateDraft ? <section className="mb-3 rounded-xl border border-sky-200 p-3" aria-label="معاينة بنود القالب وجلساته" data-testid="invoice-template-preview">
        <h4 className="text-sm font-bold">{templateDraft.template.name} — مراجعة بنود القالب</h4>
        {currentTemplate ? <ol className="mt-2 space-y-2">{currentTemplate.lines.map(line => <li key={currentPreview?.rows?.[line.line]?.key ?? "missing-template-row"} className="min-w-0 break-words rounded-lg bg-slate-50 p-2 text-xs">
          <p className="font-bold">{line.description} · {line.toothCode !== null ? `سن ${line.toothCode}` : line.scope ?? "سجلات دون موضع علاجي"} · {formatMoney(line.unitPriceMinor * line.quantity, currency)}</p>
          {line.priceQuote ? <p data-testid={`invoice-template-price-source-${line.line}`}>{line.priceQuote.source === "converted"
            ? `سعر محوّل مقترح من اليمني · سعر الصرف ${line.priceQuote.rate} ر.ي لكل ${currency} · تقريب لأقرب وحدة كاملة`
            : "سعر صريح مسجّل بعملة الفاتورة"}</p> : null}
          <p>الكمية: {line.quantity} · {line.sessions} جلسات</p>
          <ol className="mt-1 list-inside list-decimal">{line.sessionPlan.map(session => <li key={session.visitKey}>{session.visitTitle} — {session.title} · {session.minutes} دقيقة · بعد {session.afterDays} يوم</li>)}</ol>
          {(() => { const proof = currentPreview?.byRow.get(currentPreview?.rows?.[line.line]?.key ?? "missing-template-row"); return proof?.refusalMessage ? <p role="alert" className="mt-1 text-amber-800">{proof.refusalMessage}</p> : null; })()}
        </li>)}</ol> : <p role="status" className="mt-2 text-xs">{currentPreview?.message ?? "بانتظار المعاينة المعتمدة؛ لم يُعتمد مبلغ أو جدول بديل."}</p>}
        <button type="button" disabled={busy} onClick={() => { if (editorEnabled()) setPreviewRetry(value => value + 1); }}
          className="mt-2 min-h-11 rounded-lg border px-3 text-xs font-bold">تحديث معاينة القالب</button>
        <label className="mt-2 flex min-h-11 items-center gap-2 text-xs font-bold">
          <input type="checkbox" aria-label="راجعت بنود القالب ومبلغه وجدول جلساته" checked={templateReviewed}
            disabled={busy || templatePreviewBlocked} onChange={event => {
              if (!editorEnabled() || templatePreviewBlocked || !currentTemplate) return;
              setReviewedTemplate(event.target.checked ? { owner: previewOwner, version: currentTemplate.version } : null);
            }} />راجعت بنود القالب ومبلغه وجدول جلساته
        </label>
        <p className="mt-1 text-xs text-slate-500">الجلسات مغطاة بهذه الفاتورة ولا تعني تحصيلًا أو موافقة سريرية. يمكن قبض دفعات جزئية لاحقًا؛ هذا ليس جدول أقساط جديدًا.</p>
      </section> : null}
      {!historical && (rows.some((row) => isClinical(row.serviceId)) || templateDraft) ? <details className={workspace.planChoice}
        open={(selectionEvidence?.planChoices.length ?? 0) > 1 || selected.existingPlanId !== null}>
        <summary>ربط بخطة علاج قائمة</summary>
        <label className="block min-w-0">
          <span className="mb-1 block text-xs font-bold text-sky-900">الخطة المقصودة للأعمال الجديدة</span>
          <select aria-label="الخطة المقصودة للأعمال الجديدة" data-testid="invoice-existing-plan"
            value={selected.existingPlanId ?? ""} disabled={busy || !selectionEvidence}
            onChange={(event) => {
              const planId = event.target.value ? Number(event.target.value) : null;
              setSelection((current) => selectInvoicePlan(current, selectionOwner, planId, selectionEvidence?.planChoices ?? []) ?? current);
            }}
            className="min-h-[44px] w-full min-w-0 max-w-full rounded-xl border border-slate-200 bg-white px-2 py-2 text-xs disabled:opacity-60">
            <option value="">حسب الربط الذي تؤكده المعاينة</option>
            {selected.existingPlanId !== null && !selectionEvidence?.planChoices.some((choice) => choice.id === selected.existingPlanId)
              ? <option value={selected.existingPlanId} disabled>خطة #{selected.existingPlanId} — بانتظار إعادة التحقق</option> : null}
            {selectionEvidence?.planChoices.map((choice) => <option key={choice.id} value={choice.id} disabled={!choice.compatible}>
              خطة #{choice.id}{choice.compatible ? " — تقبل إضافة العمل" : " — لا تقبل إضافة أعمال بهذه الفاتورة"}
            </option>)}
          </select>
        </label>
        <p className={workspace.moneyNote}>اختر الخطة المقصودة إن كان للمريض أكثر من خطة. تُراجع مطابقة العمل والأسنان قبل الحفظ.</p>
        {selected.existingPlanId !== null || selected.itemIds.size > 0 ? <button type="button" disabled={busy}
          onClick={() => setSelection({ owner: selectionOwner, existingPlanId: null, itemIds: new Map() })}
          className="min-h-[44px] text-xs font-bold text-sky-800 underline">مسح اختيار الخطة والبنود</button> : null}
      </details> : null}
      {splitNotice ? (
        <p role="status" data-testid="invoice-split-notice"
          className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-900">
          {splitNotice}
        </p>
      ) : null}
      <div aria-hidden="true" className={workspace.tableHead}><span>الخدمة</span><span>الأسنان / النطاق</span><span>الطبيب</span><span>سعر الوحدة<br/>{currency}</span><span>الكمية</span><span>الإجمالي<br/>{currency}</span><span/></div>
      {displayGroups.map((group) => {
        const index = group.indices[0], row = rows[index];
        const toothCount = !historical && (modeOf(row) === "per_tooth_episode" || modeOf(row) === "multi_tooth_episode" || modeOf(row) === "tooth_surfaces") && group.teeth.length > 0;
        return <div key={group.key} data-testid={`invoice-row-${index}`} data-row-key={row.key} data-tooth={row.toothCode ?? ""}
          data-display-group={row.displayGroupId ?? ""} data-tooth-count={group.teeth.length}
          className={`${workspace.line} space-y-3 ${
            row.groupId ? "border-sky-200 border-s-4 border-s-sky-400" : "border-slate-100"}`}>
          <div className={workspace.lineGrid}>
            <div className={workspace.servicePicker}>
              <ServiceSelect
                services={selectorServices}
                value={row.serviceId ? Number(row.serviceId) : null}
                onChange={(id, srv) => {
                  if (!canEditRows.current()) return;
                  setSplitNotice(null);
                  setRows((current) => {
                    const currentRow = current.find(item => item.key === row.key);
                    if (!canEditRows.current() || !currentRow || currentRow.serviceId !== row.serviceId) return current;
                    return replaceDisplayGroupService(current, group.keys, {
                      serviceId: id ? String(id) : "", doctorId: "", manual: false, priceReason: "",
                      price: srv && invoiceOfferedPrice(srv, currency) !== null ? formatAmount(invoiceOfferedPrice(srv, currency)!, currency) : "",
                      // Clear catalogue-origin text before the empty choice loses its service identity.
                      description: srv ? srv.name : currentRow.serviceId ? "" : currentRow.description,
                    }, invoiceToothMode(srv?.category), displayContext);
                  });
                }}
                base={currency}
                catalogCurrency={currency}
                allowManual={true}
                manualSelected={row.manual === true}
                onManualSelect={() => {
                  if (!canEditRows.current()) return;
                  setSplitNotice(null);
                  setRows(current => {
                    const at = current.findIndex(item => item.key === row.key);
                    if (!canEditRows.current() || at < 0 || current[at].serviceId !== row.serviceId) return current;
                    if (!current[at].serviceId) return selectManualLine(current, at);
                    return replaceDisplayGroupService(current, group.keys, { serviceId: "", doctorId: "", manual: true,
                      description: "", price: "", priceReason: "" }, "none", displayContext);
                  });
                }}
                placeholder="— اختر الخدمة المصنفة أو بند يدوي —"
                ariaLabel="الخدمة" compact
              />
              {isClinical(row.serviceId)?<span className={workspace.unit}>{modeOf(row)==="per_tooth_episode"||modeOf(row)==="tooth_surfaces"||!historical&&modeOf(row)==="multi_tooth_episode"?"لكل سن":"للمجموعة / الحالة"}</span>:null}
            </div>
            {!row.serviceId ? (
              <input
                value={row.description}
                onChange={(event) => setRows((current) => current.map((item, i) =>
                  i === index ? { ...item, description: event.target.value } : item))}
                placeholder="وصف البند المخصص"
                aria-label="وصف البند"
                className={`${workspace.manualDescription} w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm`}
              />
            ) : null}
            <div className={workspace.linePrice}>
              <label className="text-[11px] font-bold text-slate-500">سعر الوحدة ({CURRENCY_LABEL[currency]}):</label>
              <input
                value={row.price}
                onChange={(event) => editGroup(group.keys, { price: event.target.value })}
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
              const catalogue = service ? invoiceOfferedPrice(service, currency) : null;
              const roundedZero = service?.invoiceQuotes?.[currency]?.source === "converted" && service.invoiceQuotes[currency]?.minor === 0;
              const differs = service ? roundedZero || typed !== null && (catalogue === null || typed !== catalogue) : false;
              return differs ? (
                <input
                  value={row.priceReason}
                  onChange={(event) => editGroup(group.keys, { priceReason: event.target.value })}
                  placeholder={catalogue===null?"سبب التسعير اليدوي بهذه العملة":"سبب تغيير السعر عن الدليل"}
                  aria-label="سبب تغيير السعر"
                  maxLength={300}
                  className={`${workspace.priceReason} w-full rounded-xl border border-amber-200 bg-amber-50/50 px-3 py-2 text-xs`}
                />
              ) : null;
            })()}
            {row.serviceId ? <p className="text-[10px] leading-5 text-slate-600" data-testid={`invoice-price-source-${index}`}>{serviceOf(row.serviceId)?.invoiceQuotes?.[currency]?.source === "converted"
              ? serviceOf(row.serviceId)?.invoiceQuotes?.[currency]?.minor===0
                ? `مصدر الحساب: تحويل من اليمني بسعر صرف ${serviceOf(row.serviceId)?.invoiceQuotes?.[currency]?.rate}؛ قُرّب إلى صفر ويتطلب تسعيرًا يدويًا موجبًا.`
                : `${parseAmount(row.price,currency)!==serviceOf(row.serviceId)?.invoiceQuotes?.[currency]?.minor?"سعر يدوي بالاتفاق؛ ":""}سعر محوّل مقترح من اليمني ${formatMoney(serviceOf(row.serviceId)?.invoiceQuotes?.[currency]?.minor??0,currency)} · سعر الصرف ${serviceOf(row.serviceId)?.invoiceQuotes?.[currency]?.rate} ر.ي لكل ${currency} · تقريب لأقرب وحدة كاملة`
              : serviceOf(row.serviceId) && invoiceCatalogPrice(serviceOf(row.serviceId)!, currency) !== null ? "سعر صريح مسجّل بعملة الفاتورة" : "تسعير يدوي بعملة الفاتورة — السبب إلزامي"}</p> : null}
            <div className={workspace.quantity}>
              <label className="text-[11px] font-bold text-slate-500">الكمية:</label>
              <input
                value={toothCount ? group.teeth.length : row.quantity}
                onChange={(event) => { if (!toothCount) editGroup(group.keys, { quantity: event.target.value }); }}
                aria-label="الكمية"
                disabled={toothCount || historical&&isClinical(row.serviceId)||!invoiceQuantityAllowed(serviceOf(row.serviceId)?.category??null,2)}
                title={toothCount ? "الكمية من عدد الأسنان المحددة؛ عدّلها من مخطط الأسنان" : undefined}
                inputMode="numeric"
                dir="ltr"
                className="w-16 rounded-xl border border-slate-200 bg-white px-2 py-2 text-sm font-semibold text-center"
              />
            </div>
            <div className={workspace.lineTotal} data-testid={`invoice-line-total-${index}`}><span>إجمالي البند</span><strong>{group.indices.some(one => inputProblems[one])?"راجع المبلغ":formatMoney(group.indices.reduce((sum, one) => sum + previewAmount(one), 0),currency)}</strong></div>
            {rows.length > 1 || toothCount ? (
              <button
                type="button"
                onClick={() => {
                  if (!canEditRows.current()) return;
                  setSplitNotice(null);
                  setRows(current => { const next = removeDisplayGroupRows(current, group.keys, displayContext); return next.length ? next : [blankInvoiceRow(nextRowKey())]; });
                }}
                className={workspace.removeLine}
                title="حذف البند"
                aria-label={`حذف البند ${index+1}`}
              >
                <Trash2 size={16} aria-hidden="true"/>
              </button>
            ) : null}
            {isClinical(row.serviceId) ? (
              <label className={workspace.provider}>
                <span className="mb-1 block text-[11px] font-bold text-slate-500">الطبيب المكلّف بهذا العمل</span>
                <select aria-label="الطبيب المكلّف بالبند" data-testid={`invoice-provider-${index}`} value={row.doctorId}
                  onChange={(event) => editGroup(group.keys, { doctorId: event.target.value })}
                  className="w-full rounded-xl border border-slate-200 bg-white px-2.5 py-2 text-xs">
                  <option value="">غير محدد</option>
                  {doctors.map((doctor) => <option key={doctor.id} value={doctor.id}>{doctor.name}</option>)}
                </select>
                {!doctorCatalog ? <span className="mt-1 block text-[10px] text-slate-500">قائمة الأطباء لم تُتحقق بعد؛ لا يُعيّن طبيب تلقائيًا.</span> : null}
              </label>
            ) : null}
            {isClinical(row.serviceId)?<div className={workspace.toothGroup}>{toothControl(row, index, group)}</div>:null}
          </div>
          {(() => {
            const details = group.indices.map((index) => { const row = rows[index]; return <Fragment key={row.key}>
          {group.grouped ? <div className="flex items-center justify-between gap-2 text-xs">
            <strong>{modeOf(row) === "tooth_surfaces" ? selectionLabel(modeOf(row), row) : `سن ${row.toothCode}`}</strong>
            <button type="button" data-testid={`invoice-split-tooth-${index}`}
              onClick={() => { if (canEditRows.current()) { setSplitNotice(null); setRows(current => splitDisplayGroupRow(current, row.key)); } }}
              className="min-h-11 rounded-lg border border-slate-200 px-3">فصل سن {row.toothCode}</button>
          </div> : null}
          {inputProblems[index] ? <p role="alert" data-testid={`invoice-input-problem-${index}`}
            className="text-[11px] font-bold text-rose-800">{inputProblems[index]}</p> : null}
          {toothProblems[index] ? (
            <p data-testid={`invoice-tooth-problem-${index}`} className="text-[11px] font-bold text-amber-800">
              {toothProblems[index]}
            </p>
          ) : null}
          {isClinical(row.serviceId) && (() => {
            const itemId = selected.itemIds.get(row.key) ?? null;
            const choices = (selectionEvidence?.itemChoices.get(row.key) ?? []).filter((choice) =>
              (selected.existingPlanId === null || choice.planId === selected.existingPlanId)
              && (!row.caseId || choice.clinicalCaseId === null || choice.clinicalCaseId === Number(row.caseId)));
            if (!choices.length && itemId === null) return null;
            return <label className="block min-w-0 rounded-lg border border-sky-200 bg-white p-2">
              <span className="mb-1 block text-xs font-bold text-slate-700">بند الخطة المقصود لهذا العمل</span>
              <select aria-label="بند الخطة المقصود" data-testid={`invoice-plan-item-${index}`}
                value={itemId ?? ""} disabled={busy || !selectionEvidence}
                onChange={(event) => {
                  const next = event.target.value ? Number(event.target.value) : null;
                  setSelection((current) => selectInvoiceItem(current, selectionOwner, row.key, next, choices) ?? current);
                }}
                className="min-h-[44px] w-full min-w-0 max-w-full rounded-xl border border-slate-200 bg-white px-2 py-2 text-xs disabled:opacity-60">
                <option value="">دون اختيار صريح — يجب حسم تعدد البنود</option>
                {itemId !== null && !choices.some((choice) => choice.id === itemId)
                  ? <option value={itemId} disabled>بند #{itemId} — يحتاج إعادة التحقق</option> : null}
                {choices.map((choice) => <option key={choice.id} value={choice.id}>
                  بند #{choice.id} · خطة #{choice.planId}{choice.clinicalCaseId !== null ? ` · حالة #${choice.clinicalCaseId}` : ""}
                </option>)}
              </select>
              <span className="mt-1 block text-[11px] text-slate-500">الاختيار لا يتجاوز الفواتير السابقة أو الاتفاق التاريخي؛ يعيد الخادم التحقق عند الحفظ.</span>
            </label>;
          })()}
          {(() => {
            if(historical){const indexInRequest=rows.slice(0,index).filter(one=>one.serviceId||one.description.trim()).length;
              const proof=historicalEvidence?.lines[indexInRequest];
              return <details className={workspace.linkProof} open={!proof||proof.case.mode==="choose"}>
                <summary><Link2 size={14} aria-hidden="true"/> {proof?"ربط الخطة والحالة جاهز للمراجعة":"مراجعة ربط العلاج"}</summary>
                <div role="status" data-testid={`historical-clinical-preview-${index}`} data-preview-state={proof?"ready":currentHistorical?.status??"pending"} className="text-xs leading-6">
                {proof?<><p>{proof.planId?`إضافة بند للخطة #${proof.planId}`:"بند ضمن خطة علاج جديدة"} · {proof.case.mode==="existing"?`الحالة القائمة #${proof.case.id}`:proof.case.mode==="new"?"حالة تخصصية للعلاج السابق":proof.case.mode==="choose"?"اختر الحالة المقصودة":"علاج مغطّى بالاتفاق"}</p>
                  {proof.case.mode==="choose"?<select aria-label="الحالة التاريخية" value={row.caseId} onChange={event=>setRows(current=>current.map((one,i)=>i===index?{...one,caseId:event.target.value}:one))}><option value="">اختر الحالة</option>{proof.case.options.map(option=><option key={option.id} value={option.id}>{option.title}</option>)}</select>:null}</>
                  :historicalParsed&&!historicalParsed.ok?historicalParsed.message:currentHistorical?.message??"أكمل الحقائق التاريخية لمعاينة الربط."}
                {currentHistorical?.status==="unavailable"?<button type="button" className="mr-2 underline" onClick={()=>setPreviewRetry(value=>value+1)}>إعادة المعاينة</button>:null}
              </div></details>;
            }
            if (!isClinical(row.serviceId)) return null;
            if (inputProblems[index]) return <div role="status" data-testid={`invoice-clinical-preview-${index}`} data-preview-state="invalid"
              className="text-[11px] font-bold text-rose-800">صحّح بيانات البند قبل معاينة الربط السريري.</div>;
            const evidence = previewForRow(currentPreview, previewKey, row.key);
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
              <details className={workspace.linkProof} open={evidence.status!=="ready"||preview.case?.mode==="choose"}>
                <summary><Link2 size={14} aria-hidden="true"/> {group.grouped ? `سن ${row.toothCode} · ` : ""}{evidence.status==="ready"?"ربط الخطة والحالة جاهز للمراجعة":"مراجعة ربط العلاج"}</summary>
                <div role="status" data-testid={`invoice-clinical-preview-${index}`} data-preview-state={evidence.status} className="text-xs leading-6">
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
              </div></details>
            );
          })()}
          </Fragment>; });
            if (!group.grouped) return details;
            const needsDecision = group.indices.some(one => inputProblems[one] || toothProblems[one]
              || previewForRow(currentPreview, previewKey, rows[one].key).status === "refused"
              || currentPreview?.byRow.get(rows[one].key)?.case?.mode === "choose"
              || (selectionEvidence?.itemChoices.get(rows[one].key)?.length ?? 0) > 1);
            return <details className="text-xs" data-testid={`invoice-group-details-${index}`} open={needsDecision}>
              <summary className="cursor-pointer font-bold text-sky-800">تفاصيل الأسنان / فصل سن بطبيب أو سعر مختلف</summary>
              <div className="mt-2 space-y-2">{details}</div>
            </details>;
          })()}
        </div>;
      })}

      <button type="button"
        onClick={() => { if (canEditRows.current()) setRows((current) => [...current, blankInvoiceRow(nextRowKey())]); }}
        className={workspace.addLine} aria-label="+ بند آخر">
        <Plus size={17} aria-hidden="true"/> إضافة خدمة علاجية
      </button>
      </div>
      <aside id={summaryId} className={workspace.summary} aria-label="ملخص الاتفاق والسداد" data-testid="invoice-financial-summary">
      <section className={workspace.summaryCard}>
        <h4><Calculator size={19} aria-hidden="true"/> ملخص الاتفاق المالي</h4>
        <dl>
          <div><dt>إجمالي الخدمات</dt><dd>{totalInvalid||inputProblems.some(Boolean)?"راجع البنود":formatMoney(total,currency)}</dd></div>
          <div className={workspace.discountRow}><dt><label htmlFor={`${summaryId}-discount`}>خصم الاتفاق</label></dt><dd>
            <input id={`${summaryId}-discount`} value={discount} onChange={event=>{if(canEditRows.current())setDiscount(event.target.value);}} inputMode="decimal" dir="ltr" placeholder="0" aria-label="الخصم"/>
          </dd></div>
          {discountMinor>0?<div className={workspace.discountReason}><dt>سبب الخصم</dt><dd><input value={discountReason} onChange={event=>{if(canEditRows.current())setDiscountReason(event.target.value);}} aria-label="سبب الخصم" maxLength={300} placeholder="سبب الخصم المعتمد"/></dd></div>:null}
          <div className={workspace.net}><dt>صافي المبلغ المتفق عليه</dt><dd>{totalInvalid||inputProblems.some(Boolean)||templateDraft&&!currentTemplate?"بانتظار اكتمال البنود":formatMoney(net,currency)}</dd></div>
          {historical?<div><dt><label htmlFor={`${summaryId}-paid`}>المدفوع قبل النظام</label></dt><dd><input id={`${summaryId}-paid`} aria-label="المدفوع قبل النظام" value={historicalPaid} onChange={event=>{if(canEditRows.current())setHistoricalPaid(event.target.value);}} inputMode="decimal" dir="ltr" placeholder="0"/></dd></div>
            :null}
          {historical?<div className={workspace.remaining}><dt>المتبقي التاريخي الافتتاحي</dt><dd>{totalInvalid||inputProblems.some(Boolean)||historical&&historicalRemaining===null?"راجع المبالغ":formatMoney(historicalRemaining??0,currency)}</dd></div>:null}
        </dl>
        {historicalRemaining===null&&historical?<p role="alert">راجع المدفوع السابق؛ لا يتجاوز المتفق عليه بعد الخصم.</p>:null}
        <p className={workspace.moneyNote}>{historical?"المدفوع قبل النظام للتوثيق فقط؛ دون سند قبض أو حركة صندوق.":"حفظ الفاتورة لا يثبت تحصيلًا. التحصيل الفعلي بسند قبض."}</p>
      </section>
      {historicalEvidence&&historicalEvidence.remainingMinor!==historicalRemaining?<section className={workspace.accountContext}>
        <h4>الرصيد السابق القائم والاتفاق الجديد</h4>
        <p>كامل الرصيد السابق بعد الاتفاق: <strong>{formatMoney(historicalEvidence.remainingMinor,currency)}</strong></p>
        <p>المستحق الفعلي للحساب: <strong>{formatMoney(historicalEvidence.accountDueMinor,currency)}</strong></p>
        <p>جدول السداد يغطي كامل الرصيد السابق بهذه العملة.</p>
      </section>:null}
      <DebtRepaymentEditor compact value={repaymentDraft} onChange={value=>{if(editorEnabled())setRepaymentDraft(value);}}
        currency={currency} remainingMinor={debtRemaining} today={clinicDateString(new Date(),CLINIC_ZONE_FALLBACK)} disabled={busy||commandLocked||!canSubmit} />

      </aside>
      <div className={workspace.saveActions}>
      {blockedLines.length > 0 ? (
        <p role="alert" data-testid="invoice-save-blocked"
          className="mb-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-900">
          لا يمكن حفظ الفاتورة قبل تحديد السن من مخطط الأسنان — {blockedLines.length === 1 ? `البند ${blockedLines[0]}` : `البنود ${blockedLines.join("، ")}`}.
        </p>
      ) : null}
      <button
        onClick={() => {
          if(historical){
            if(!formSession||!historicalEvidence||!historicalParsed?.ok||!repayment.ok||clinicalPreviewBlocked||!editorEnabled()||busy||commandLocked)return;
            const body={...historicalSource,repaymentTerms:repayment.value,repaymentRemainingMinor:historicalEvidence.remainingMinor,repaymentVersion:historicalEvidence.scheduleVersion,repaymentSourceHash:historicalEvidence.sourceHash};
            const input={...historicalParsed.value,repaymentTerms:repayment.value,repaymentRemainingMinor:historicalEvidence.remainingMinor,repaymentVersion:historicalEvidence.scheduleVersion,repaymentSourceHash:historicalEvidence.sourceHash};
            void submitCommand(body,{kind:"historical",owner:authority,patientId,currency,createdBy:formSession.username,input,preview:historicalEvidence});return;
          }
          const retained = commandRef.current?.original ?? recovery?.original;
          const retainedTemplate = retained && invoiceCommandHasTemplate(retained.lease);
          if (!templateDraft && retainedTemplate) return;
          if (!canSubmit || !editorEnabled() || busy || !repayment.ok || totalInvalid || discountInvalid || blockedLines.length > 0 || inputProblems.some(Boolean) || clinicalPreviewBlocked || templatePreviewBlocked || !templateReviewed) return;
          const body = {
            currency,...(visitId!==undefined?{visitId}:{}),
            repaymentTerms:repayment.value,
            existingPlanId: selected.existingPlanId,
            ...(templateDraft && currentTemplate ? { templateSelection: { ...templateDraft.selection, version: currentTemplate.version } } : {}),
            discount,
            discountReason,
            items: rows
              .filter((row) => row.serviceId || row.description.trim())
              .map((row) => ({
                serviceId: row.serviceId ? Number(row.serviceId) : undefined,
                catalogPriceMinor: serviceOf(row.serviceId) ? invoiceCatalogPrice(serviceOf(row.serviceId)!, currency) : undefined,
        priceQuote: serviceOf(row.serviceId)?.invoiceQuotes?.[currency],
                doctorId: row.doctorId ? Number(row.doctorId) : undefined,
                description: row.description,
                price: row.price,
                priceReason: row.priceReason,
                quantity: Number(row.quantity) || 1,
                ...toothPayload(modeOf(row), row),
                caseId: isClinical(row.serviceId) && row.caseId ? Number(row.caseId) : undefined,
                planItemId: isClinical(row.serviceId) ? selected.itemIds.get(row.key) ?? null : null,
              })),
            idempotencyKey,
          };
          const expected = expectedReceipt(); if (expected) void submitCommand(body, expected);
        }}
        disabled={!canSubmit || busy || !repayment.ok || commandLocked || (!templateDraft && Boolean((commandState || recovery) && invoiceCommandHasTemplate((commandState ?? recovery)!.original.lease))) || totalInvalid || discountInvalid || blockedLines.length > 0 || inputProblems.some(Boolean) || clinicalPreviewBlocked || templatePreviewBlocked || !templateReviewed || (!templateDraft && !rows.some((row) => row.serviceId || row.description.trim()))}
        className={workspace.save}
      >
        <Save size={19} aria-hidden="true"/>{historical ? "احفظ الاتفاق التاريخي" : "احفظ الفاتورة"}
      </button>
      {(historical ? currentHistorical : currentPreview)?.status === "unavailable" || (historical ? currentHistorical : currentPreview)?.status === "refused" ? <button type="button" disabled={busy||commandLocked||!canSubmit} className={workspace.review} onClick={()=>{if(editorEnabled()){onReloadCatalogue();setPreviewRetry(value=>value+1);}}}>تحديث الأسعار والمعاينة</button> : null}
      {((historical ? currentHistorical : currentPreview)?.message || inputProblems.some(Boolean)) ? <p role="alert" data-testid="invoice-save-reason" className="text-sm font-bold text-rose-800">{inputProblems.find(Boolean) || (historical ? currentHistorical : currentPreview)?.message}</p> : null}
      </div>
      </div>
      </fieldset>
      {discountInvalid ? <p role="alert" className="mt-2 text-xs text-red-700">اكتب خصمًا صحيحًا قبل الحفظ؛ لم يُرسل الطلب.</p> : null}
      {totalInvalid ? <p role="alert" className="mt-2 text-xs text-red-700">مجموع البنود خارج النطاق الآمن؛ راجع البنود قبل الحفظ.</p> : null}
      </div>
      {dialogRow ? (
        <ToothSelectionDialog
          key={`${patientId}:${dialogRow.key}:${dialogRow.serviceId}:${modeOf(dialogRow)}`}
          patientId={patientId}
          mode={modeOf(dialogRow)}
          serviceName={serviceOf(dialogRow.serviceId)?.name ?? dialogRow.description}
          initial={!historical && dialogGroup ? selectionOfDisplayGroup(dialogGroup) : selectionOfRow(dialogRow)}
          groupedInvoice={!historical}
          purpose={historical ? "legacy_agreement" : "invoice"}
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
function OpeningForm({ patientId, base, busy, canEdit, openings, onSubmit, onClear }: {
  patientId: number;
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
      {existing && canEdit ? <OpeningCorrectionPreview key={`${currency}:${amount}`} patientId={patientId} currency={currency} amount={amount} /> : null}

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
