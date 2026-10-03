import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validatePostgresTestTarget } from "./_safe-target";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import type { DbClient } from "../../lib/db";
import { costNow } from "../../lib/inventoryCost";

// Test SOURCE prepared for the repository's guarded PostgreSQL 18 suite.
// Synthetic ALREADY-LINKED inventory integrity only. No unlinked-visit privacy
// harness, HTTP server, Production target, financial deletion or schema reset.
// Validate original environment before stubPostgresEnv removes Railway markers.
validatePostgresTestTarget(process.env, { allowDatabaseUrlFallback: true });
assertRealPostgresUrl();
stubPostgresEnv();
const priorPoolMax = process.env.DB_POOL_MAX;
process.env.DB_POOL_MAX = "8";
const db = await import("../../lib/db");
type Input = Parameters<typeof db.createInventoryMovement>[0];
const q = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []) =>
  (await db.getPool().query<T>(sql, values)).rows;
const insertId = async (sql: string, values: unknown[] = []) => (await q<{ id: number }>(sql, values))[0].id;
const run = randomUUID().slice(0, 8);
let sequence = 0;
let gateSequence = 739100;

beforeAll(async () => {
  await db.resetPoolForTesting();
  await db.ensureSchema();
}, 180_000);
afterAll(async () => {
  await db.resetPoolForTesting();
  if (priorPoolMax === undefined) delete process.env.DB_POOL_MAX;
  else process.env.DB_POOL_MAX = priorPoolMax;
});

async function fixture() {
  const n = ++sequence;
  const actor = `synthetic-inventory-${run}-${n}`;
  const patientId = await insertId(`INSERT INTO patients (patient_number, full_name)
    VALUES ($1, 'Synthetic inventory owner A') RETURNING id`, [`INV-A-${run}-${n}`]);
  const otherPatientId = await insertId(`INSERT INTO patients (patient_number, full_name)
    VALUES ($1, 'Synthetic inventory owner B') RETURNING id`, [`INV-B-${run}-${n}`]);
  const visitId = await insertId(`INSERT INTO visits (patient_id, patient_name, status)
    VALUES ($1, 'Synthetic inventory owner A', 'done') RETURNING id`, [patientId]);
  const itemId = await insertId(`INSERT INTO inventory_items (name, unit, is_active, created_by)
    VALUES ($1, 'box', TRUE, $2) RETURNING id`, [`Synthetic linked item ${run}-${n}`, actor]);
  // Seed only this synthetic item's opening stock; no patient/visit-owned history
  // yet, so the canonical linked A -> B correction remains legitimately allowed.
  await q(`INSERT INTO inventory_movements (item_id, kind, qty, unit_cost_minor, reason, created_by)
    VALUES ($1, 'in', 20, 1500, 'Synthetic opening stock', $2)`, [itemId, actor]);
  const input: Input = { itemId, kind: "out", qty: 2, patientId, visitId,
    reason: "Synthetic linked manual consumption", createdBy: actor };
  return { patientId, otherPatientId, visitId, itemId, actor, input };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function inventorySnapshot(f: Fixture) {
  return {
    item: await q(`SELECT * FROM inventory_items WHERE id = $1`, [f.itemId]),
    movements: await q(`SELECT * FROM inventory_movements WHERE item_id = $1 ORDER BY id`, [f.itemId]),
    payables: await q(`SELECT * FROM payables WHERE created_by = $1 ORDER BY id`, [f.actor]),
    audits: await q(`SELECT * FROM audit_log WHERE actor = $1 AND action = 'inventory.move' ORDER BY id`, [f.actor]),
  };
}
async function currentCost(f: Fixture) {
  const moves = await db.listInventoryMovements(f.itemId, 100);
  return costNow(moves.sort((a, b) => a.id - b.id));
}
function expectIdentityConflict(result: Awaited<ReturnType<typeof db.createInventoryMovement>>) {
  expect(result).toEqual({ ok: false, message: "تغيّر ارتباط الزيارة بملف المريض. حدّث الشاشة وأعد المحاولة." });
}
async function waitForAudit(f: Fixture, movementId: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await q(`SELECT * FROM audit_log WHERE actor = $1 AND action = 'inventory.move'
      AND entity_id = $2 ORDER BY id`, [f.actor, String(movementId)]);
    if (rows.length) { expect(rows).toHaveLength(1); return; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Synthetic committed movement audit did not arrive");
}

// Observe actual PostgreSQL waiters/blockers. Polling time never establishes
// that a writer reached a critical section or that an operation completed.
async function waitForLock(observer: DbClient, fragments: string[], blockerPid: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    await observer.query("SELECT pg_stat_clear_snapshot()");
    const { rows } = await observer.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()
       AND wait_event_type = 'Lock' AND query LIKE ALL($1::text[]) AND $2 = ANY(pg_blocking_pids(pid))`,
      [fragments.map(fragment => `%${fragment}%`), blockerPid]);
    if (rows[0]) return rows[0].pid;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Expected observed synthetic blocker ${blockerPid}: ${fragments.join(" / ")}`);
}

async function holdRow(table: "patients" | "inventory_items" | "visits", id: number) {
  const client = await db.getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL statement_timeout = '12s'`);
    const { rows: [{ pid }] } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    await client.query(`SELECT id FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
    let held = true;
    const unlock = async () => { if (held) { await client.query("ROLLBACK"); held = false; } };
    return { client, pid, unlock, close: async () => { try { await unlock(); } finally { client.release(); } } };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {}); client.release(); throw error;
  }
}

// Pause the real canonical relink after it has locked the visit but before its
// identity UPDATE commits. Definitions are synthetic test-only and removed.
async function pauseRelink(visitId: number) {
  const key = ++gateSequence;
  const name = `inventory_identity_gate_${key}`;
  const client = await db.getPool().connect();
  let functionCreated = false;
  let triggerCreated = false;
  try {
    const { rows: [{ pid }] } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    await client.query("SELECT pg_advisory_lock($1)", [key]);
    await q(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(${key}); RETURN NEW; END $$`);
    functionCreated = true;
    await q(`CREATE TRIGGER ${name} BEFORE UPDATE ON visits FOR EACH ROW
      WHEN (NEW.id = ${visitId} AND NEW.patient_id IS DISTINCT FROM OLD.patient_id)
      EXECUTE FUNCTION ${name}()`);
    triggerCreated = true;
    return { client, pid,
      unlock: () => client.query("SELECT pg_advisory_unlock($1)", [key]),
      close: async () => {
        try {
          await q(`DROP TRIGGER IF EXISTS ${name} ON visits`);
          await q(`DROP FUNCTION IF EXISTS ${name}()`);
        } finally {
          await client.query("SELECT pg_advisory_unlock_all()"); client.release();
        }
      },
    };
  } catch (error) {
    try {
      if (triggerCreated) await q(`DROP TRIGGER IF EXISTS ${name} ON visits`);
      if (functionCreated) await q(`DROP FUNCTION IF EXISTS ${name}()`);
    } finally {
      await client.query("SELECT pg_advisory_unlock_all()"); client.release();
    }
    throw error;
  }
}

describe("manual inventory matching linked context", () => {
  it.each([false, true])("retains exact movement, balance, cost and one audit (signed=%s)", async signed => {
    const f = await fixture();
    if (signed) await q(`UPDATE visits SET signed_at = '2026-10-03T08:00:00Z', signed_by = 'synthetic-doctor' WHERE id = $1`, [f.visitId]);
    const visitBefore = await q(`SELECT * FROM visits WHERE id = $1`, [f.visitId]);
    const before = await inventorySnapshot(f);
    const result = await db.createInventoryMovement({ ...f.input, qty: 2.5,
      unitCostMinor: 9999, isReturn: true, expiryDate: "2030-01-01" });
    expect(result).toMatchObject({ ok: true, balance: 17.5 });
    if (!result.ok) throw new Error("Expected matching synthetic movement");
    await waitForAudit(f, result.movement.id);
    const after = await inventorySnapshot(f);
    expect(after.item).toEqual(before.item);
    expect(after.movements.slice(0, -1)).toEqual(before.movements);
    expect(after.movements.at(-1)).toMatchObject({ patient_id: f.patientId, visit_id: f.visitId,
      item_id: f.itemId, kind: "out", qty: "2.500", reason: f.input.reason, created_by: f.actor,
      expiry_date: null, unit_cost_minor: null, is_return: false, party_id: null, payable_id: null });
    expect(after.payables).toEqual(before.payables);
    expect(after.audits).toHaveLength(1);
    expect(after.audits[0]).toMatchObject({ action: "inventory.move", entity: "inventory_movement",
      entity_id: String(result.movement.id), actor: f.actor,
      details: { النوع: "out", الكمية: 2.5, الرصيد_قبل: 20, الرصيد_بعد: 17.5 } });
    expect(await currentCost(f)).toEqual({ qty: 17.5, valueMinor: 26250, unitCostMinor: 1500 });
    expect(await q(`SELECT * FROM visits WHERE id = $1`, [f.visitId])).toEqual(visitBefore);
  });

  it.each(["different patient", "missing patient", "missing visit"] as const)(
    "rejects %s without movement/payable/audit or cost changes", async kind => {
      const f = await fixture();
      const input = { ...f.input };
      if (kind === "different patient") input.patientId = f.otherPatientId;
      if (kind === "missing patient") input.patientId = -1;
      if (kind === "missing visit") input.visitId = -1;
      const before = await inventorySnapshot(f);
      const costBefore = await currentCost(f);
      expectIdentityConflict(await db.createInventoryMovement(input));
      expect(await inventorySnapshot(f)).toEqual(before);
      expect(await currentCost(f)).toEqual(costBefore);
    });

  it("retains insufficient-balance rejection and deliberate repeated manual consumption", async () => {
    const f = await fixture();
    const before = await inventorySnapshot(f);
    expect(await db.createInventoryMovement({ ...f.input, qty: 21 })).toMatchObject({ ok: false });
    expect(await inventorySnapshot(f)).toEqual(before);
    for (const balance of [18, 16]) {
      const result = await db.createInventoryMovement(f.input);
      expect(result).toMatchObject({ ok: true, balance });
      if (!result.ok) throw new Error("Expected deliberate synthetic repeat");
      await waitForAudit(f, result.movement.id);
    }
    const after = await inventorySnapshot(f);
    expect(after.movements).toHaveLength(3);
    expect(after.audits).toHaveLength(2);
    expect(after.payables).toHaveLength(0);
    expect(await currentCost(f)).toEqual({ qty: 16, valueMinor: 24000, unitCostMinor: 1500 });
  });

  it.each([null, undefined])("rejects expected patient %s against an already-linked visit", async patientId => {
    const f = await fixture();
    const before = await inventorySnapshot(f);
    expectIdentityConflict(await db.createInventoryMovement({ ...f.input, patientId }));
    expect(await inventorySnapshot(f)).toEqual(before);
    expect(await currentCost(f)).toEqual({ qty: 20, valueMinor: 30000, unitCostMinor: 1500 });
  });

  it("rethrows an INSERT failure and releases patient, visit and item locks with no inventory effects", async () => {
    const f = await fixture();
    const before = await inventorySnapshot(f);
    const name = `inventory_failure_${run}_${sequence}`;
    let functionCreated = false;
    let triggerCreated = false;
    try {
      await q(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'Synthetic inventory INSERT failure'; END $$`);
      functionCreated = true;
      await q(`CREATE TRIGGER ${name} BEFORE INSERT ON inventory_movements
        FOR EACH ROW WHEN (NEW.item_id = ${f.itemId}) EXECUTE FUNCTION ${name}()`);
      triggerCreated = true;
      await expect(db.createInventoryMovement(f.input)).rejects.toThrow("Synthetic inventory INSERT failure");
      expect(await inventorySnapshot(f)).toEqual(before);
      const observer = await db.getPool().connect();
      try {
        await observer.query("BEGIN");
        await observer.query(`SELECT id FROM patients WHERE id = $1 FOR UPDATE NOWAIT`, [f.patientId]);
        await observer.query(`SELECT id FROM visits WHERE id = $1 FOR UPDATE NOWAIT`, [f.visitId]);
        await observer.query(`SELECT id FROM inventory_items WHERE id = $1 FOR UPDATE NOWAIT`, [f.itemId]);
      } finally {
        await observer.query("ROLLBACK").catch(() => {}); observer.release();
      }
    } finally {
      if (triggerCreated) await q(`DROP TRIGGER IF EXISTS ${name} ON inventory_movements`);
      if (functionCreated) await q(`DROP FUNCTION IF EXISTS ${name}()`);
    }
  });
});

describe("manual inventory already-linked race schedules", () => {
  it("writer first blocks relink until its committed inventory footprint refuses transfer", async () => {
    const f = await fixture();
    const itemGate = await holdRow("inventory_items", f.itemId);
    let write: ReturnType<typeof db.createInventoryMovement> | undefined;
    let relink: ReturnType<typeof db.linkVisitToPatient> | undefined;
    try {
      write = db.createInventoryMovement(f.input); void write.catch(() => {});
      const writerPid = await waitForLock(itemGate.client, ["FROM inventory_items", "FOR UPDATE"], itemGate.pid);
      relink = db.linkVisitToPatient(f.visitId, f.otherPatientId); void relink.catch(() => {});
      await waitForLock(itemGate.client, ["FROM visits", "FOR UPDATE"], writerPid);
      await itemGate.unlock();
      const result = await write;
      expect(result).toMatchObject({ ok: true, balance: 18 });
      if (!result.ok) throw new Error("Expected writer-first synthetic movement");
      await waitForAudit(f, result.movement.id);
      const committed = await inventorySnapshot(f);
      expect(await relink).toMatchObject({ ok: false, reason: "has_clinical_history" });
      expect(await inventorySnapshot(f)).toEqual(committed);
      expect(await q(`SELECT patient_id FROM visits WHERE id = $1`, [f.visitId])).toEqual([{ patient_id: f.patientId }]);
      expect(committed.movements.at(-1)).toMatchObject({ patient_id: f.patientId, visit_id: f.visitId });
    } finally {
      await itemGate.unlock(); await Promise.allSettled([write, relink]); await itemGate.close();
    }
  }, 30_000);

  it("relink first makes stale writer wait then refuse before any inventory effect", async () => {
    const f = await fixture();
    const before = await inventorySnapshot(f);
    const gate = await pauseRelink(f.visitId);
    let write: ReturnType<typeof db.createInventoryMovement> | undefined;
    let relink: ReturnType<typeof db.linkVisitToPatient> | undefined;
    try {
      relink = db.linkVisitToPatient(f.visitId, f.otherPatientId); void relink.catch(() => {});
      const relinkPid = await waitForLock(gate.client, ["UPDATE visits SET patient_id"], gate.pid);
      write = db.createInventoryMovement(f.input); void write.catch(() => {});
      await waitForLock(gate.client, ["FROM visits", "FOR SHARE"], relinkPid);
      await gate.unlock();
      expect(await relink).toEqual({ ok: true, patientName: "Synthetic inventory owner B" });
      expectIdentityConflict(await write);
      expect(await inventorySnapshot(f)).toEqual(before);
      expect(await currentCost(f)).toEqual({ qty: 20, valueMinor: 30000, unitCostMinor: 1500 });
      expect(await q(`SELECT patient_id FROM visits WHERE id = $1`, [f.visitId])).toEqual([{ patient_id: f.otherPatientId }]);
    } finally {
      await gate.unlock(); await Promise.allSettled([write, relink]); await gate.close();
    }
  }, 30_000);

  it("acquires the patient fence before the visit fence, matching merge/delete ordering", async () => {
    const f = await fixture();
    const patientGate = await holdRow("patients", f.patientId);
    let write: ReturnType<typeof db.createInventoryMovement> | undefined;
    try {
      write = db.createInventoryMovement(f.input); void write.catch(() => {});
      await waitForLock(patientGate.client, ["FROM patients", "FOR KEY SHARE"], patientGate.pid);
      // A patient-first lifecycle writer can still acquire the visit immediately;
      // the inventory writer has not acquired it in reverse order while waiting.
      await patientGate.client.query(`SELECT id FROM visits WHERE id = $1 FOR UPDATE NOWAIT`, [f.visitId]);
      await patientGate.unlock();
      const result = await write;
      expect(result).toMatchObject({ ok: true, balance: 18 });
      if (!result.ok) throw new Error("Expected patient-fenced synthetic movement");
      await waitForAudit(f, result.movement.id);
    } finally {
      await patientGate.unlock(); await Promise.allSettled([write]); await patientGate.close();
    }
  }, 30_000);

  it("waits for a sign-style visit UPDATE lock without holding the inventory item", async () => {
    const f = await fixture();
    const visitGate = await holdRow("visits", f.visitId);
    let write: ReturnType<typeof db.createInventoryMovement> | undefined;
    try {
      write = db.createInventoryMovement(f.input); void write.catch(() => {});
      await waitForLock(visitGate.client, ["FROM visits", "FOR SHARE"], visitGate.pid);
      // This is a lock-order compatibility witness, NOT execution or certification
      // of the complete sign/automatic-deduction lifecycle.
      await visitGate.client.query(`SELECT id FROM inventory_items WHERE id = $1 FOR UPDATE NOWAIT`, [f.itemId]);
      await visitGate.unlock();
      const result = await write;
      expect(result).toMatchObject({ ok: true, balance: 18 });
      if (!result.ok) throw new Error("Expected compatible synthetic movement");
      await waitForAudit(f, result.movement.id);
    } finally {
      await visitGate.unlock(); await Promise.allSettled([write]); await visitGate.close();
    }
  }, 30_000);
});
