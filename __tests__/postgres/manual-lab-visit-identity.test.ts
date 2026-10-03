import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validatePostgresTestTarget } from "./_safe-target";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
import type { DbClient } from "../../lib/db";
import { LabOrderIdentityConflict } from "../../lib/lab-order-identity";

// Already-linked, disposable synthetic fixtures only. The shared global setup
// verifies PostgreSQL 18; validate the original target before stubbing env or DDL.
const target = validatePostgresTestTarget(process.env, { allowDatabaseUrlFallback: true });
assertRealPostgresUrl();
stubPostgresEnv();
// Two gate sessions, writer, deleter and observer must fit without pool starvation.
const priorPoolMax = process.env.DB_POOL_MAX;
process.env.DB_POOL_MAX = "8";
const db = await import("../../lib/db");
const q = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []) =>
  (await db.getPool().query<T>(sql, values)).rows;
const insertId = async (sql: string, values: unknown[] = []) => (await q<{ id: number }>(sql, values))[0].id;
const actor = { actor: "synthetic-lab-identity", actorRole: "admin" };
type Input = Parameters<typeof db.createLabOrder>[0];
let sequence = 0;
let gateSequence = 734700;
let doctorId: number;

beforeAll(async () => {
  await db.resetPoolForTesting();
  await dropPublicSchema(target.testUrl.toString());
  await db.ensureSchema();
  doctorId = await insertId(`INSERT INTO parties (kind, name)
    VALUES ('doctor', 'Synthetic lab identity doctor') RETURNING id`);
}, 180_000);
afterAll(async () => {
  await db.resetPoolForTesting();
  if (priorPoolMax === undefined) delete process.env.DB_POOL_MAX;
  else process.env.DB_POOL_MAX = priorPoolMax;
});

async function fixture() {
  const n = ++sequence;
  const patientId = await insertId(`INSERT INTO patients (patient_number, full_name)
    VALUES ($1, 'Synthetic lab owner A') RETURNING id`, [`LAB-ID-A-${n}`]);
  const otherPatientId = await insertId(`INSERT INTO patients (patient_number, full_name)
    VALUES ($1, 'Synthetic lab owner B') RETURNING id`, [`LAB-ID-B-${n}`]);
  const visitId = await insertId(`INSERT INTO visits (patient_id, patient_name, doctor_id, status, note)
    VALUES ($1, 'Synthetic lab owner A', $2, 'done', 'Synthetic operational note') RETURNING id`, [patientId, doctorId]);
  const input: Input = {
    patientId, visitId, labName: `Synthetic identity lab ${n}`, labPhone: null,
    workType: "Synthetic crown", details: "Retain exact synthetic details", note: "Retain exact synthetic note",
    sentDate: "2026-10-03", dueDate: "2026-10-10", partyId: null,
    costMinor: 12345, costCurrency: "USD", baseCurrency: "YER", exchangeRate: 530,
    createdBy: actor.actor, actorRole: actor.actorRole, source: "manual", status: "sent",
    toothCode: 16, toothNumbers: "16", doctorId, shade: "A2", stumpShade: "ND2",
    priority: "urgent", impressionType: "digital_scan", technicianName: "Synthetic technician",
    expenseAccountCode: "5101", payableAccountCode: "2101", isPosted: true,
  };
  return { patientId, otherPatientId, visitId, input };
}

const snapshotTables = ["patients", "visits", "parties", "lab_services", "lab_pricing_rules",
  "lab_orders", "lab_order_tracking", "payables", "audit_log"] as const;
async function snapshot() {
  const result: Record<string, Record<string, unknown>[]> = {};
  for (const table of snapshotTables) result[table] = await q(`SELECT * FROM ${table} ORDER BY id`);
  return result;
}
async function financialSnapshot() {
  const result: Record<string, Record<string, unknown>[]> = {};
  for (const table of ["parties", "lab_orders", "lab_order_tracking", "payables"] as const) {
    result[table] = await q(`SELECT * FROM ${table} ORDER BY id`);
  }
  return result;
}
async function attempt(input: Input) {
  try { return { ok: true as const, order: await db.createLabOrder(input) }; }
  catch (error) { return { ok: false as const, error }; }
}
function expectIdentityConflict(result: Awaited<ReturnType<typeof attempt>>) {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected synthetic lab identity conflict");
  expect(result.error).toBeInstanceOf(LabOrderIdentityConflict);
  expect(result.error).toMatchObject({ code: "lab_order_identity_changed" });
}

// Sequence changes survive rollback, so this probe detects attempted writes,
// not only committed rows. A permitted visit.delete audit is outside this writer.
async function withWriteProbe(body: () => Promise<void>) {
  const tables = ["parties", "lab_orders", "lab_order_tracking", "payables", "audit_log"] as const;
  const installed: typeof tables[number][] = [];
  let sequenceCreated = false;
  let functionCreated = false;
  try {
    await q(`CREATE SEQUENCE lab_identity_effect_probe`);
    sequenceCreated = true;
    await q(`CREATE FUNCTION lab_identity_effect_probe() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM nextval('lab_identity_effect_probe'); RETURN NEW; END $$`);
    functionCreated = true;
    for (const table of tables) {
      const condition = table === "audit_log" ? "WHEN (NEW.action = 'lab_order.create')" : "";
      await q(`CREATE TRIGGER lab_identity_effect_probe BEFORE INSERT ON ${table}
        FOR EACH ROW ${condition} EXECUTE FUNCTION lab_identity_effect_probe()`);
      installed.push(table);
    }
    await body();
    expect(await q(`SELECT is_called FROM lab_identity_effect_probe`)).toEqual([{ is_called: false }]);
  } finally {
    for (const table of installed) await q(`DROP TRIGGER IF EXISTS lab_identity_effect_probe ON ${table}`);
    if (functionCreated) await q(`DROP FUNCTION lab_identity_effect_probe()`);
    if (sequenceCreated) await q(`DROP SEQUENCE lab_identity_effect_probe`);
  }
}

describe("manual lab order identity and financial compatibility", () => {
  it.each(["foreign visit", "missing visit", "missing patient", "missing patient without visit"] as const)(
    "rejects %s before any party/order/tracking/payable/success-audit write", async kind => {
      const f = await fixture();
      const input = { ...f.input };
      if (kind === "foreign visit") input.patientId = f.otherPatientId;
      if (kind === "missing visit") input.visitId = f.visitId + 1_000_000;
      if (kind === "missing patient" || kind === "missing patient without visit") input.patientId = f.patientId + 1_000_000;
      if (kind === "missing patient without visit") input.visitId = null;
      const before = await snapshot();
      await withWriteProbe(async () => {
        const result = await attempt(input);
        expectIdentityConflict(result);
        expect(await snapshot()).toEqual(before);
      });
    });

  it.each([true, false])("retains exact linked identity, USD conversion and isPosted=%s", async isPosted => {
    const f = await fixture();
    const beforeVisit = await q(`SELECT * FROM visits WHERE id = $1`, [f.visitId]);
    const order = await db.createLabOrder({ ...f.input, isPosted });
    expect(order).not.toBeNull();
    const [row] = await q(`SELECT * FROM lab_orders WHERE id = $1`, [order!.id]);
    expect(row).toMatchObject({ patient_id: f.patientId, visit_id: f.visitId, tooth_code: 16,
      cost_minor: "12345", cost_currency: "USD", base_amount_minor: "65429", source: "manual",
      details: f.input.details, note: f.input.note, tooth_numbers: "16", shade: "A2", stump_shade: "ND2",
      priority: "urgent", impression_type: "digital_scan", technician_name: "Synthetic technician",
      expense_account_code: "5101", payable_account_code: "2101", is_posted: isPosted,
      financial_status: isPosted ? "payable_created" : "pending_post" });
    expect(Number(row.exchange_rate)).toBe(530);
    expect(row.posted_at !== null).toBe(isPosted);
    expect(await q(`SELECT id, lab_order_id, party_id, amount_minor, currency, base_amount_minor, base_currency,
      exchange_rate::float8 AS exchange_rate, is_posted, expense_account_code, payable_account_code
      FROM payables WHERE lab_order_id = $1`, [order!.id])).toEqual([{
      id: row.payable_id, lab_order_id: order!.id, party_id: row.party_id, amount_minor: "12345",
      currency: "USD", base_amount_minor: "65429", base_currency: "YER", exchange_rate: 530,
      is_posted: isPosted, expense_account_code: "5101", payable_account_code: "2101",
    }]);
    expect(await q(`SELECT action, from_status, to_status, notes, actor, actor_role
      FROM lab_order_tracking WHERE lab_order_id = $1 ORDER BY id`, [order!.id])).toEqual([{
      action: "create", from_status: null, to_status: "sent", notes: f.input.workType,
      actor: actor.actor, actor_role: actor.actorRole,
    }]);
    expect(await q(`SELECT * FROM visits WHERE id = $1`, [f.visitId])).toEqual(beforeVisit);
  });

  it.each([null, undefined])("retains patient-level orders with visitId=%s and same-currency minor units", async visitId => {
    const f = await fixture();
    const order = await db.createLabOrder({ ...f.input, visitId, costMinor: 7777, costCurrency: "YER", exchangeRate: 1 });
    expect(order).not.toBeNull();
    expect(await q(`SELECT patient_id, visit_id, cost_minor, cost_currency, base_amount_minor
      FROM lab_orders WHERE id = $1`, [order!.id])).toEqual([{
      patient_id: f.patientId, visit_id: null, cost_minor: "7777", cost_currency: "YER", base_amount_minor: "7777",
    }]);
    expect(await q(`SELECT amount_minor, currency, base_amount_minor, base_currency FROM payables WHERE lab_order_id = $1`, [order!.id]))
      .toEqual([{ amount_minor: "7777", currency: "YER", base_amount_minor: "7777", base_currency: "YER" }]);
  });

  it("retains matching signed-visit creation without changing the signed visit", async () => {
    const f = await fixture();
    await q(`UPDATE visits SET signed_at = '2026-10-03T08:00:00Z', signed_by = 'synthetic-doctor' WHERE id = $1`, [f.visitId]);
    const before = await q(`SELECT * FROM visits WHERE id = $1`, [f.visitId]);
    const order = await db.createLabOrder(f.input);
    expect(order).toMatchObject({ patientId: f.patientId, visitId: f.visitId });
    expect(await q(`SELECT * FROM visits WHERE id = $1`, [f.visitId])).toEqual(before);
  });

  it("retains needed status without a payable and duplicate linked-tooth behavior", async () => {
    const f = await fixture();
    const order = await db.createLabOrder({ ...f.input, status: "needed" });
    expect(order).not.toBeNull();
    expect(await q(`SELECT status, cost_minor, cost_currency, payable_id FROM lab_orders WHERE id = $1`, [order!.id]))
      .toEqual([{ status: "needed", cost_minor: "12345", cost_currency: "USD", payable_id: null }]);
    expect(await q(`SELECT * FROM payables WHERE lab_order_id = $1`, [order!.id])).toEqual([]);
    const before = await snapshot();
    expect(await db.createLabOrder({ ...f.input, status: "needed" })).toBeNull();
    expect(await snapshot()).toEqual(before);
  });

  it("retains automatic price snapshots, quantity and currency on matching pairs", async () => {
    await db.saveSettings({ "finance.rate.SAR": "140" });
    const f = await fixture();
    const partyId = await insertId(`INSERT INTO parties (name, kind, currency) VALUES ($1, 'lab', 'SAR') RETURNING id`, [f.input.labName]);
    // Use the canonical seeded single-tooth service rather than inventing catalog enums.
    const [service] = await q<{ id: number; tooth_scope: string }>(
      `SELECT id, tooth_scope FROM lab_services WHERE code = 'CRW_ZIRC'`,
    );
    expect(service).toMatchObject({ tooth_scope: "single_tooth" });
    const serviceId = service.id;
    await db.createLabPricingRule({ partyId, labServiceId: serviceId, costMinor: 2500,
      costCurrency: "SAR", effectiveFrom: "2026-01-01", createdBy: actor.actor });
    const order = await db.createLabOrder({ ...f.input, partyId, labServiceId: serviceId,
      costMinor: null, costCurrency: null, exchangeRate: 140, toothNumbers: "16,17" });
    expect(order).not.toBeNull();
    expect(await q(`SELECT cost_minor, cost_currency, base_amount_minor FROM lab_orders WHERE id = $1`, [order!.id]))
      .toEqual([{ cost_minor: "5000", cost_currency: "SAR", base_amount_minor: "7000" }]);
    expect(await q(`SELECT amount_minor, currency, base_amount_minor, base_currency FROM payables WHERE lab_order_id = $1`, [order!.id]))
      .toEqual([{ amount_minor: "5000", currency: "SAR", base_amount_minor: "7000", base_currency: "YER" }]);
  });

  it("rolls back all exact records when payable creation fails after tracking", async () => {
    const f = await fixture();
    const before = await snapshot();
    await q(`CREATE FUNCTION lab_identity_fail_payable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Synthetic lab payable failure'; END $$`);
    await q(`CREATE TRIGGER lab_identity_fail_payable BEFORE INSERT ON payables
      FOR EACH ROW EXECUTE FUNCTION lab_identity_fail_payable()`);
    try {
      await expect(db.createLabOrder(f.input)).rejects.toThrow("Synthetic lab payable failure");
      expect(await snapshot()).toEqual(before);
    } finally {
      await q(`DROP TRIGGER lab_identity_fail_payable ON payables`);
      await q(`DROP FUNCTION lab_identity_fail_payable()`);
    }
  });
});

// Observed blockers establish the order; the small polling delay is never proof
// that a write started or finished. Refresh snapshots, including in transactions.
async function waitForLock(observer: DbClient, fragments: string[], blockerPid: number): Promise<number> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await observer.query("SELECT pg_stat_clear_snapshot()");
    const { rows } = await observer.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()
       AND wait_event_type = 'Lock' AND query LIKE ALL($1::text[]) AND $2 = ANY(pg_blocking_pids(pid))`,
      [fragments.map(fragment => `%${fragment}%`), blockerPid]);
    if (rows[0]) return rows[0].pid;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Expected observed synthetic lock behind ${blockerPid}: ${fragments.join(" / ")}`);
}
async function pauseGate(table: "lab_orders" | "visits", event: "INSERT" | "UPDATE" | "DELETE", when: string) {
  const key = ++gateSequence;
  const name = `lab_identity_gate_${key}`;
  const client = await db.getPool().connect();
  let functionCreated = false;
  let triggerCreated = false;
  try {
    const { rows: [{ pid }] } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    await client.query(`SELECT pg_advisory_lock(${key})`);
    await q(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(${key}); RETURN ${event === "DELETE" ? "OLD" : "NEW"}; END $$`);
    functionCreated = true;
    await q(`CREATE TRIGGER ${name} BEFORE ${event} ON ${table} FOR EACH ROW WHEN (${when}) EXECUTE FUNCTION ${name}()`);
    triggerCreated = true;
    return { client, pid,
      unlock: () => client.query(`SELECT pg_advisory_unlock(${key})`),
      close: async () => {
        try {
          await q(`DROP TRIGGER IF EXISTS ${name} ON ${table}`);
          await q(`DROP FUNCTION IF EXISTS ${name}()`);
        } finally {
          await client.query(`SELECT pg_advisory_unlock_all()`);
          client.release();
        }
      },
    };
  } catch (error) {
    try {
      if (triggerCreated) await q(`DROP TRIGGER IF EXISTS ${name} ON ${table}`);
      if (functionCreated) await q(`DROP FUNCTION IF EXISTS ${name}()`);
    } finally {
      await client.query(`SELECT pg_advisory_unlock_all()`);
      client.release();
    }
    throw error;
  }
}

describe("manual lab linked writer ordering", () => {
  it("writer first makes relink wait and refuse without changing any committed record", async () => {
    const f = await fixture();
    const gate = await pauseGate("lab_orders", "INSERT", `NEW.visit_id = ${f.visitId}`);
    let write: ReturnType<typeof attempt> | undefined;
    let relink: ReturnType<typeof db.linkVisitToPatient> | undefined;
    try {
      write = attempt(f.input);
      const writerPid = await waitForLock(gate.client, ["INSERT INTO lab_orders"], gate.pid);
      relink = db.linkVisitToPatient(f.visitId, f.otherPatientId); void relink.catch(() => {});
      await waitForLock(gate.client, ["FROM visits", "FOR UPDATE"], writerPid);
      await gate.unlock();
      expect(await write).toMatchObject({ ok: true, order: { patientId: f.patientId, visitId: f.visitId } });
      const before = await snapshot();
      expect(await relink).toMatchObject({ ok: false, reason: "has_clinical_history" });
      expect(await snapshot()).toEqual(before);
    } finally {
      await gate.unlock(); await Promise.allSettled([write, relink]); await gate.close();
    }
  }, 30_000);

  it("relink first makes stale writer wait then refuse without financial side effects", async () => withWriteProbe(async () => {
    const f = await fixture();
    const before = await snapshot();
    const gate = await pauseGate("visits", "UPDATE", `NEW.id = ${f.visitId} AND NEW.patient_id IS DISTINCT FROM OLD.patient_id`);
    let write: ReturnType<typeof attempt> | undefined;
    let relink: ReturnType<typeof db.linkVisitToPatient> | undefined;
    try {
      relink = db.linkVisitToPatient(f.visitId, f.otherPatientId); void relink.catch(() => {});
      const relinkPid = await waitForLock(gate.client, ["UPDATE visits SET patient_id"], gate.pid);
      write = attempt(f.input);
      await waitForLock(gate.client, ["FROM visits", "FOR SHARE"], relinkPid);
      await gate.unlock();
      expect(await relink).toEqual({ ok: true, patientName: "Synthetic lab owner B" });
      expectIdentityConflict(await write);
      const after = await snapshot();
      expect(after.visits).toEqual(before.visits.map(row => row.id === f.visitId
        ? { ...row, patient_id: f.otherPatientId, patient_name: "Synthetic lab owner B", patient_phone: null } : row));
      delete before.visits; delete after.visits;
      expect(after).toEqual(before);
    } finally {
      await gate.unlock(); await Promise.allSettled([write, relink]); await gate.close();
    }
  }), 30_000);

  it("delete first makes explicit-context writer wait and reject instead of silently detaching", async () => withWriteProbe(async () => {
    const f = await fixture();
    const before = await snapshot();
    const gate = await pauseGate("visits", "DELETE", `OLD.id = ${f.visitId}`);
    let write: ReturnType<typeof attempt> | undefined;
    let deletion: ReturnType<typeof db.deleteVisit> | undefined;
    try {
      deletion = db.deleteVisit(f.visitId, actor); void deletion.catch(() => {});
      const deletePid = await waitForLock(gate.client, ["DELETE FROM visits"], gate.pid);
      write = attempt(f.input);
      await waitForLock(gate.client, ["FROM visits", "FOR SHARE"], deletePid);
      await gate.unlock();
      expect(await deletion).toEqual({ ok: true });
      expectIdentityConflict(await write);
      const after = await snapshot();
      expect(after.visits).toEqual(before.visits.filter(row => row.id !== f.visitId));
      const addedAudits = after.audit_log.filter(row => !before.audit_log.some(old => old.id === row.id));
      expect(addedAudits).toHaveLength(1);
      expect(addedAudits[0]).toMatchObject({ action: "visit.delete", entity_id: String(f.visitId) });
      expect(after.audit_log.filter(row => before.audit_log.some(old => old.id === row.id))).toEqual(before.audit_log);
      delete before.visits; delete after.visits; delete before.audit_log; delete after.audit_log;
      expect(after).toEqual(before);
    } finally {
      await gate.unlock(); await Promise.allSettled([write, deletion]); await gate.close();
    }
  }), 30_000);

  it("writer first preserves permitted later deletion and exact lab/tracking/payable records except visit detachment", async () => {
    const f = await fixture();
    const writerGate = await pauseGate("lab_orders", "INSERT", `NEW.visit_id = ${f.visitId}`);
    let deleteGate: Awaited<ReturnType<typeof pauseGate>> | undefined;
    let write: ReturnType<typeof attempt> | undefined;
    let deletion: ReturnType<typeof db.deleteVisit> | undefined;
    try {
      deleteGate = await pauseGate("visits", "DELETE", `OLD.id = ${f.visitId}`);
      write = attempt(f.input);
      const writerPid = await waitForLock(writerGate.client, ["INSERT INTO lab_orders"], writerGate.pid);
      deletion = db.deleteVisit(f.visitId, actor); void deletion.catch(() => {});
      await waitForLock(writerGate.client, ["FROM visits", "FOR UPDATE"], writerPid);
      await writerGate.unlock();
      expect(await write).toMatchObject({ ok: true, order: { patientId: f.patientId } });
      await waitForLock(deleteGate.client, ["DELETE FROM visits"], deleteGate.pid);
      // Deletion's detach is still uncommitted, so the observer sees the complete
      // just-committed writer record, including its ID, timestamps and money.
      const before = await financialSnapshot();
      const linked = before.lab_orders.filter(row => row.visit_id === f.visitId);
      expect(linked).toHaveLength(1);
      await deleteGate.unlock();
      expect(await deletion).toEqual({ ok: true });
      const after = await financialSnapshot();
      expect(after).toEqual({ ...before, lab_orders: before.lab_orders.map(row => row.visit_id === f.visitId
        ? { ...row, visit_id: null } : row) });
      expect(await q(`SELECT * FROM visits WHERE id = $1`, [f.visitId])).toEqual([]);
    } finally {
      await writerGate.unlock(); await deleteGate?.unlock();
      await Promise.allSettled([write, deletion]);
      await writerGate.close(); await deleteGate?.close();
    }
  }, 30_000);
});
