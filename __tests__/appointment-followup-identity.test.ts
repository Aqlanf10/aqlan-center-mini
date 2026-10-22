import { expect, it, vi } from "vitest";
vi.mock("../lib/db", () => ({ getPool: vi.fn(), insertAuditRow: vi.fn(), CLINIC_TIME_ZONE: "Asia/Aden" }));
vi.mock("../lib/session", () => ({ revalidateSessionInTransaction: vi.fn() }));
vi.mock("../lib/patient-access", () => ({ canAccessPatient: vi.fn() }));
import { getPool, insertAuditRow, type DbClient, type DbPool } from "../lib/db";
import { saveAppointmentFollowup } from "../lib/appointment-followup-db";
import type { SessionPayload } from "../lib/auth";

const command = { appointmentId: 10, expectedPatientId: 20, sourceCreatedAt: "1700000000.123456",
  generation: "a".repeat(32), requestId: "synthetic-identity-request", expectedRevision: 0,
  assigneeUserId: 30, dueAt: "2030-01-01T00:00:00.000Z", status: "open", outcome: "pending", nextStep: "call" };
const actor = { userId: 30, username: "synthetic", role: "reception", expiresAt: Date.now() + 3600000 } as SessionPayload;

it.each(['["open"]', '{"toString":null}'])("rejects JSON status %s cleanly before connecting", async json => {
  vi.mocked(getPool).mockClear();
  await expect(saveAppointmentFollowup({ ...command, status: JSON.parse(json) }, actor))
    .rejects.toMatchObject({ status: 400, code: "INVALID_FOLLOWUP" });
  expect(getPool).not.toHaveBeenCalled();
});

it.each([false, true])("followup lock conflict rolls back before FOLLOWUP_BUSY (rollback fails=%s)", async rollbackFails => {
  const lockError = Object.assign(new Error("synthetic row lock conflict"), { code: "55P03" });
  const statements: string[] = [];
  const client = { query: vi.fn(async (sql: string) => {
    statements.push(sql);
    if (sql.includes("FROM appointments a")) return { rows: [{ id: 10, patient_id: 20, source_created_at: command.sourceCreatedAt, eligible: true }] };
    if (sql.includes("AS value")) return { rows: [{ value: command.generation }] };
    if (sql.includes("FROM appointment_followups WHERE")) { expect(sql).toContain("FOR UPDATE NOWAIT"); throw lockError; }
    if (sql === "ROLLBACK" && rollbackFails) throw new Error("secondary rollback failure");
    if (/^\s*(INSERT|UPDATE|DELETE)/.test(sql)) throw new Error("unexpected partial write");
    return { rows: [] };
  }), release: vi.fn() };
  vi.mocked(getPool).mockReturnValue({ connect: async () => client as DbClient } as DbPool);
  await expect(saveAppointmentFollowup(command, actor)).rejects.toMatchObject({ status: 409, code: "FOLLOWUP_BUSY" });
  expect(statements.at(-1)).toBe("ROLLBACK");
  expect(statements).not.toContain("COMMIT");
  expect(client.release).toHaveBeenCalledWith(rollbackFails);
});

// These are writer-boundary regressions, not substitutes for PostgreSQL evidence.
it.each([
  ["patient before creation", 0, 21, command.sourceCreatedAt, command.generation, "FOLLOWUP_SOURCE_CHANGED"],
  ["patient after creation", 1, 21, command.sourceCreatedAt, command.generation, "FOLLOWUP_SOURCE_CHANGED"],
  ["source microseconds", 0, 20, "1700000000.123457", command.generation, "FOLLOWUP_SOURCE_CHANGED"],
  ["reset before creation", 0, 20, command.sourceCreatedAt, "b".repeat(32), "FOLLOWUP_GENERATION_CHANGED"],
  ["reset before replay", 1, 20, command.sourceCreatedAt, "b".repeat(32), "FOLLOWUP_GENERATION_CHANGED"],
])("rejects %s before receipt access or any write", async (_label, revision, patient, created, generation, code) => {
  vi.mocked(insertAuditRow).mockClear();
  const statements: string[] = [];
  const client = {
    query: vi.fn(async (sql: string) => {
      statements.push(sql);
      if (sql.includes("FROM appointments a")) return { rows: [{ id: 10, patient_id: patient, source_created_at: created, eligible: true }] };
      if (sql.includes("AS value")) return { rows: [{ value: generation }] };
      if (sql.includes("appointment_followup_receipts")) throw new Error("stale intent reached receipt access");
      if (/^\s*(INSERT|UPDATE|DELETE)/.test(sql)) throw new Error("stale intent attempted a write");
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  vi.mocked(getPool).mockReturnValue({ connect: async () => client as DbClient } as DbPool);
  await expect(saveAppointmentFollowup({ ...command, expectedRevision: revision }, actor)).rejects.toMatchObject({ status: 409, code });
  expect(statements.at(-1)).toBe("ROLLBACK");
  expect(statements).not.toContain("COMMIT");
  expect(insertAuditRow).not.toHaveBeenCalled();
  expect(client.release).toHaveBeenCalledWith(false);
});
