import { isCurrency } from "./money";
import type { FinancialCommand } from "./financial-command-journal";
import { agreementReconciliationIntentText, type AgreementReconciliationAmounts, type AgreementReconciliationCommand, type AgreementReconciliationReceipt, type AgreementReconciliationView } from "./agreement-reconciliation";

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const id = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
const money = (v: unknown): v is number => Number.isSafeInteger(v);
const nonnegative = (v: unknown): v is number => money(v) && v >= 0;
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const key = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9._:-]{8,128}$/.test(v);

export interface ReconciliationDraft {
  actor: string;
  patientId: number;
  planId: number;
  body: AgreementReconciliationCommand;
}

function amounts(v: unknown): v is AgreementReconciliationAmounts {
  return object(v) && nonnegative(v.agreedMinor)
    && ["billedPrincipalMinor", "unbilledPrincipalMinor", "dueNowMinor"].every(k => v[k] === null || nonnegative(v[k]))
    && ["paidMinor", "remainingMinor"].every(k => v[k] === null || money(v[k]));
}
function receipt(v: unknown, planId: number, patientId: number): v is AgreementReconciliationReceipt {
  if (!(object(v) && id(v.id) && v.planId === planId && v.patientId === patientId
    && key(v.operationKey) && hash(v.expectedSourceHash) && (v.deltaInvoiceId === null || id(v.deltaInvoiceId))
    && amounts(v.amounts) && v.cashMovementMinor === 0)) return false;
  const a = v.amounts;
  return Object.values(a).every(n => n !== null)
    && BigInt(a.agreedMinor) - BigInt(a.billedPrincipalMinor!) === BigInt(a.unbilledPrincipalMinor!)
    && (a.unbilledPrincipalMinor === 0 ? v.deltaInvoiceId === null : id(v.deltaInvoiceId));
}
export function readReconciliationView(v: unknown, planId: number, patientId: number): AgreementReconciliationView | null {
  if (!object(v) || v.planId !== planId || v.patientId !== patientId || !id(planId) || !id(patientId)
    || !isCurrency(v.currency) || !hash(v.sourceHash) || !amounts(v.amounts)
    || !["preview", "reconciled", "review_required"].includes(String(v.status)) || typeof v.canConfirm !== "boolean"
    || !Array.isArray(v.blockers) || !v.blockers.every(b => object(b) && typeof b.code === "string" && typeof b.message === "string")
    || !Array.isArray(v.sourceInvoices) || v.sourceInvoices.length > 1000
    || !v.sourceInvoices.every(s => object(s) && id(s.invoiceId) && typeof s.invoiceNumber === "string"
      && nonnegative(s.principalMinor) && money(s.settledMinor) && money(s.remainingMinor))) return null;
  if (new Set(v.sourceInvoices.map(s => s.invoiceId)).size !== v.sourceInvoices.length) return null;
  if (v.reconciliation !== null && !receipt(v.reconciliation, planId, patientId)) return null;
  if (v.status === "reconciled" && !v.reconciliation || v.status !== "reconciled" && v.reconciliation !== null) return null;
  if (v.commission !== null && (!object(v.commission) || !id(v.commission.doctorId)
    || typeof v.commission.doctorName !== "string" || typeof v.commission.percent !== "number"
    || !Number.isFinite(v.commission.percent) || v.commission.percent < 0 || v.commission.percent > 100
    || !nonnegative(v.commission.incrementalAccruedMinor))) return null;
  if (v.canConfirm) {
    const a = v.amounts;
    if (v.status !== "preview" || v.blockers.length || (v.commission === null && a.unbilledPrincipalMinor !== 0)
      || Object.values(a).some(n => n === null)
      || BigInt(a.agreedMinor) - BigInt(a.billedPrincipalMinor!) !== BigInt(a.unbilledPrincipalMinor!)) return null;
    if (v.sourceInvoices.reduce((sum, s) => sum + BigInt(s.principalMinor), 0n) !== BigInt(a.billedPrincipalMinor!)
      || v.sourceInvoices.reduce((sum, s) => sum + BigInt(s.settledMinor), 0n) !== BigInt(a.paidMinor!)) return null;
  }
  return v as unknown as AgreementReconciliationView;
}

export function reconciliationCommand(draft: ReconciliationDraft): FinancialCommand {
  const serialized = JSON.stringify(draft);
  return { kind: "agreement-reconciliation", key: draft.body.operationKey, original: serialized, payload: serialized };
}
export function restoreReconciliationCommand(command: FinancialCommand, patientId: number, actor: string): ReconciliationDraft | null {
  try {
    if (command.kind !== "agreement-reconciliation" || command.payload !== command.original) return null;
    const d: unknown = JSON.parse(command.original);
    if (!object(d) || d.actor !== actor || d.patientId !== patientId || !id(d.planId) || !id(d.patientId)
      || !object(d.body) || d.body.operationKey !== command.key || !key(command.key) || !hash(d.body.expectedSourceHash)
      || typeof d.body.reason !== "string" || d.body.reason.trim().length < 3 || d.body.reason.length > 300) return null;
    return d as unknown as ReconciliationDraft;
  } catch { return null; }
}
export function readReconciliationReceipt(v: unknown, draft: ReconciliationDraft): AgreementReconciliationReceipt | null {
  return receipt(v, draft.planId, draft.patientId) && v.operationKey === draft.body.operationKey
    && v.expectedSourceHash === draft.body.expectedSourceHash ? v : null;
}
export async function reconciliationRequestHash(draft: ReconciliationDraft): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(agreementReconciliationIntentText(draft.planId, draft.body)));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
}
export async function isReconciliationRejection(v: unknown, draft: ReconciliationDraft): Promise<boolean> {
  return object(v) && v.state === "rejected" && v.code === "agreement_source_changed"
    && v.planId === draft.planId && v.patientId === draft.patientId && v.operationKey === draft.body.operationKey
    && v.expectedSourceHash === draft.body.expectedSourceHash && hash(v.observedSourceHash)
    && typeof v.rejectedAt === "string" && Number.isFinite(Date.parse(v.rejectedAt))
    && v.requestHash === await reconciliationRequestHash(draft);
}
