import { beforeEach, expect, it, vi } from "vitest";
const deps = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn(), current: vi.fn(), audit: vi.fn() }));
vi.mock("../lib/db", () => ({ ensureSchema: async () => {}, getPool: () => ({ connect: async () => ({ query: deps.query, release: deps.release }) }), insertAuditRow: deps.audit }));
vi.mock("../lib/session", () => ({ revalidateSessionInTransaction: deps.current }));
import { patientResponsibilitySettings } from "../lib/patient-responsibility-settings";
const session = { userId: 1, username: "synthetic-admin", role: "admin", expiresAt: Date.now() + 60000 };
const target = { patientId: 19, kind: "ortho" as const, sourceId: 3 };
let doctorId: number;
let corruptBridge: "duplicate" | "specialty" | null;
beforeEach(() => {
 vi.clearAllMocks(); doctorId = 7; corruptBridge = null; deps.current.mockResolvedValue(session);
 deps.query.mockImplementation(async (sql: string, params: unknown[]) => {
  if (sql.includes("FROM audit_log")) return { rows: [{ revision: "0" }] };
  if (sql.startsWith("SELECT id, patient_id, responsible_doctor_id")) return { rows: [{ id: 3, patient_id: 19, responsible_doctor_id: doctorId, status: "active" }] };
  if (sql.startsWith("SELECT id, patient_id, ortho_case_id")) return { rows: [{ id: 11, patient_id: 19, ortho_case_id: 3, responsible_party_id: doctorId, status: "active", specialty: corruptBridge === "specialty" ? "endodontics" : "orthodontics" }, ...(corruptBridge === "duplicate" ? [{ id: 12, patient_id: 19, ortho_case_id: 3, responsible_party_id: 9, status: "active", specialty: "orthodontics" }] : [])] };
  if (sql.startsWith("SELECT id,name")) return { rows: [{ id: 7, name: "Synthetic original" }, { id: 9, name: "Synthetic incoming" }] };
  if (sql.startsWith("SELECT name")) return { rows: [{ name: doctorId === 7 ? "Synthetic original" : "Synthetic incoming" }] };
  if (sql.startsWith("SELECT id FROM parties")) return { rows: [{ id: 9 }] };
  if (sql.startsWith("UPDATE ortho_cases")) doctorId = Number(params[1]);
  return { rows: [] };
 });
});
it("admin reassigns canonical case and bridge with audit, never financial or historical rows", async () => {
 const before = await patientResponsibilitySettings(target, session);
 const after = await patientResponsibilitySettings(target, session, { expectedSourceFingerprint: before.sourceFingerprint, doctorId: 9, reason: "Synthetic transfer" });
 expect(after.doctorId).toBe(9); expect(after.sourceFingerprint).not.toBe(before.sourceFingerprint);
 const writes = deps.query.mock.calls.map(call => String(call[0])).filter(sql => sql.startsWith("UPDATE"));
 expect(writes).toHaveLength(2); expect(writes.join(" ")).not.toMatch(/plan_items|treatment_plans|appointments|invoice|visit/);
 expect(deps.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "case.responsibility_change", actor: session.username, details: expect.objectContaining({ reason: "Synthetic transfer", actorUserId: 1, doctorId: 9 }) }));
});
it.each(["doctor", "reception", "assistant", "cashier"])("rejects %s before database access", async role => {
 await expect(patientResponsibilitySettings(target, { ...session, role })).rejects.toMatchObject({ status: 403 }); expect(deps.query).not.toHaveBeenCalled();
});
it("requires current transaction authority, not a stale admin cookie", async () => { deps.current.mockResolvedValue({ ...session, role: "doctor" }); await expect(patientResponsibilitySettings(target, session)).rejects.toMatchObject({ status: 403 }); expect(deps.query).toHaveBeenCalledWith("ROLLBACK"); });
it("rejects stale responsibility without mutation", async () => {
 await expect(patientResponsibilitySettings(target, session, { expectedSourceFingerprint: "a".repeat(64), doctorId: 9, reason: "Synthetic transfer" })).rejects.toMatchObject({ status: 409 });
 expect(deps.query.mock.calls.some(call => String(call[0]).startsWith("UPDATE"))).toBe(false); expect(deps.audit).not.toHaveBeenCalled();
});
it("refuses missing reasons before transaction", async () => { await expect(patientResponsibilitySettings(target, session, { expectedSourceFingerprint: "a".repeat(64), doctorId: 9, reason: " " })).rejects.toMatchObject({ status: 400 }); expect(deps.query).not.toHaveBeenCalled(); });
it("rolls back and returns retry for source lock contention", async () => { deps.query.mockRejectedValueOnce(Object.assign(new Error("lock"), { code: "55P03" })); await expect(patientResponsibilitySettings(target, session)).rejects.toMatchObject({ status: 409 }); expect(deps.query).toHaveBeenCalledWith("ROLLBACK"); });

it.each(["duplicate", "specialty"] as const)("fails closed on %s Ortho bridge rather than normalizing ownership", async corruption => {
 corruptBridge = corruption;
 await expect(patientResponsibilitySettings(target, session)).rejects.toMatchObject({ status: 409 });
 expect(deps.query.mock.calls.some(call => String(call[0]).startsWith("UPDATE"))).toBe(false);
 expect(deps.audit).not.toHaveBeenCalled();
});
