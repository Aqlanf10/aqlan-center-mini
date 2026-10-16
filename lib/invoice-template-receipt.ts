import type { Invoice, InvoiceItem } from "./db";
import type { LineLink } from "./invoice-linkage-db";
import { LINKAGE_SPECIALTY_LABEL, type LinkageSpecialty } from "./invoice-clinical-linkage";
import { isValidTooth, normalizeSurfaces } from "./dental";
import { isCurrency, type Currency } from "./money";
import { validateDebtRepaymentTerms, type DebtRepaymentTerms } from "./debt-installments";

type ExpectedPlanItem = { readonly mode: "none" | "new" } | { readonly mode: "existing"; readonly id: number };
type ExpectedCase = { readonly mode: "none" | "new" | "bridge" } | { readonly mode: "existing"; readonly id: number };

/** Normalized submitted values and the accepted preview, captured before the first POST. */
export interface InvoiceTemplateReceiptExpectedLine {
  readonly source: "manual" | "template";
  readonly serviceId: number | null;
  readonly doctorId: number | null;
  readonly description: string;
  readonly quantity: number;
  readonly unitPriceMinor: number;
  readonly toothCode: number | null;
  readonly surfaces: string | null;
  readonly kind: LineLink["kind"];
  readonly specialty: LinkageSpecialty | null;
  readonly scheduled: boolean;
  readonly planItem: ExpectedPlanItem;
  readonly case: ExpectedCase;
}

export interface InvoiceTemplateReceiptExpectation {
  readonly visitId?:number;
  /** Reference identity of this form/authority lifetime, not a patient ID or request string. */
  readonly owner: object;
  readonly patientId: number;
  readonly currency: Currency;
  /** Submitted discount; the canonical writer caps it at the invoice total. */
  readonly discountMinor: number;
  readonly note: string | null;
  /** Explicitly selected/adopted plan, or null when its identity was not known before save. */
  readonly expectedPlanId: number | null;
  readonly lines: readonly InvoiceTemplateReceiptExpectedLine[];
  readonly repaymentTerms?: DebtRepaymentTerms;
}

export interface AcceptedInvoiceTemplateReceipt {
  invoice: Invoice;
  clinical: { planId: number | null; links: LineLink[] };
  replayed: boolean;
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object"
  && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const integer = (value: unknown, min: number, max: number): value is number => typeof value === "number"
  && Number.isSafeInteger(value) && value >= min && value <= max;
const id = (value: unknown): value is number => integer(value, 1, 2_147_483_647);
const nullableId = (value: unknown): value is number | null => value === null || id(value);
const minor = (value: unknown): value is number => integer(value, 0, Number.MAX_SAFE_INTEGER);
const nullableText = (value: unknown): value is string | null => value === null || typeof value === "string";
const nonemptyText = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const tooth = (value: unknown): value is number | null => value === null || id(value) && isValidTooth(value);
const surfaces = (value: unknown): value is string | null => value === null
  || typeof value === "string" && value.length > 0 && normalizeSurfaces(value) === value;
const specialty = (value: unknown): value is LinkageSpecialty => typeof value === "string"
  && Object.hasOwn(LINKAGE_SPECIALTY_LABEL, value);
const billingStatus = (value: unknown): value is NonNullable<InvoiceItem["billingStatus"]> =>
  value === "unbilled" || value === "billed" || value === "included_in_package"
  || value === "waived" || value === "needs_financial_review";

function expectedLine(value: InvoiceTemplateReceiptExpectedLine): boolean {
  if (!object(value) || (value.source !== "manual" && value.source !== "template")
    || !nullableId(value.serviceId) || !nullableId(value.doctorId) || !nonemptyText(value.description)
    || !integer(value.quantity, 1, 999) || !minor(value.unitPriceMinor) || !tooth(value.toothCode) || !surfaces(value.surfaces)
    || (value.kind !== "financial" && value.kind !== "clinical") || typeof value.scheduled !== "boolean"
    || !object(value.planItem) || !object(value.case)) return false;
  if (value.planItem.mode !== "none" && value.planItem.mode !== "new" && value.planItem.mode !== "existing"
    || value.planItem.mode === "existing" && !id(value.planItem.id)
    || value.case.mode !== "none" && value.case.mode !== "new" && value.case.mode !== "existing" && value.case.mode !== "bridge"
    || value.case.mode === "existing" && !id(value.case.id)) return false;
  if (value.kind === "financial" ? value.specialty !== null || value.case.mode !== "none"
    : !specialty(value.specialty) || value.serviceId === null || !value.scheduled
      // Reused restorative work can retain a case even though needsCase=false.
      // Its exact ID comes from the accepted matching item candidate, never a new case decision.
      || (value.specialty === "restorative" ? value.case.mode !== "none"
        && !(value.source === "manual" && value.planItem.mode === "existing" && value.case.mode === "existing")
        : value.case.mode === "none")) return false;
  if (value.scheduled !== (value.planItem.mode !== "none")
    || !value.scheduled && (value.toothCode !== null || value.surfaces !== null)
    || value.source === "template" && (!value.scheduled || value.planItem.mode !== "new" || value.serviceId === null)
    || value.source === "manual" && value.kind === "financial" && value.scheduled
    || value.case.mode === "bridge" && value.specialty !== "orthodontics") return false;
  return true;
}

/**
 * Decode the complete canonical POST acknowledgement before clearing a retained command.
 * The expectation must stay with the immutable command across retries, never be rebuilt
 * from a refreshed catalogue. The API does not echo template/version or a session plan;
 * those remain bound by the server's exact-command replay, not invented client fields.
 * HTTP status/redirect checks are the caller's responsibility.
 */
export function readInvoiceTemplateReceipt(
  payload: unknown, expected: InvoiceTemplateReceiptExpectation, currentOwner: object,
): AcceptedInvoiceTemplateReceipt | null {
  return readReceipt(payload,expected,currentOwner,true);
}
export function readInvoiceCommandReceipt(
  payload: unknown, expected: InvoiceTemplateReceiptExpectation, currentOwner: object,
): AcceptedInvoiceTemplateReceipt | null {
  return readReceipt(payload,expected,currentOwner,false);
}
function readReceipt(payload:unknown,expected:InvoiceTemplateReceiptExpectation,currentOwner:object,requireTemplate:boolean):AcceptedInvoiceTemplateReceipt|null {
  if (!object(expected) || expected.owner !== currentOwner || expected.owner === null || typeof expected.owner !== "object"
    || !id(expected.patientId) || expected.visitId!==undefined&&!id(expected.visitId) || !isCurrency(expected.currency) || !minor(expected.discountMinor)
    || !nullableText(expected.note) || !nullableId(expected.expectedPlanId)
    || !Array.isArray(expected.lines) || expected.lines.length === 0 || expected.lines.length > 40
    || !Array.from(expected.lines).every(expectedLine) || requireTemplate && !expected.lines.some((line) => line.source === "template")) return null;
  const expectsCreatedItems = expected.lines.some(line=>line.planItem.mode==="new");
  if (!object(payload) || !id(payload.id) || !nonemptyText(payload.invoiceNumber) || payload.patientId !== expected.patientId
    || typeof payload.patientName !== "string" || (payload.status !== "open" && payload.status !== "paid" && payload.status !== "cancelled")
    || payload.baseCurrency !== expected.currency || !minor(payload.totalMinor) || !minor(payload.discountMinor)
    || payload.note !== expected.note || typeof payload.createdAt !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(payload.createdAt)
    || !Number.isFinite(Date.parse(payload.createdAt)) || new Date(payload.createdAt).toISOString() !== payload.createdAt
    || expected.visitId!==undefined&&payload.visitId!==expected.visitId
    || typeof payload.replayed !== "boolean"
    || !Array.isArray(payload.items) || payload.items.length !== expected.lines.length
    || !object(payload.clinical) || !nullableId(payload.clinical.planId) || (expectsCreatedItems ? !id(payload.clinical.planId) : payload.clinical.planId !== null)
    || expectsCreatedItems && expected.expectedPlanId !== null && payload.clinical.planId !== expected.expectedPlanId
    || !Array.isArray(payload.clinical.links) || payload.clinical.links.length !== expected.lines.length) return null;

  const items: InvoiceItem[] = [];
  const links: LineLink[] = [];
  const itemIds = new Set<number>();
  const planItemIds = new Set<number>();
  const createdCaseIds = new Map<number, LinkageSpecialty>();
  const existingCaseIds = new Set(expected.lines.flatMap((line) => line.case.mode === "existing" ? [line.case.id] : []));
  let totalMinor = 0;
  for (const [index, line] of expected.lines.entries()) {
    const item = payload.items[index];
    const link = payload.clinical.links[index];
    const lineTotal = line.quantity * line.unitPriceMinor;
    totalMinor += lineTotal;
    if (!minor(lineTotal) || !minor(totalMinor) || !object(item) || !id(item.id) || itemIds.has(item.id)
      || item.serviceId !== line.serviceId || !nullableId(item.doctorId)
      || item.description !== line.description || item.quantity !== line.quantity || item.unitPriceMinor !== line.unitPriceMinor
      || item.totalMinor !== lineTotal || !nullableId(item.planItemId) || !nullableId(item.caseId)
      || item.toothCode !== line.toothCode || item.surfaces !== line.surfaces || !nullableId(item.originInvoiceId)
      || !(item.billingStatus === null || billingStatus(item.billingStatus)) || typeof item.financialReviewRequired !== "boolean"
      || item.financialReviewRequired !== (item.billingStatus === "needs_financial_review")) return null;
    // A previously assigned doctor may be inherited only for explicitly reused manual work.
    if (item.doctorId !== line.doctorId && !(line.source === "manual" && line.planItem.mode === "existing" && line.doctorId === null)) return null;
    if (!object(link) || link.line !== index || link.kind !== line.kind || link.specialty !== line.specialty
      || !nullableId(link.planItemId) || !nullableId(link.caseId) || typeof link.planItemCreated !== "boolean"
      || typeof link.caseCreated !== "boolean" || (link.scheduled !== undefined && typeof link.scheduled !== "boolean")
      || (link.scheduled === true) !== line.scheduled || item.planItemId !== link.planItemId || item.caseId !== link.caseId
      || payload.replayed && (link.planItemCreated || link.caseCreated)) return null;
    if (line.planItem.mode === "none") {
      if (link.planItemId !== null || link.planItemCreated || item.originInvoiceId !== null
        || item.billingStatus !== null || item.financialReviewRequired) return null;
    } else {
      if (!id(link.planItemId) || planItemIds.has(link.planItemId) || item.billingStatus === null
        || item.doctorId === null && !item.financialReviewRequired) return null;
      if (line.planItem.mode === "existing") {
        if (link.planItemId !== line.planItem.id || link.planItemCreated || item.originInvoiceId !== null) return null;
      } else if (link.planItemCreated !== !payload.replayed || item.originInvoiceId !== payload.id) return null;
      planItemIds.add(link.planItemId);
    }
    if (line.case.mode === "none") {
      if (link.caseId !== null || link.caseCreated) return null;
    } else if (line.case.mode === "existing") {
      if (link.caseId !== line.case.id || link.caseCreated) return null;
    } else {
      if (!id(link.caseId) || line.specialty === null || existingCaseIds.has(link.caseId)) return null;
      const priorSpecialty = createdCaseIds.get(link.caseId);
      if (priorSpecialty !== undefined && priorSpecialty !== line.specialty
        || !payload.replayed && link.caseCreated !== (priorSpecialty === undefined)) return null;
      createdCaseIds.set(link.caseId, line.specialty);
    }
    itemIds.add(item.id);
    items.push({ id: item.id, serviceId: line.serviceId, doctorId: item.doctorId, description: line.description,
      quantity: line.quantity, unitPriceMinor: line.unitPriceMinor, totalMinor: lineTotal, planItemId: item.planItemId,
      caseId: item.caseId, toothCode: line.toothCode, surfaces: line.surfaces, originInvoiceId: item.originInvoiceId,
      billingStatus: item.billingStatus, financialReviewRequired: item.financialReviewRequired });
    links.push({ line: index, kind: line.kind, specialty: line.specialty, planItemId: link.planItemId,
      planItemCreated: link.planItemCreated, caseId: link.caseId, caseCreated: link.caseCreated,
      ...(link.scheduled === undefined ? {} : { scheduled: link.scheduled }) });
  }
  if (payload.totalMinor !== totalMinor || payload.discountMinor !== Math.min(expected.discountMinor, totalMinor)) return null;
  if(expected.repaymentTerms){
    if(!object(payload.repayment)||!id(payload.repayment.arrangementId)||!id(payload.repayment.revisionId)||payload.repayment.version!==1)return null;
    const terms=validateDebtRepaymentTerms(payload.repayment.terms,totalMinor-payload.discountMinor);
    if(!terms.ok||JSON.stringify(terms.value)!==JSON.stringify(expected.repaymentTerms))return null;
  }
  return {
    invoice: { id: payload.id, invoiceNumber: payload.invoiceNumber, patientId: expected.patientId, patientName: payload.patientName,
      status: payload.status, totalMinor, discountMinor: payload.discountMinor, baseCurrency: expected.currency,
      note: expected.note, createdAt: payload.createdAt, items },
    clinical: { planId: payload.clinical.planId, links }, replayed: payload.replayed,
  };
}
