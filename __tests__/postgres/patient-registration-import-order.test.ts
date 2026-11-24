import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, rawPool, stubPostgresEnv } from "./_setup";

// Exercise real request handlers and PostgreSQL transactions with a synthetic
// administrator. Only cookie/session resolution is substituted.
vi.mock("@/lib/session", () => ({
  requireSession: async () => ({ userId: 1, username: "synthetic-registration-admin", role: "admin" }),
}));

const fixtureUrl = assertRealPostgresUrl();
stubPostgresEnv();
const control = rawPool(fixtureUrl, 2);
const { ensureSchema, getPool, resetPoolForTesting } = await import("../../lib/db");
const { POST: register } = await import("../../app/api/patients/route");
const { POST: importCsv } = await import("../../app/api/patients/import/route");

const importFirst = "اختبار ترتيب استيراد";
const ordinaryFirst = "اختبار ترتيب استقبال";
const testBarrier = "test_patient_registration_import_order";
const sharedPhone = "771234432";

function post(path: string, body: Record<string, unknown>) {
  return new Request("http://fixture.invalid" + path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}
function patientRequest(fullName: string, phone: string, extra: Record<string, unknown> = {}) {
  return post("/api/patients", { fullName, phone, birthYear: 1995, ...extra });
}
function csvRequest(fullName: string, phone: string, openingMinor?: number, includePossibleDuplicates = false) {
  const csv = [
    "الاسم,الهاتف,سنة الميلاد,الرصيد,العملة",
    [fullName, phone, "1995", openingMinor ?? "", openingMinor ? "ريال يمني" : ""].join(","),
  ].join("\n");
  return post("/api/patients/import", {
    mode: "commit", csv, fileName: "synthetic-register-order.csv",
    fileSha256: createHash("sha256").update(csv).digest("hex"), includePossibleDuplicates,
  });
}

beforeAll(async () => {
  await dropPublicSchema(fixtureUrl);
  await ensureSchema();
  // Pauses only the two synthetic INSERTs after each owning transaction takes
  // its real patient-import lock. Waits below observe actual blocked backends.
  await getPool().query(`
    CREATE FUNCTION test_pause_registration_insert() RETURNS trigger LANGUAGE plpgsql AS $fixture$
    BEGIN
      IF NEW.full_name IN ('${importFirst}', '${ordinaryFirst}') THEN
        PERFORM pg_advisory_xact_lock(hashtext('${testBarrier}'));
      END IF;
      RETURN NEW;
    END; $fixture$;
    CREATE TRIGGER test_pause_registration_insert BEFORE INSERT ON patients
      FOR EACH ROW EXECUTE FUNCTION test_pause_registration_insert();
  `);
});

afterAll(async () => {
  try {
    await getPool().query(`
      DROP TRIGGER IF EXISTS test_pause_registration_insert ON patients;
      DROP FUNCTION IF EXISTS test_pause_registration_insert();
    `);
  } finally {
    await Promise.all([control.end(), resetPoolForTesting()]);
  }
});

async function waiterBlockedBy(pid: number): Promise<number> {
  for (let attempt = 0; attempt < 120; attempt++) {
    const { rows } = await control.query<{ pid: number }>(
      `SELECT a.pid FROM pg_stat_activity a
        WHERE a.datname = current_database() AND $1::int = ANY(pg_blocking_pids(a.pid))
        ORDER BY a.pid LIMIT 1`, [pid],
    );
    if (rows[0]) return rows[0].pid;
    await delay(20);
  }
  throw new Error("Expected a waiting synthetic registration/import backend");
}

async function ordered(first: () => Promise<Response>, second: () => Promise<Response>) {
  const barrier = await control.connect();
  const pending: Promise<Response>[] = [];
  let held = false;
  try {
    await barrier.query("BEGIN");
    held = true;
    await barrier.query("SELECT pg_advisory_xact_lock(hashtext($1))", [testBarrier]);
    const { rows } = await barrier.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    pending.push(first());
    const winnerPid = await waiterBlockedBy(rows[0].pid);
    pending.push(second());
    await waiterBlockedBy(winnerPid);
    await barrier.query("COMMIT");
    held = false;
    return await Promise.all(pending);
  } finally {
    try {
      if (held) await barrier.query("ROLLBACK");
    } finally {
      barrier.release();
      await Promise.allSettled(pending);
    }
  }
}

async function readCursor() {
  return (await getPool().query<{ last_value: string; is_called: boolean }>(
    "SELECT last_value::text, is_called FROM patient_number_seq",
  )).rows[0];
}
async function matching(phone: string) {
  return (await getPool().query<{ id: number; patient_number: string; full_name: string; phone: string }>(
    "SELECT id, patient_number, full_name, phone FROM patients WHERE phone = $1 ORDER BY id", ["967" + phone],
  )).rows;
}
async function auditActions(id: number) {
  return (await getPool().query<{ action: string; details: Record<string, unknown> }>(
    "SELECT action, details FROM audit_log WHERE entity = 'patient' AND entity_id = $1 ORDER BY id", [String(id)],
  )).rows;
}
async function openings(id: number) {
  return (await getPool().query(
    "SELECT currency, amount_minor::text FROM patient_opening_balances WHERE patient_id = $1", [id],
  )).rows;
}

describe("ordinary registration and CSV commit transaction order", () => {
  it("warns without allocating or posting a second opening when an in-flight import commits first", async () => {
    const phone = "771233431";
    const before = await readCursor();
    const [imported, ordinary] = await ordered(
      () => importCsv(csvRequest(importFirst, phone, 850)),
      () => register(patientRequest(importFirst, "0" + phone, {
        openingBalance: { amount: "1200", currency: "YER", asOfDate: "2026-01-01" },
      })),
    );
    expect(imported.status).toBe(201);
    expect(ordinary.status).toBe(409);
    const [only, duplicate] = await Promise.all([imported.json(), ordinary.json()]);
    const rows = await matching(phone);
    expect(rows).toHaveLength(1);
    expect(only.created[0]).toMatchObject({ id: rows[0].id, patientNumber: rows[0].patient_number });
    expect(duplicate.duplicates[0].patient).toMatchObject({ id: rows[0].id, patientNumber: rows[0].patient_number });
    expect(await readCursor()).toEqual({
      last_value: String(BigInt(before.last_value) + (before.is_called ? 1n : 0n)), is_called: true,
    });
    expect(await openings(rows[0].id)).toEqual([{ currency: "YER", amount_minor: "850" }]);
    expect(await auditActions(rows[0].id)).toEqual([]);
  });

  it("reclassifies when ordinary creation commits first, even with the CSV possible-duplicate option", async () => {
    const phone = "771233432";
    const before = await readCursor();
    const [ordinary, imported] = await ordered(
      () => register(patientRequest(ordinaryFirst, phone, {
        openingBalance: { amount: "1200", currency: "YER", asOfDate: "2026-01-01" },
      })),
      () => importCsv(csvRequest(ordinaryFirst, "0" + phone, 850, true)),
    );
    expect(ordinary.status).toBe(201);
    expect(imported.status).toBe(201); // valid import report; only the duplicate row is skipped
    const [created, result] = await Promise.all([ordinary.json(), imported.json()]);
    const rows = await matching(phone);
    expect(rows).toHaveLength(1);
    expect(created).toMatchObject({ id: rows[0].id, patientNumber: rows[0].patient_number });
    expect(result).toMatchObject({ created: [], summary: { duplicate: 1 } });
    expect(await readCursor()).toEqual({
      last_value: String(BigInt(before.last_value) + (before.is_called ? 1n : 0n)), is_called: true,
    });
    expect(await openings(rows[0].id)).toEqual([{ currency: "YER", amount_minor: "1200" }]);
    expect((await auditActions(rows[0].id)).map(row => row.action)).toEqual(["patient.create", "opening_balance.set"]);
  });

  it("still permits deliberate creation of a different household member with the same phone", async () => {
    const first = await register(patientRequest("اختبار عائلي أول", sharedPhone));
    expect(first.status).toBe(201);
    const next = "اختبار عائلي ثان";
    const before = await readCursor();
    expect((await register(patientRequest(next, "0" + sharedPhone))).status).toBe(409);
    expect(await readCursor()).toEqual(before);
    const confirmed = await register(patientRequest(next, "0" + sharedPhone, { confirmDuplicate: true }));
    expect(confirmed.status).toBe(201);
    const rows = await matching(sharedPhone);
    expect(rows.map(row => row.full_name)).toEqual(["اختبار عائلي أول", next]);
    expect(new Set(rows.map(row => row.patient_number)).size).toBe(2);
    expect((await auditActions(rows[1].id))[0]).toMatchObject({
      action: "patient.create", details: { تأكيد_رغم_التكرار: true },
    });
  });
});
