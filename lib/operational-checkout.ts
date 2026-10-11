import { canReadReceptionHandoff, readReceptionHandoffs, type ReceptionHandoff, type ReceptionHandoffSnapshot } from "./reception-handoff";
import { isCurrency, type Currency } from "./money";

/** Operational completion never substitutes for a clinical signature. */
export interface VisitReceivable {
  invoiceId: number;
  currency: Currency;
  status: "open" | "paid" | "cancelled";
  netMinor: number;
  paidMinor: number;
}
export interface OperationalHandoff {
  visitId: number;
  patientId: number | null;
  patientName: string;
  patientNumber: string | null;
  finishedAt: string;
  finishVersion: string;
  dateBasis: "finished" | "arrival_fallback";
  signedAt: null;
  status: "pending" | "handled" | "deferred";
  handledReason: string | null;
  financialReviewRequired?: boolean;
  visitInvoiceSettled?: boolean;
}
export type CheckoutQueueRow = (ReceptionHandoff & { eligibility: "signed"; eligibleAt: string })
  | (OperationalHandoff & { eligibility: "finished_unsigned"; eligibleAt: string });
export interface OperationalCheckoutSnapshot extends Omit<ReceptionHandoffSnapshot, "items"> {
  version: 1;
  items: CheckoutQueueRow[];
}
export interface OperationalCheckoutRead {
  version: 1;
  owner: { username: string; role: string };
  item: OperationalHandoff;
  receivable: VisitReceivable | null;
}
const record = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);
const id = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x > 0;
const minor = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x);
export const isFinishVersion = (x: unknown): x is string => typeof x === "string"
  && /^(finished|arrival_fallback):\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(x);

export function readVisitReceivable(x: unknown): VisitReceivable | null | undefined {
  if (x === null) return null;
  if (!record(x) || !id(x.invoiceId) || !isCurrency(x.currency)
    || (x.status !== "open" && x.status !== "paid" && x.status !== "cancelled")
    || !minor(x.netMinor) || x.netMinor < 0 || !minor(x.paidMinor)) return undefined;
  return { invoiceId: x.invoiceId, currency: x.currency, status: x.status, netMinor: x.netMinor, paidMinor: x.paidMinor };
}
/** Reference-aware: other account payments/debts cannot establish this visit's clearance. */
export function receivableNotIncreased(before: VisitReceivable | null, now: VisitReceivable | null): boolean {
  if (now === null) return before === null;
  if (before === null || before.invoiceId !== now.invoiceId || before.currency !== now.currency) return false;
  // A newly reviewed cancellation is a follow-up decision, never proof of payment.
  if (before.status === "cancelled" || now.status === "cancelled") {
    return before.status === "cancelled" && now.status === "cancelled"
      && before.netMinor === now.netMinor && before.paidMinor === now.paidMinor;
  }
  return now.netMinor <= before.netMinor
    && Math.max(0, now.netMinor - now.paidMinor) <= Math.max(0, before.netMinor - before.paidMinor);
}
export function readOperationalRow(x: unknown): OperationalHandoff | null {
  if (!record(x) || !id(x.visitId) || !(x.patientId === null || id(x.patientId))
    || typeof x.patientName !== "string" || !x.patientName.trim()
    || !(x.patientNumber === null || typeof x.patientNumber === "string" && x.patientNumber.trim())
    || x.signedAt !== null || typeof x.finishedAt !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(x.finishedAt)
    || !Number.isFinite(Date.parse(x.finishedAt)) || new Date(x.finishedAt).toISOString() !== x.finishedAt
    || !isFinishVersion(x.finishVersion)
    || (x.dateBasis !== "finished" && x.dateBasis !== "arrival_fallback")
    || !x.finishVersion.startsWith(`${x.dateBasis}:`)
    || x.finishVersion.slice(x.finishVersion.indexOf(":") + 1).replace(/\d{3}Z$/, "Z") !== x.finishedAt
    || (x.status !== "pending" && x.status !== "handled" && x.status !== "deferred")
    || typeof x.financialReviewRequired !== "boolean" || typeof x.visitInvoiceSettled !== "boolean"
    || !(x.handledReason === null || typeof x.handledReason === "string")) return null;
  return { visitId: x.visitId, patientId: x.patientId, patientName: x.patientName,
    patientNumber: x.patientNumber, signedAt: null, finishedAt: x.finishedAt, finishVersion: x.finishVersion,
    dateBasis: x.dateBasis as OperationalHandoff["dateBasis"], status: x.status as OperationalHandoff["status"],
    handledReason: x.handledReason, financialReviewRequired: x.financialReviewRequired, visitInvoiceSettled: x.visitInvoiceSettled };
}
export function readOperationalCheckoutQueue(x: unknown, owner: { username: string; role: string }, date: string | null): OperationalCheckoutSnapshot | null {
  if (!record(x) || x.version !== 1 || !Array.isArray(x.operationalItems)) return null;
  if (!Array.isArray(x.items) || x.items.some(row => !record(row) || typeof row.financialReviewRequired !== "boolean" || typeof row.visitInvoiceSettled !== "boolean")) return null;
  const signed = readReceptionHandoffs(x, owner, date);
  if (!signed) return null;
  const ids = new Set(signed.items.map(row => row.visitId));
  const items: CheckoutQueueRow[] = signed.items.map(row => ({ ...row, eligibility: "signed", eligibleAt: row.signedAt }));
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: signed.clinicTimeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  for (const raw of x.operationalItems) {
    const row = readOperationalRow(raw);
    if (!row || ids.has(row.visitId)) return null;
    const parts = day.formatToParts(new Date(row.finishedAt));
    const ended = ["year", "month", "day"].map(type => parts.find(part => part.type === type)?.value).join("-");
    if (ended < signed.fromDate || ended > signed.toDate) return null;
    ids.add(row.visitId); items.push({ ...row, eligibility: "finished_unsigned", eligibleAt: row.finishedAt });
  }
  items.sort((a, b) => Date.parse(b.eligibleAt) - Date.parse(a.eligibleAt) || b.visitId - a.visitId);
  return { ...signed, version: 1, items };
}
export function readOperationalCheckout(x: unknown, owner: { username: string; role: string }, expected: Pick<OperationalHandoff, "visitId" | "patientId" | "finishVersion">): OperationalCheckoutRead | null {
  if (!record(x) || x.version !== 1 || !record(x.owner) || !canReadReceptionHandoff(owner.role)
    || x.owner.username !== owner.username || x.owner.role !== owner.role) return null;
  const item = readOperationalRow(x.item), receivable = readVisitReceivable(x.receivable);
  if (!item || receivable === undefined || item.visitId !== expected.visitId || item.patientId !== expected.patientId
    || item.finishVersion !== expected.finishVersion || item.patientId === null) return null;
  return { version: 1, owner, item, receivable };
}
