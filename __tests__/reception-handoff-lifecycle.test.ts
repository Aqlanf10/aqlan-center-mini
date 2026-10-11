vi.mock("../lib/operational-checkout-db", () => ({ operationalDecisionForSigned: vi.fn().mockResolvedValue(null),
  lockReceptionReceivable: state.proof,
  signedReceptionFinancialState: vi.fn().mockResolvedValue({ reviewRequired: false, invoiceSettled: false }) }));
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VisitWalkout } from "../lib/db";

const state = vi.hoisted(() => ({ poolQuery: vi.fn(), query: vi.fn(), connect: vi.fn(), release: vi.fn(), audit: vi.fn(), walkout: vi.fn(), schema: vi.fn(), proof: vi.fn() }));
vi.mock("../lib/db", () => ({ CLINIC_TIME_ZONE: "Asia/Aden", ensureSchema: state.schema,
  getPool: () => ({ query: state.poolQuery, connect: state.connect }), insertAuditRow: state.audit, visitWalkout: state.walkout }));
const { completeReceptionHandoff, listReceptionHandoffs, readReceptionHandoff, isHandoffSignature } = await import("../lib/reception-handoff-db");
const signedAt = "2026-10-10T09:00:00.123Z";
const signatureVersion = "2026-10-10T09:00:00.123456Z";
const input = { visitId: 41, patientId: 7, signedAt, reason: "اتُّفق على المتابعة لاحقًا" };
const actor = { actor: "desk", actorRole: "reception" };
const row = (override: Record<string, unknown> = {}) => ({ id: 41, patient_id: 7,
  full_name: "مريض اصطناعي", patient_number: "H-7", signed_at: new Date(signedAt),
  eligible_invoice_id: 80, handled_reason: null, deferred: false, ...override });
const walkout = (override: Partial<VisitWalkout> = {}): VisitWalkout => ({ visitId: 41, patientId: 7,
  patientName: "مريض اصطناعي", patientNumber: "H-7", arrivedAt: signedAt, signedAt,
  doctorName: null, treatmentDone: null, nextPlan: null, lines: [], orthoAdjustment: null,
  invoice: { id: 80, number: "I-80", netMinor: 10000, currency: "YER" }, payments: [],
  balances: [{ currency: "YER", balanceMinor: 180000 }], nextAppointment: null, deferred: false,
  checkout: { previous: {}, current: {}, invoicePaidMinor: 10000, paymentsToday: [], openingPaidToday: [] }, ...override });

beforeEach(() => {
  vi.clearAllMocks();
  state.proof.mockReset().mockResolvedValue({ ok: true, patientId: 7, signedAt, receivable: null });
  state.audit.mockReset().mockResolvedValue(undefined);
  state.connect.mockResolvedValue({ query: state.query, release: state.release });
  state.query.mockReset().mockImplementation(async (sql: string) => {
    if (sql.includes("FOR UPDATE OF v")) return { rows: [{ patient_id: 7, signed_at: new Date(signedAt), signature_version: signatureVersion }] };
    return { rows: [] };
  });
  state.poolQuery.mockReset().mockResolvedValue({ rows: [row()] });
  state.walkout.mockReset().mockResolvedValue(walkout());
});

describe("reception handoff status uses canonical financial facts", () => {
  it("derives collected from the exact invoice without treating old account debt as cleared", async () => {
    expect((await listReceptionHandoffs("2026-10-10")).items[0]).toMatchObject({ status: "collected", handledReason: null });
    expect(state.walkout).toHaveBeenCalledWith(41);
    expect(state.audit).not.toHaveBeenCalled();
  });
  it("keeps partial payment pending and reopens a previously collected item after refund", async () => {
    expect((await listReceptionHandoffs("2026-10-10")).items[0].status).toBe("collected");
    state.walkout.mockResolvedValue(walkout({ checkout: { ...walkout().checkout, invoicePaidMinor: 6000 } }));
    expect((await listReceptionHandoffs("2026-10-10")).items[0].status).toBe("pending");
  });
  it("never auto-resolves no-invoice/zero/cancelled/wrong-patient invoice rows", async () => {
    state.poolQuery.mockResolvedValue({ rows: [row({ eligible_invoice_id: null })] });
    expect((await listReceptionHandoffs("2026-10-10")).items[0].status).toBe("pending");
    expect(state.walkout).not.toHaveBeenCalled();
  });
  it.each([
    { patientId: 8 }, { visitId: 42 }, { signedAt: "2026-10-10T09:00:00.124Z" },
    { invoice: null }, { invoice: { id: 81, number: "I-81", netMinor: 10000, currency: "YER" as const } },
    { invoice: { id: 80, number: "I-80", netMinor: 0, currency: "YER" as const } },
    { checkout: { previous: {}, current: {}, invoicePaidMinor: Number.NaN, paymentsToday: [], openingPaidToday: [] } },
    { lines: [{ description: "تحتاج مراجعة", toothCode: null, quantity: 1, unitPriceMinor: 0, currency: "YER" as const,
      included: false, billingClass: "NO_CHARGE" as const, financialReviewRequired: true }] },
    { lines: [{ description: "سطر مدفوع بلا ربط", toothCode: 16, quantity: 1, unitPriceMinor: 10000, currency: "YER" as const,
      included: false, billingClass: "NO_CHARGE" as const }] },
    { lines: [{ description: "خارج العقد", toothCode: null, quantity: 1, unitPriceMinor: 0, currency: "YER" as const,
      included: false, billingClass: "OUTSIDE_CONTRACT" as const }] },
    { orthoAdjustment: { id: 1, billingClass: "OUTSIDE_CONTRACT" as const, decision: null, pendingDecision: true } },
    { orthoAdjustment: { id: 1, billingClass: "OUTSIDE_CONTRACT" as const, decision: null, pendingDecision: false } },
  ])("does not close from stale identity or uncertain billing (%j)", async change => {
    state.walkout.mockResolvedValue(walkout(change));
    expect((await listReceptionHandoffs("2026-10-10")).items[0].status).toBe("pending");
  });
  it.each([
    { handled_reason: "مراجعة الحساب لاحقًا", deferred: false, status: "handled" },
    { handled_reason: null, deferred: true, status: "deferred" },
  ])("preserves an explicit decision independently of receipts (%s)", async decision => {
    state.poolQuery.mockResolvedValue({ rows: [row(decision)] });
    expect((await listReceptionHandoffs("2026-10-10")).items[0]).toMatchObject({ status: decision.status, handledReason: decision.handled_reason });
    expect(state.walkout).not.toHaveBeenCalled();
  });
  it("reuses the supplied exact walkout and refuses a changed identity", async () => {
    expect(await readReceptionHandoff(41, walkout())).toMatchObject({ status: "collected" });
    expect(state.walkout).not.toHaveBeenCalled();
    expect(await readReceptionHandoff(41, walkout({ patientId: 8 }))).toBeNull();
    expect(await readReceptionHandoff(41, walkout({ signedAt: null }))).toBeNull();
  });
  it("propagates financial read failure instead of fabricating completed/empty results", async () => {
    state.walkout.mockRejectedValue(new Error("read failed"));
    await expect(listReceptionHandoffs("2026-10-10")).rejects.toThrow("read failed");
  });
});

describe("transactional exact-signature handoff completion", () => {
  it("locks, inserts a first-class audit, commits, and releases without writing financial rows", async () => {
    expect(await completeReceptionHandoff({ ...input, reason: ` ${input.reason} ` }, actor)).toEqual({ ok: true,
      visitId: 41, patientId: 7, signedAt, status: "handled", handledReason: input.reason });
    expect(state.query.mock.calls[0][0]).toBe("BEGIN");
    expect(state.query.mock.calls[1][0]).toContain("FOR UPDATE OF v");
    expect(state.audit).toHaveBeenCalledWith(expect.objectContaining({ query: state.query }), expect.objectContaining({
      action: "visit.reception_handoff_completed", entity: "visit", entityId: 41, actor: "desk", actorRole: "reception",
      details: { patientId: 7, signedAt, signatureVersion, reason: input.reason, receivable: null },
    }));
    expect(state.query).toHaveBeenLastCalledWith("COMMIT");
    expect(state.release).toHaveBeenCalledOnce();
  });
  it("returns the persisted first reason on retry without replacing the decision", async () => {
    state.query.mockImplementation(async (sql: string) => ({ rows: sql.includes("FOR UPDATE OF v")
      ? [{ patient_id: 7, signed_at: new Date(signedAt), signature_version: signatureVersion }]
      : sql.includes("SELECT id,") ? [{ id: "9", handled_reason: "السبب الأول" }] : [] }));
    expect(await completeReceptionHandoff(input, actor)).toMatchObject({ ok: true, handledReason: "السبب الأول" });
    expect(state.audit).not.toHaveBeenCalled();
  });
  it("rolls back and releases if the durable audit fails", async () => {
    state.audit.mockRejectedValue(new Error("audit unavailable"));
    await expect(completeReceptionHandoff(input, actor)).rejects.toThrow("audit unavailable");
    expect(state.query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(state.query).not.toHaveBeenCalledWith("COMMIT");
    expect(state.release).toHaveBeenCalledOnce();
  });
  it.each(["doctor", "assistant", "cashier", "accountant", null])("denies %s at the service boundary", async actorRole => {
    expect(await completeReceptionHandoff(input, { actor: "spoof", actorRole })).toEqual({ ok: false, reason: "forbidden" });
    expect(state.connect).not.toHaveBeenCalled();
  });
  it.each([{ patientId: 8 }, { signedAt: "2026-10-10T09:00:00.124Z" }])("rejects a stale exact target (%j)", async change => {
    expect(await completeReceptionHandoff({ ...input, ...change }, actor)).toEqual({ ok: false, reason: "stale" });
    expect(state.audit).not.toHaveBeenCalled();
    expect(state.query).toHaveBeenLastCalledWith("ROLLBACK");
  });
  it.each(["", "   ", "ab", "a".repeat(301)])("requires a bounded reason", async reason => {
    expect(await completeReceptionHandoff({ ...input, reason }, actor)).toEqual({ ok: false, reason: "invalid" });
    expect(state.connect).not.toHaveBeenCalled();
  });
  it("rejects unsigned and missing visits with no audit", async () => {
    state.proof.mockResolvedValue({ ok: true, patientId: 7, signedAt: null, receivable: null });
    state.query.mockResolvedValue({ rows: [{ patient_id: 7, signed_at: null, signature_version: null }] });
    expect(await completeReceptionHandoff(input, actor)).toEqual({ ok: false, reason: "not_signed" });
    state.proof.mockResolvedValue({ ok: false, reason: "not_found" });
    state.query.mockResolvedValue({ rows: [] });
    expect(await completeReceptionHandoff(input, actor)).toEqual({ ok: false, reason: "not_found" });
    expect(state.audit).not.toHaveBeenCalled();
  });
  it("accepts only the canonical timestamp format", () => {
    expect(isHandoffSignature(signedAt)).toBe(true);
    for (const value of [null, "2026-02-30T09:00:00.123Z", "2026-10-10", "2026-10-10T09:00:00Z", "invalid"]) expect(isHandoffSignature(value)).toBe(false);
  });
});
