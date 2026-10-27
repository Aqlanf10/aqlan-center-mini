import { describe, expect, it, vi } from "vitest";
import { readPatientStatementEvidence } from "../lib/patient-statement-evidence";
import { StatementProjectionError } from "../lib/patient-statement-projection";
import type { DbClient, Invoice, Payment } from "../lib/db";

const created = new Date("2026-03-01T10:00:00Z");
const payments = [
  { id: 1, patientId: 17, receiptNumber: "SYN-R-1", kind: "payment", amountMinor: 100, currency: "YER" },
  { id: 2, patientId: 17, receiptNumber: "SYN-R-2", kind: "refund", reversalOfId: 1, amountMinor: 100, currency: "YER" },
  { id: 3, patientId: 17, receiptNumber: "SYN-R-3", kind: "payment", amountMinor: 120, currency: "YER" },
] as Payment[];
const ledger = { invoices: [{ id: 5, patientId: 17 }] as Invoice[], payments, openings: [] };
const audit = { action: "payment.correct", entity_id: "1", created_at: created, details: {
  المريض: 17, سند_العكس: "SYN-R-2", السند_الصحيح: "SYN-R-3", المبلغ_المعكوس: 100, العملة_المعكوسة: "YER", المبلغ_الصحيح: 120, العملة_الصحيحة: "YER",
  السبب: "NEVER-PUBLIC", الطريقة: "تصحيح",
} };
function client(audits: unknown[] = [audit], corrections: unknown[] = []) {
  const query = vi.fn(async (sql: string) => ({ rows: sql.includes("FROM audit_log") ? audits : sql.includes("FROM invoice_corrections") ? corrections : [] }));
  return { query, reader: { query } as unknown as Pick<DbClient, "query"> };
}

describe("patient statement evidence read on caller-owned snapshot", () => {
  it("resolves structured correction receipts and amounts with fixed three batch reads", async () => {
    const { query, reader } = client();
    const evidence = await readPatientStatementEvidence(reader, 17, ledger);
    expect(evidence.paymentCorrections).toEqual([{ originalId: 1, reversalId: 2, replacementId: 3, createdAt: created.toISOString() }]);
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[0][0]).toContain("patient_id=$1");
    expect(query.mock.calls[1][0]).toContain("entity_id=ANY($1::text[])");
    expect(JSON.stringify(evidence)).not.toContain("NEVER-PUBLIC");
  });
  it.each([
    { ...audit.details, المريض: 18 },
    { ...audit.details, المبلغ_المعكوس: 99 },
    { ...audit.details, العملة_الصحيحة: "USD" },
    { ...audit.details, سند_العكس: "absent" },
    { ...audit.details, السند_الصحيح: undefined },
  ])("fails closed on mismatched stored correction evidence", async details => {
    const { reader } = client([{ ...audit, details }]);
    await expect(readPatientStatementEvidence(reader, 17, ledger)).rejects.toBeInstanceOf(StatementProjectionError);
  });
  it("reads cancellation timestamp without copying reason or actor", async () => {
    const { reader } = client([{ action: "invoice.cancel", entity_id: "5", created_at: created, details: { المريض: 17, السبب: "internal cancellation reason" } }]);
    const evidence = await readPatientStatementEvidence(reader, 17, ledger);
    expect(evidence.invoiceCancellations).toEqual([{ invoiceId: 5, createdAt: created.toISOString() }]);
    expect(JSON.stringify(evidence)).not.toContain("reason");
  });
  it("preserves independently verified allocation effective time instead of moving a past settlement into today's currency", async () => {
    const { reader } = client([]);
    const withAllocation = { ...ledger, payments: [{ ...payments[0], settlementAllocation: { createdAt: created.toISOString() } } as unknown as Payment] };
    expect((await readPatientStatementEvidence(reader, 17, withAllocation)).allocationEffectiveAt).toEqual({ 1: created.toISOString() });
    await expect(readPatientStatementEvidence(reader, 17, { ...ledger, payments: [{ ...payments[0], settlementAllocation: {} } as Payment] })).rejects.toBeInstanceOf(StatementProjectionError);
  });
});


describe("legacy structured invoice correction evidence", () => {
  const invoices = [
    { id: 5, patientId: 17, invoiceNumber: "SYN-I-5", status: "cancelled" },
    { id: 6, patientId: 17, invoiceNumber: "SYN-I-6", status: "open" },
  ] as Invoice[];
  const correction = { action: "invoice.correct", entity_id: "5", created_at: created,
    details: { المريض: 17, الفاتورة_المصححة: "SYN-I-6", السبب: "PRIVATE-CORRECTION" } };
  const structured = { id: 31, patient_id: 17, original_invoice_id: 5, corrected_invoice_id: 6, created_at: created };
  it("reads the supported legacy writer's exact relationship without parsing notes or adding a query", async () => {
    const { reader, query } = client([correction]);
    const evidence = await readPatientStatementEvidence(reader, 17, { invoices, payments: [], openings: [] });
    expect(evidence.invoiceCorrections).toEqual([{ originalInvoiceId: 5, correctedInvoiceId: 6, createdAt: created.toISOString() }]);
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[1][0]).toContain("'invoice.correct'");
    expect(JSON.stringify(evidence)).not.toContain("PRIVATE-CORRECTION");
  });
  it("deduplicates matching table/audit lineage and fails closed on inconsistent targets or dates", async () => {
    const run = (records: unknown[]) => readPatientStatementEvidence(client([correction], records).reader, 17, { invoices, payments: [], openings: [] });
    expect((await run([structured])).invoiceCorrections).toHaveLength(1);
    await expect(run([{ ...structured, corrected_invoice_id: 7 }])).rejects.toBeInstanceOf(StatementProjectionError);
    await expect(run([{ ...structured, created_at: new Date("2026-02-01T10:00:00Z") }])).rejects.toBeInstanceOf(StatementProjectionError);
  });
  it("rejects missing targets, wrong owners, active originals and inconsistent patient evidence", async () => {
    const run = (rows: Invoice[], row: unknown = correction) => readPatientStatementEvidence(client([row]).reader, 17, { invoices: rows, payments: [], openings: [] });
    await expect(run([invoices[0]])).rejects.toBeInstanceOf(StatementProjectionError);
    await expect(run([invoices[0], { ...invoices[1], patientId: 18 }])).rejects.toBeInstanceOf(StatementProjectionError);
    await expect(run([{ ...invoices[0], status: "open" }, invoices[1]])).rejects.toBeInstanceOf(StatementProjectionError);
    await expect(run(invoices, { ...correction, details: { ...correction.details, المريض: 18 } })).rejects.toBeInstanceOf(StatementProjectionError);
  });
});


describe("modern invoice revision evidence", () => {
  const invoices = [
    { id: 5, patientId: 17, invoiceNumber: "SYN-I-5", status: "cancelled" },
    { id: 6, patientId: 17, invoiceNumber: "SYN-I-6", status: "open" },
  ] as Invoice[];
  const structured = { id: 31, patient_id: 17, original_invoice_id: 5, corrected_invoice_id: 6, created_at: created };
  const correction = { action: "invoice.correct", entity_id: "5", created_at: created,
    details: { correctionId: 31, correctedInvoiceId: 6, reason: "PRIVATE-MODERN-CORRECTION", receiptsPreserved: true, cashMovement: 0 } };
  const run = (row: unknown = correction, records: unknown[] = [structured], invoiceRows = invoices) =>
    readPatientStatementEvidence(client([row], records).reader, 17, { invoices: invoiceRows, payments: [], openings: [] });
  it("verifies the current writer's exact patient-scoped correction without requiring legacy Arabic fields", async () => {
    const { reader, query } = client([correction], [structured]);
    const evidence = await readPatientStatementEvidence(reader, 17, { invoices, payments: [], openings: [] });
    expect(evidence.invoiceCorrections).toEqual([{ originalInvoiceId: 5, correctedInvoiceId: 6, createdAt: created.toISOString() }]);
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[0][0]).toContain("patient_id=$1");
    expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining("patient_id=$1"), [17]);
    expect(JSON.stringify(evidence)).not.toMatch(/PRIVATE-|correctionId|receiptsPreserved|cashMovement/);
  });
  it.each([
    null, "invalid-details", [],
    { ...correction.details, correctionId: 32 },
    { ...correction.details, correctionId: "31" },
    { ...correction.details, correctionId: null },
    { ...correction.details, correctionId: undefined },
    { ...correction.details, correctedInvoiceId: 7 },
    { ...correction.details, correctedInvoiceId: "6" },
    { ...correction.details, correctedInvoiceId: undefined },
    { ...correction.details, المريض: 18 },
    { ...correction.details, الفاتورة_المصححة: "SYN-I-OTHER" },
  ])("rejects malformed, mismatched or contradictory modern audit details", async details => {
    await expect(run({ ...correction, details })).rejects.toBeInstanceOf(StatementProjectionError);
  });
  it("requires independent exact correction proof, not an audit claim or legacy-field fallback", async () => {
    await expect(run(correction, [])).rejects.toBeInstanceOf(StatementProjectionError);
    await expect(run({ ...correction, details: { ...correction.details, المريض: 17, الفاتورة_المصححة: "SYN-I-6" } }, []))
      .rejects.toBeInstanceOf(StatementProjectionError);
    await expect(run(correction, [structured, structured])).rejects.toBeInstanceOf(StatementProjectionError);
    for (const bad of [
      { ...structured, patient_id: 18 },
      { ...structured, original_invoice_id: 7 },
      { ...structured, corrected_invoice_id: 7 },
      { ...structured, created_at: new Date("2026-03-02T10:00:00Z") },
    ]) await expect(run(correction, [bad])).rejects.toBeInstanceOf(StatementProjectionError);
  });
  it("rejects missing invoices, wrong owners, active originals, mismatched audit targets and dates", async () => {
    await expect(run(correction, [structured], [invoices[0]])).rejects.toBeInstanceOf(StatementProjectionError);
    await expect(run(correction, [structured], [invoices[0], { ...invoices[1], patientId: 18 }])).rejects.toBeInstanceOf(StatementProjectionError);
    await expect(run(correction, [structured], [{ ...invoices[0], patientId: 18 }, invoices[1]])).rejects.toBeInstanceOf(StatementProjectionError);
    await expect(run(correction, [structured], [{ ...invoices[0], status: "open" }, invoices[1]])).rejects.toBeInstanceOf(StatementProjectionError);
    await expect(run({ ...correction, entity_id: "6" })).rejects.toBeInstanceOf(StatementProjectionError);
    await expect(run({ ...correction, created_at: new Date("2026-03-02T10:00:00Z") })).rejects.toBeInstanceOf(StatementProjectionError);
  });
});
