import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { DbClient } from "../lib/db";
import { AUDIT_LABEL, describeAudit } from "../lib/audit";
const state = vi.hoisted(() => ({ query: vi.fn(), poolQuery: vi.fn(), release: vi.fn(), audit: vi.fn(), schema: vi.fn() }));
vi.mock("../lib/db", () => ({ CLINIC_TIME_ZONE: "Asia/Aden", ensureSchema: state.schema, insertAuditRow: state.audit,
  getPool: () => ({ query: state.poolQuery, connect: async () => ({ query: state.query, release: state.release }) }) }));
const { decideOperationalHandoff, readOperationalHandoff, listOperationalHandoffs, operationalDecisionForSigned, signedReceptionFinancialState, verifySignedReception,
  lockReceptionReceivable, OPERATIONAL_HANDOFF_ACTION, RECEPTION_VERIFICATION_ACTION } = await import("../lib/operational-checkout-db");
const actor = { actor: "synthetic-manager", actorRole: "admin" };
const version = "finished:2026-10-10T09:00:00.123456Z";
const invoice = { invoiceId: 80, currency: "SAR" as const, status: "open" as const, netMinor: 10000, paidMinor: 2000 };
const input = { visitId: 41, patientId: 7, finishVersion: version, status: "handled" as const, reason: "قرار اصطناعي موثّق", receivable: invoice };
let row: Record<string, unknown>;
beforeEach(() => {
  vi.clearAllMocks();
  row = { id: 41, patient_id: 7, patient_name: "مريض اصطناعي", patient_number: "SYN-7",
    finished_at: new Date("2026-10-10T09:00:00.123Z"), finish_version: version, date_basis: "finished",
    signed_at: null, status: "done", decision: null, linked_id: 80, invoice_id: 80,
    invoice_status: "open", currency: "SAR", net: "10000", paid: "2000" };
  state.poolQuery.mockReset().mockImplementation(async () => ({ rows: [row] }));
  state.query.mockReset().mockImplementation(async (sql: string) => {
    if (sql.startsWith("SELECT invoice_id FROM visits")) return { rows: [{ invoice_id: row.linked_id }] };
    if (sql.includes("FROM visits v")) return { rows: [row] };
    return { rows: [] };
  });
  state.audit.mockReset().mockImplementation(async (_client, entry) => { row.decision = entry.details; });
});
describe("operational handoff durable decision and receivable proof", () => {
  it("uses the canonical database adapter and registers both durable follow-up actions", () => {
    expectTypeOf<Parameters<typeof lockReceptionReceivable>[0]>().toEqualTypeOf<Pick<DbClient, "query">>();
    expectTypeOf<DbClient>().toMatchTypeOf<Parameters<typeof lockReceptionReceivable>[0]>();
    expect(AUDIT_LABEL[OPERATIONAL_HANDOFF_ACTION]).toBe("تسجيل قرار متابعة زيارة انتهى جلوسها دون توقيع سريري — دون إثبات سداد");
    expect(AUDIT_LABEL[RECEPTION_VERIFICATION_ACTION]).toBe("إعادة تحقق مالية لمتابعة استقبال سابقة — دون إثبات سداد");
    for (const action of [OPERATIONAL_HANDOFF_ACTION, RECEPTION_VERIFICATION_ACTION]) {
      expect(describeAudit(action, "زيارة اصطناعية")).toBe(`${AUDIT_LABEL[action]} — زيارة اصطناعية`);
    }
  });
  it("locks invoice before visit, revalidates exact version and stores only an audited visit-scoped proof", async () => {
    expect(await decideOperationalHandoff(input, actor)).toMatchObject({ ok: true, item: { status: "handled", signedAt: null } });
    const calls = state.query.mock.calls.map(([sql]) => sql as string);
    expect(calls[0]).toBe("BEGIN");
    const invoiceLock = calls.findIndex(sql => sql.includes("FROM invoices") && sql.includes("FOR UPDATE"));
    const visitLock = calls.findIndex(sql => sql.includes("FOR UPDATE OF v"));
    expect(invoiceLock).toBeGreaterThan(0); expect(visitLock).toBeGreaterThan(invoiceLock);
    const proofRead = calls.findIndex(sql => sql.includes("decided.details AS decision"));
    expect(proofRead).toBeGreaterThan(visitLock);
    expect(calls.at(-1)).toBe("COMMIT"); expect(state.release).toHaveBeenCalledTimes(1);
    expect(state.audit.mock.calls[0][1]).toMatchObject({ action: "visit.operational_handoff_decided", entityId: 41,
      details: { patientId: 7, finishVersion: version, receivable: invoice, status: "handled", reason: input.reason } });
    expect(calls.some(sql => /(?:INSERT INTO|UPDATE|DELETE FROM)\s+(?:invoices|payments|visits)\b/i.test(sql))).toBe(false);
  });
  it("returns the original still-applicable decision on retry, without replacing its reason or status", async () => {
    await decideOperationalHandoff(input, actor);
    row.paid = "9000";
    expect(await decideOperationalHandoff({ ...input, status: "deferred", reason: "سبب ثانٍ" }, actor)).toMatchObject({ ok: true,
      item: { status: "handled", handledReason: input.reason } });
    expect(state.audit).toHaveBeenCalledTimes(1);
  });
  it("stale-refuses changed owner, signature, finish version, invoice link or financial proof before audit", async () => {
    for (const change of [{ patient_id: 8 }, { signed_at: new Date() }, { finish_version: "different" }, { net: "11000" }]) {
      const saved = { ...row }; Object.assign(row, change);
      expect(await decideOperationalHandoff(input, actor)).toMatchObject({ ok: false, reason: "stale" }); row = saved;
    }
    state.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith("SELECT invoice_id FROM visits")) return { rows: [{ invoice_id: 79 }] };
      if (sql.includes("FROM visits v")) return { rows: [row] }; return { rows: [] };
    });
    expect(await decideOperationalHandoff(input, actor)).toMatchObject({ ok: false, reason: "stale" }); expect(state.audit).not.toHaveBeenCalled();
  });
  it("rolls back an audit failure and refuses malformed or wrong-patient invoice evidence rather than no charge", async () => {
    state.audit.mockRejectedValue(new Error("synthetic audit failure"));
    await expect(decideOperationalHandoff(input, actor)).rejects.toThrow("synthetic audit failure");
    expect(state.query).toHaveBeenCalledWith("ROLLBACK");
    row.invoice_id = null;
    await expect(readOperationalHandoff(41, 7)).rejects.toThrow("Unverified visit invoice");
    row.invoice_id = 80; row.currency = "INVALID";
    await expect(readOperationalHandoff(41, 7)).rejects.toThrow("Unverified visit invoice");
  });
  it("reads owner, clinical phase, finish version and invoice proof in one statement", async () => {
    expect(await readOperationalHandoff(41, 7)).toMatchObject({ receivable: invoice, item: { signedAt: null } });
    expect(state.poolQuery).toHaveBeenCalledTimes(1);
    const sql = state.poolQuery.mock.calls[0][0] as string;
    expect(sql).toContain("v.patient_id = $2"); expect(sql).toContain("v.signed_at IS NULL"); expect(sql).toContain("i.patient_id = v.patient_id");
    expect(sql).toContain("y.patient_id = v.patient_id");
  });
  it("late signing preserves the independent clinical signature and reopens identity/principal changes with the prior decision visible", async () => {
    row.decision = { ...input, receivable: invoice }; row.signed_at = new Date("2026-10-10T10:00:00.000Z");
    expect(await operationalDecisionForSigned(41, 7, "2026-10-10T10:00:00.000Z")).toEqual({ status: "handled", reason: input.reason });
    expect(await operationalDecisionForSigned(41, 7, "2026-10-10T10:00:00.001Z")).toBeNull();
    row.net = "20000"; row.paid = "12000";
    expect(await operationalDecisionForSigned(41, 7, "2026-10-10T10:00:00.000Z")).toMatchObject({ status: "pending", reason: expect.stringContaining("القرار السابق") });
  });
  it("date-window SQL excludes unsigned unfinished visits and keeps exact clinic-day boundaries", async () => {
    await listOperationalHandoffs("2026-10-10");
    const [sql, values] = state.poolQuery.mock.calls[0];
    expect(sql).toContain("v.status = 'done' AND v.signed_at IS NULL"); expect(sql).toContain("AT TIME ZONE");
    expect(values).toEqual(["Asia/Aden", "2026-10-09", "2026-10-10"]);
  });
});

it("historical signed decisions without proof stay flagged even when their exact invoice is currently paid", async () => {
  row.signed_at = new Date("2026-10-10T10:00:00.000Z"); row.paid = "10000";
  expect(await signedReceptionFinancialState(41, 7, "2026-10-10T10:00:00.000Z", undefined)).toEqual({ reviewRequired: true, invoiceSettled: true });
  row.verification = { receivable: { ...invoice, paidMinor: 10000 } };
  expect(await signedReceptionFinancialState(41, 7, "2026-10-10T10:00:00.000Z", undefined)).toEqual({ reviewRequired: false, invoiceSettled: true });
  row.paid = "9000";
  expect(await signedReceptionFinancialState(41, 7, "2026-10-10T10:00:00.000Z", undefined)).toEqual({ reviewRequired: true, invoiceSettled: false });
});
it("verification refuses stale financial proof and writes a separate bounded audit without replacing the historical decision", async () => {
  row.signed_at = new Date("2026-10-10T10:00:00.000Z"); row.signature_version = "2026-10-10T10:00:00.000123Z";
  const verify = { visitId: 41, patientId: 7, signedAt: "2026-10-10T10:00:00.000Z", reason: "مراجعة اصطناعية", receivable: invoice };
  expect(await verifySignedReception({ ...verify, receivable: null }, actor)).toMatchObject({ ok: false, reason: "stale" });
  expect(state.audit).not.toHaveBeenCalled();
  expect(await verifySignedReception(verify, actor)).toMatchObject({ ok: true, visitId: 41 });
  expect(state.audit.mock.calls[0][1]).toMatchObject({ action: "visit.reception_handoff_verified", details: { patientId: 7,
    signatureVersion: "2026-10-10T10:00:00.000123Z", receivable: invoice } });
});
