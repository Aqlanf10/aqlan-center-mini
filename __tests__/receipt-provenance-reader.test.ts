import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReceiptProvenancePayment } from "../lib/receipt-provenance";

const mocks = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn(), connect: vi.fn() }));
vi.mock("../lib/db", () => ({ getPool: () => ({ connect: mocks.connect }) }));
import {
  readReceiptProvenance, RECEIPT_PROVENANCE_REQUEST_LIMIT, RECEIPT_PROVENANCE_CONTEXT_LIMIT, RECEIPT_PROVENANCE_AUDIT_LIMIT,
} from "../lib/receipt-provenance-db";

const AT = "2026-10-08 10:00:00+00";
const payment = (id: number, extra: Partial<ReceiptProvenancePayment> = {}): ReceiptProvenancePayment => ({
  id: String(id), receiptNumber: `SYN-${id}`, patientId: "10", kind: "payment", amountMinor: "100",
  currency: "YER", reversalOfId: null, createdBy: "synthetic-admin", createdAt: AT, ...extra,
});
const source = [payment(1), payment(2, { kind: "refund", reversalOfId: "1" }), payment(3, { amountMinor: "50" })];
const audit = { id: "1", action: "payment.correct", entity: "payment", entityId: "1", actor: "synthetic-admin", createdAt: AT,
  details: { الطريقة: "تصحيح", السبب: "synthetic correction", المريض: 10, سند_العكس: "SYN-2",
    المبلغ_المعكوس: 100, العملة_المعكوسة: "YER", السند_الصحيح: "SYN-3", المبلغ_الصحيح: 50, العملة_الصحيحة: "YER" } };

function serve(payments = source, audits: unknown[] = [audit], failAudit = false) {
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.startsWith("WITH owners")) return { rows: payments };
    if (sql.includes("FROM audit_log")) {
      if (failAudit) throw new Error("synthetic unavailable audit");
      return { rows: audits };
    }
    return { rows: [] };
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release });
  serve();
});

describe("receipt provenance reader boundaries", () => {
  it("uses two batched selects in one read-only snapshot and only projects authorized requested IDs", async () => {
    const result = await readReceiptProvenance([3, 3]);
    expect(Object.keys(result)).toEqual(["3"]);
    expect(result[3].replacementOf).toEqual({ id: 1, receiptNumber: "SYN-1" });
    expect(mocks.query.mock.calls.map(([sql]) => (sql as string).split("\n")[0])).toEqual([
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", "WITH owners AS MATERIALIZED (",
      "SELECT id::text AS id, action, entity, entity_id AS \"entityId\", details, actor, created_at::text AS \"createdAt\"", "COMMIT",
    ]);
    expect(mocks.query.mock.calls[1][1]).toEqual([[3], RECEIPT_PROVENANCE_CONTEXT_LIMIT + 1]);
    expect(mocks.query.mock.calls[1][0]).toMatch(/owned AS MATERIALIZED \([\s\S]*?ORDER BY id LIMIT \$2\s*\)/);
    const [auditSql, auditArgs] = mocks.query.mock.calls[2];
    expect(auditSql).toContain("entity_id = ANY($1::text[])");
    expect(auditSql).not.toContain("details->");
    expect(auditArgs).toEqual([["1", "3"], RECEIPT_PROVENANCE_AUDIT_LIMIT + 1]);
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(mocks.connect).toHaveBeenCalledTimes(1);
  });
  it("rejects an oversized request before connecting and handles an empty request without SQL", async () => {
    expect(await readReceiptProvenance([])).toEqual({});
    const ids = Array.from({ length: RECEIPT_PROVENANCE_REQUEST_LIMIT + 1 }, (_, i) => i + 1);
    const result = await readReceiptProvenance(ids);
    expect(Object.values(result).every((value) => value.status === "unavailable" && value.reversal === null)).toBe(true);
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it("payment context limit+1 never yields an unreversed status or incomplete totals", async () => {
    serve(Array.from({ length: RECEIPT_PROVENANCE_CONTEXT_LIMIT + 1 }, (_, i) => payment(i + 1)));
    const result = await readReceiptProvenance([1]);
    expect(result[1]).toMatchObject({ status: "unavailable", reversal: null, correction: null });
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("FROM audit_log"))).toBe(false);
    expect(mocks.query).toHaveBeenLastCalledWith("COMMIT");
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });
  it("audit overflow preserves only independently complete structural reversal", async () => {
    serve(source, Array.from({ length: RECEIPT_PROVENANCE_AUDIT_LIMIT + 1 }, (_, i) => ({ ...audit, id: String(i + 1) })));
    const result = await readReceiptProvenance([1, 2, 3]);
    expect(result[1]).toMatchObject({ status: "available", reversal: { state: "full", reversedMinor: 100, remainingMinor: 0 },
      correction: null, correctionUnverified: true });
    expect(result[2].reversalOf?.id).toBe(1); expect(result[2].correctionReversal).toBeNull();
    expect(result[3].replacementOf).toBeNull();
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });
  it("audit query failure rolls back and releases before returning neutral structural evidence", async () => {
    serve(source, [], true);
    const result = await readReceiptProvenance([1, 2]);
    expect(mocks.query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(result[1].reversal?.state).toBe("full"); expect(result[1].correction).toBeNull();
    expect(result[2].correctionUnverified).toBe(true);
  });
  it("context and connection failures do not make a financial screen report a failed mutation", async () => {
    mocks.query.mockRejectedValue(new Error("synthetic context unavailable"));
    expect((await readReceiptProvenance([1]))[1].status).toBe("unavailable");
    expect(mocks.release).toHaveBeenCalledTimes(1);
    mocks.connect.mockRejectedValue(new Error("synthetic connection unavailable"));
    expect((await readReceiptProvenance([1]))[1].status).toBe("unavailable");
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });
});
