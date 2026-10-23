import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
import type { ManualAppointmentReminderSnapshot } from "../../lib/manual-appointment-reminder";

// Real route, authorization chain, writer, and PG. Only cookie/session transport
// is synthetic; the separate HTTP suite covers the existing proxy/session gate.
const auth = vi.hoisted(() => ({ requireSession: vi.fn() }));
vi.mock("@/lib/session", () => auth);
assertRealPostgresUrl();
stubPostgresEnv();
const { ensureSchema, getAppointment, getPool, resetPoolForTesting } = await import("../../lib/db");
const { recordManualAppointmentReminder, STALE_MANUAL_REMINDER_MESSAGE } = await import("../../lib/manual-appointment-reminder");
const { PATCH } = await import("../../app/api/appointments/[id]/route");

beforeAll(async () => { await dropPublicSchema(process.env.DATABASE_URL!); await ensureSchema(); });
beforeEach(() => auth.requireSession.mockResolvedValue({
  userId: 1, username: "synthetic-reception", role: "reception", expiresAt: Date.now() + 60_000,
}));
afterAll(async () => { await resetPoolForTesting(); });

let sequence = 0;
async function fixture(status: "booked" | "no_show" = "booked", phone: string | null = "770123456") {
  sequence += 1;
  const name = `Synthetic reminder ${sequence}`;
  const { rows: [patient] } = await getPool().query<{ id: number }>(
    "INSERT INTO patients (patient_number, full_name, phone) VALUES ($1, $2, $3) RETURNING id",
    [`MANUAL-${sequence}`, name, phone],
  );
  const { rows: [appointment] } = await getPool().query<{ id: number }>(
    `INSERT INTO appointments (patient_id, scheduled_date, scheduled_time, status)
     VALUES ($1, '2031-05-10', '10:00', $2) RETURNING id`, [patient.id, status],
  );
  const snapshot: ManualAppointmentReminderSnapshot = {
    patientId: patient.id, patientName: name, patientPhone: phone,
    scheduledDate: "2031-05-10", scheduledTime: "10:00", status,
  };
  return { id: appointment.id, snapshot };
}
async function patch(id: number, snapshot: ManualAppointmentReminderSnapshot) {
  return PATCH(new Request(`http://test.invalid/api/appointments/${id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "reminded", snapshot }),
  }), { params: Promise.resolve({ id: String(id) }) });
}
async function stamp(id: number) {
  const { rows: [row] } = await getPool().query<{ stamp: string | null }>(
    "SELECT reminder_sent_at::text AS stamp FROM appointments WHERE id = $1", [id],
  );
  return row?.stamp ?? null;
}
async function conflict(response: Response) {
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ message: STALE_MANUAL_REMINDER_MESSAGE });
}
async function waitForWriterLock() {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const { rows } = await getPool().query<{ waiting: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
       AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'
       AND query LIKE 'WITH displayed_patient AS MATERIALIZED%') AS waiting`,
    );
    if (rows[0].waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Synthetic manual writer did not reach the expected PG lock wait");
}

describe("manual displayed snapshot on PostgreSQL 18", () => {
  it.each(["booked", "no_show"] as const)("records current %s and accepts an ordinary explicit retry", async (status) => {
    const f = await fixture(status);
    expect((await patch(f.id, f.snapshot)).status).toBe(200); expect(await stamp(f.id)).not.toBeNull();
    expect((await patch(f.id, f.snapshot)).status).toBe(200); expect(await stamp(f.id)).not.toBeNull();
  });

  it("allows actual-contact confirmation without a WhatsApp phone", async () => {
    const f = await fixture("booked", null);
    expect((await patch(f.id, f.snapshot)).status).toBe(200); expect(await stamp(f.id)).not.toBeNull();
  });

  it("matches the canonical displayed minute for fractional SQL times, but rejects a changed minute", async () => {
    const f = await fixture();
    await getPool().query("UPDATE appointments SET scheduled_time = '10:00:00.123456' WHERE id = $1", [f.id]);
    const displayed = await getAppointment(f.id);
    expect(displayed?.scheduledTime).toBe("10:00");
    const snapshot = { ...f.snapshot, scheduledTime: displayed!.scheduledTime };
    expect((await patch(f.id, snapshot)).status).toBe(200); expect(await stamp(f.id)).not.toBeNull();
    await getPool().query("UPDATE appointments SET scheduled_time = '10:01:00.654321', reminder_sent_at = NULL WHERE id = $1", [f.id]);
    await conflict(await patch(f.id, snapshot)); expect(await stamp(f.id)).toBeNull();
  });

  it.each([
    ["date", "scheduled_date = '2031-05-11'"], ["time", "scheduled_time = '11:00'"],
    ["cancelled", "status = 'cancelled'"], ["arrived", "status = 'arrived'"],
    ["done", "status = 'done'"], ["no_show", "status = 'no_show'"],
  ])("rejects a changed %s with 409 and no stamp", async (_label, update) => {
    const f = await fixture();
    await getPool().query(`UPDATE appointments SET ${update} WHERE id = $1`, [f.id]);
    await conflict(await patch(f.id, f.snapshot)); expect(await stamp(f.id)).toBeNull();
  });

  it("does not overwrite an existing reminder timestamp on a stale confirmation", async () => {
    const f = await fixture();
    await getPool().query("UPDATE appointments SET reminder_sent_at = '2031-05-09T00:00:00Z', status = 'cancelled' WHERE id = $1", [f.id]);
    const before = await stamp(f.id);
    await conflict(await patch(f.id, f.snapshot)); expect(await stamp(f.id)).toBe(before);
  });

  it.each(["full_name", "phone"])("rejects changed reminder recipient %s", async (column) => {
    const f = await fixture();
    await getPool().query(`UPDATE patients SET ${column} = $2 WHERE id = $1`, [f.snapshot.patientId, "Synthetic changed"]);
    await conflict(await patch(f.id, f.snapshot)); expect(await stamp(f.id)).toBeNull();
  });

  it("rejects a retargeted appointment, and a forged foreign snapshot cannot replace the authorized identity", async () => {
    const f = await fixture(); const other = await fixture();
    await getPool().query("UPDATE appointments SET patient_id = $2 WHERE id = $1", [f.id, other.snapshot.patientId]);
    await conflict(await patch(f.id, f.snapshot));
    expect(await recordManualAppointmentReminder(f.id, f.snapshot.patientId, other.snapshot)).toBe(false);
    expect(await stamp(f.id)).toBeNull();
  });

  it("does not bypass real patient authorization for a foreign doctor or financial-only role", async () => {
    const f = await fixture();
    for (const role of ["doctor", "accountant", "cashier"]) {
      auth.requireSession.mockResolvedValue({ userId: 1, username: "synthetic-unlinked", role, expiresAt: Date.now() + 60_000 });
      expect((await patch(f.id, f.snapshot)).status).toBe(404);
      expect(await stamp(f.id)).toBeNull();
    }
    auth.requireSession.mockResolvedValue(null);
    expect((await patch(f.id, f.snapshot)).status).toBe(401); expect(await stamp(f.id)).toBeNull();
  });

  it.each(["move", "cancel", "retarget"])("rechecks the row after a concurrent %s wins between authorization and the write", async (kind) => {
    const f = await fixture(); const other = await fixture();
    const client = await getPool().connect();
    let pending: Promise<Response> | undefined;
    try {
      await client.query("BEGIN");
      if (kind === "move") await client.query("UPDATE appointments SET scheduled_date = '2031-05-11', scheduled_time = '11:00' WHERE id = $1", [f.id]);
      else if (kind === "cancel") await client.query("UPDATE appointments SET status = 'cancelled' WHERE id = $1", [f.id]);
      else await client.query("UPDATE appointments SET patient_id = $2 WHERE id = $1", [f.id, other.snapshot.patientId]);
      // The real authorizer reads the previously committed patient. The writer
      // blocks on this transaction, then must recheck the committed new row.
      pending = patch(f.id, f.snapshot);
      await waitForWriterLock();
      await client.query("COMMIT");
      await conflict(await pending); expect(await stamp(f.id)).toBeNull();
    } finally {
      await client.query("ROLLBACK"); client.release(); await pending;
    }
  });

  it.each(["full_name", "phone"])("rechecks a concurrent %s edit under the patient lock", async (column) => {
    const f = await fixture(); const client = await getPool().connect();
    let pending: Promise<Response> | undefined;
    try {
      await client.query("BEGIN");
      await client.query(`UPDATE patients SET ${column} = $2 WHERE id = $1`, [f.snapshot.patientId, "Synthetic changed"]);
      pending = patch(f.id, f.snapshot);
      await waitForWriterLock(); await client.query("COMMIT");
      await conflict(await pending); expect(await stamp(f.id)).toBeNull();
    } finally {
      await client.query("ROLLBACK"); client.release(); await pending;
    }
  });

  it("allows an unchanged snapshot after a competing move rolls back", async () => {
    const f = await fixture(); const client = await getPool().connect();
    let pending: Promise<Response> | undefined;
    try {
      await client.query("BEGIN");
      await client.query("UPDATE appointments SET scheduled_time = '11:00' WHERE id = $1", [f.id]);
      pending = patch(f.id, f.snapshot);
      await waitForWriterLock(); await client.query("ROLLBACK");
      expect((await pending).status).toBe(200); expect(await stamp(f.id)).not.toBeNull();
    } finally {
      await client.query("ROLLBACK"); client.release(); await pending;
    }
  });
});
