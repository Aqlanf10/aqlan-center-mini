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
function client(audits: unknown[] = [audit]) {
  const query = vi.fn(async (sql: string) => ({ rows: sql.includes("FROM audit_log") ? audits : [] }));
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
