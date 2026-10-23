import type { DbClient } from "./db";
import { isCurrency, settlePaymentMinor, type Currency } from "./money";
import { siteText, type LineSite } from "./invoice-clinical-linkage";
import { legacyCoverageStateFromSnapshot } from "./legacy-treatment-coverage";

/**
 * Historical treatment agreements registered before the system, for the CURRENT printed patient
 * statement. They are stored facts, not invoices: the saved latest revision lines of each
 * multi-item historical document, plus standalone legacy agreements (document_id IS NULL).
 * Previously-paid amounts are explanatory history, never a receipt or cash movement. Current
 * collections settle the patient's opening bucket per currency, never a document or line.
 *
 * Reads run on the caller's snapshot client only (no pool, no transaction of its own). A
 * malformed stored fact throws: it never becomes an empty list or a zero amount.
 */

export class StatementHistoricalDetailsError extends Error {
  constructor(detail: string) { super(`تعذّر قراءة الاتفاقات التاريخية للمريض: ${detail}`); this.name = "StatementHistoricalDetailsError"; }
}

export interface HistoricalStatementLine {
  description: string;
  /** Stored clinical site text; null when no site was recorded. */
  site: string | null;
  /** Exactly one per clinical line in this contract; tooth counts are never turned into quantities. */
  quantity: 1;
  /** Saved unit price; null where none was recorded (standalone agreements store only the agreed amount). */
  unitPriceMinor: number | null;
  /** Allocated discount; null where none was recorded (standalone agreements). Never an invented zero. */
  discountMinor: number | null;
  netMinor: number;
}

export interface HistoricalStatementAgreement {
  kind: "document" | "standalone";
  /** Document id or standalone agreement id. */
  id: number;
  /** Latest saved revision for a document; 1 for a standalone agreement. */
  version: number;
  currency: Currency;
  historicalAsOf: string;
  lines: HistoricalStatementLine[];
  /** Recorded gross and discount; null for standalone agreements, whose persisted contract has neither. */
  grossMinor: number | null;
  discountMinor: number | null;
  agreedMinor: number;
  previouslyPaidMinor: number;
  remainingMinor: number;
}

export interface HistoricalOpeningBucket {
  currency: Currency;
  agreements: HistoricalStatementAgreement[];
  /** Sum of the live historical remainders in this currency (what registration carried into the opening). */
  historicalRemainingMinor: number;
  /** The current opening row's principal; 0 when no opening row exists. */
  openingPrincipalMinor: number;
  /** Net current collections against this opening bucket (payments − refunds), per readDebtPosition's rule. */
  openingCollectedMinor: number;
  openingRemainingMinor: number;
  /** An opening principal exists that the stored historical details do not account for. */
  openingWithoutStoredDetail: boolean;
}

const safeMinor = (value: unknown, what: string, allowZero = true) => {
  const number = typeof value === "string" && /^-?\d+$/.test(value) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0 || (!allowZero && number === 0)) {
    throw new StatementHistoricalDetailsError(`مبلغ غير صالح (${what})`);
  }
  return number;
};
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const isoDate = (value: unknown, what: string) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new StatementHistoricalDetailsError(`تاريخ غير صالح (${what})`);
  return value;
};

function siteLabel(site: Readonly<LineSite> | null): string | null {
  if (!site) return null;
  const text = siteText(site as LineSite);
  return text === null ? null : site.surfaces ? `${text} (${site.surfaces})` : text;
}

function documentLine(raw: unknown, index: number, documentId: number): HistoricalStatementLine {
  if (!isRecord(raw) || typeof raw.description !== "string" || raw.description.trim() === "" || !isRecord(raw.site)) {
    throw new StatementHistoricalDetailsError(`بند ناقص في الاتفاق #${documentId} (${index + 1})`);
  }
  // Saved JSON amounts are numbers (the revision guard enforces it); a string is a malformed fact.
  if (![raw.unitPriceMinor, raw.discountMinor, raw.netMinor].every((value) => typeof value === "number")) {
    throw new StatementHistoricalDetailsError(`مبالغ البند ${index + 1} في الاتفاق #${documentId} ليست أرقامًا`);
  }
  const unitPriceMinor = safeMinor(raw.unitPriceMinor, `سعر البند ${index + 1} في الاتفاق #${documentId}`, false);
  const discountMinor = safeMinor(raw.discountMinor, `خصم البند ${index + 1} في الاتفاق #${documentId}`);
  const netMinor = safeMinor(raw.netMinor, `صافي البند ${index + 1} في الاتفاق #${documentId}`);
  if (discountMinor > unitPriceMinor || netMinor !== unitPriceMinor - discountMinor) {
    throw new StatementHistoricalDetailsError(`صافي البند ${index + 1} لا يطابق سعره وخصمه في الاتفاق #${documentId}`);
  }
  const site = raw.site as unknown as LineSite;
  return { description: raw.description, site: siteLabel(site), quantity: 1, unitPriceMinor, discountMinor, netMinor };
}

interface DocumentRow {
  id: number; currency: string; line_count: number; version: number | null; total_minor: string | null; discount_minor: string | null;
  previously_paid_minor: string | null; remaining_minor: string | null; historical_as_of: string | null; lines: unknown;
}
interface StandaloneRow {
  id: number; service_id: number; service_name: string; tooth_code: number | null; currency: string; agreed_minor: string;
  previously_paid_minor: string | null; remaining_minor: string | null; historical_as_of: string; coverage_snapshot: unknown;
}

/** Patient-scoped, read-only; the caller owns the (repeatable-read) snapshot transaction. */
export async function readStatementHistoricalAgreements(client: Pick<DbClient, "query">, patientId: number): Promise<HistoricalStatementAgreement[]> {
  const { rows: documents } = await client.query<DocumentRow>(
    `SELECT d.id, d.currency, d.line_count, r.version, r.total_minor::text, r.discount_minor::text, r.previously_paid_minor::text,
            r.remaining_minor::text, r.historical_as_of::text, r.lines
       FROM legacy_treatment_documents d
       LEFT JOIN LATERAL (SELECT * FROM legacy_treatment_document_revisions WHERE document_id = d.id ORDER BY version DESC LIMIT 1) r ON TRUE
      WHERE d.patient_id = $1 ORDER BY d.id`, [patientId]);
  const { rows: standalone } = await client.query<StandaloneRow>(
    `SELECT a.id, a.service_id, a.service_name, a.tooth_code, a.currency, a.agreed_minor::text, a.previously_paid_minor::text,
            a.remaining_minor::text, a.historical_as_of::text, to_jsonb(cs) AS coverage_snapshot
       FROM legacy_treatment_agreements a
       LEFT JOIN legacy_treatment_coverage_snapshots cs ON cs.agreement_id = a.id
      WHERE a.patient_id = $1 AND a.document_id IS NULL AND a.status = 'live' ORDER BY a.id`, [patientId]);
  const result: HistoricalStatementAgreement[] = [];
  for (const row of documents) {
    if (!isCurrency(row.currency)) throw new StatementHistoricalDetailsError(`عملة غير صالحة في الاتفاق #${row.id}`);
    if (row.version === null) throw new StatementHistoricalDetailsError(`الاتفاق #${row.id} بلا نسخة محفوظة`);
    if (!Array.isArray(row.lines) || row.lines.length !== row.line_count || row.lines.length === 0) {
      throw new StatementHistoricalDetailsError(`بنود الاتفاق #${row.id} لا تطابق عددها المحفوظ`);
    }
    const lines = row.lines.map((line, index) => documentLine(line, index, row.id));
    const grossMinor = safeMinor(row.total_minor, `إجمالي الاتفاق #${row.id}`, false);
    const discountMinor = safeMinor(row.discount_minor, `خصم الاتفاق #${row.id}`);
    const previouslyPaidMinor = safeMinor(row.previously_paid_minor, `المدفوع سابقًا للاتفاق #${row.id}`);
    const remainingMinor = safeMinor(row.remaining_minor, `متبقي الاتفاق #${row.id}`);
    const agreedMinor = grossMinor - discountMinor;
    if (lines.reduce((sum, line) => sum + (line.unitPriceMinor ?? 0), 0) !== grossMinor
      || lines.reduce((sum, line) => sum + (line.discountMinor ?? 0), 0) !== discountMinor
      || agreedMinor < 0 || remainingMinor !== agreedMinor - previouslyPaidMinor) {
      throw new StatementHistoricalDetailsError(`مجاميع الاتفاق #${row.id} لا تطابق بنوده`);
    }
    result.push({ kind: "document", id: row.id, version: row.version, currency: row.currency, historicalAsOf: isoDate(row.historical_as_of, `الاتفاق #${row.id}`),
      lines, grossMinor, discountMinor, agreedMinor, previouslyPaidMinor, remainingMinor });
  }
  for (const row of standalone) {
    if (!isCurrency(row.currency)) throw new StatementHistoricalDetailsError(`عملة غير صالحة في الاتفاق السابق #${row.id}`);
    const agreedMinor = safeMinor(row.agreed_minor, `قيمة الاتفاق السابق #${row.id}`, false);
    const previouslyPaidMinor = safeMinor(row.previously_paid_minor, `المدفوع سابقًا للاتفاق السابق #${row.id}`);
    const remainingMinor = safeMinor(row.remaining_minor, `متبقي الاتفاق السابق #${row.id}`);
    if (remainingMinor !== agreedMinor - previouslyPaidMinor) throw new StatementHistoricalDetailsError(`متبقي الاتفاق السابق #${row.id} لا يطابق قيمته`);
    const coverage = legacyCoverageStateFromSnapshot(row.coverage_snapshot, { agreementId: row.id, serviceId: row.service_id, anchorToothCode: row.tooth_code });
    const site = coverage.kind === "verified" ? siteLabel(coverage.coverage.site) : row.tooth_code === null ? null : String(row.tooth_code);
    result.push({ kind: "standalone", id: row.id, version: 1, currency: row.currency, historicalAsOf: isoDate(row.historical_as_of, `الاتفاق السابق #${row.id}`),
      lines: [{ description: row.service_name, site, quantity: 1, unitPriceMinor: null, discountMinor: null, netMinor: agreedMinor }],
      grossMinor: null, discountMinor: null, agreedMinor, previouslyPaidMinor, remainingMinor });
  }
  return result;
}

/**
 * Per-currency opening buckets for the statement, computed from the SAME snapshot's opening rows
 * and receipts. Current collections are counted once per currency (readDebtPosition's rule:
 * payments − refunds targeted at the opening currency), never allocated to a document or line.
 */
export function historicalOpeningBuckets(
  agreements: readonly HistoricalStatementAgreement[],
  openings: readonly { currency: Currency; amountMinor: number }[],
  payments: readonly { id: number; kind: "payment" | "refund"; openingCurrency: Currency | null; amountMinor: number; baseAmountMinor: number; currency: Currency }[],
): HistoricalOpeningBucket[] {
  const currencies = [...new Set([...agreements.map((agreement) => agreement.currency), ...openings.filter((opening) => opening.amountMinor > 0).map((opening) => opening.currency)])];
  return (["YER", "SAR", "USD"] as const).filter((currency) => currencies.includes(currency)).map((currency) => {
    const inCurrency = agreements.filter((agreement) => agreement.currency === currency);
    const openingPrincipalMinor = openings.filter((opening) => opening.currency === currency).reduce((sum, opening) => sum + opening.amountMinor, 0);
    let openingCollectedMinor = 0;
    for (const payment of payments) {
      if (payment.openingCurrency !== currency) continue;
      openingCollectedMinor += (payment.kind === "refund" ? -1 : 1) * settlePaymentMinor(payment, currency);
    }
    const historicalRemainingMinor = inCurrency.reduce((sum, agreement) => sum + agreement.remainingMinor, 0);
    return { currency, agreements: inCurrency, historicalRemainingMinor, openingPrincipalMinor, openingCollectedMinor,
      openingRemainingMinor: Math.max(0, openingPrincipalMinor - openingCollectedMinor),
      openingWithoutStoredDetail: openingPrincipalMinor > 0 && openingPrincipalMinor !== historicalRemainingMinor };
  });
}
