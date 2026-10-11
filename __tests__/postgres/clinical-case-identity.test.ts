import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

assertRealPostgresUrl(); stubPostgresEnv();
const db = await import("../../lib/db");
const endo = await import("../../lib/endodontics-db");
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> =>
  (await db.getPool().query(sql, params)).rows as T[];
const actor = { actor: "SYNTHETIC identity test", actorRole: "admin" };
let seq = 0;
beforeAll(async () => { await dropPublicSchema(process.env.DATABASE_URL!); await db.ensureSchema(); }, 180_000);
afterAll(async () => { await db.resetPoolForTesting(); });

async function fixture() {
  const patientId = (await q<{ id: number }>(`INSERT INTO patients(patient_number,full_name)
    VALUES($1,'SYNTHETIC case identity') RETURNING id`, [`CASE-IDENTITY-${++seq}`]))[0].id;
  const planId = (await q<{ id: number }>(`INSERT INTO treatment_plans(patient_id,title,total_minor,status)
    VALUES($1,'SYNTHETIC identity',1,'active') RETURNING id`, [patientId]))[0].id;
  const serviceId = (await q<{ id: number }>(`INSERT INTO services(name,category,price_minor,price_configured,is_active)
    VALUES('SYNTHETIC RCT','rct',1,TRUE,TRUE) RETURNING id`))[0].id;
  const itemId = (await q<{ id: number }>(`INSERT INTO plan_items(plan_id,service_id,service_name,category,tooth_code,unit_price_minor)
    VALUES($1,$2,'SYNTHETIC RCT','rct',36,1) RETURNING id`, [planId, serviceId]))[0].id;
  const makeCase = async (specialty = "endodontics", site: string | null = "36", owner = patientId) =>
    (await q<{ id: number }>(`INSERT INTO clinical_cases(patient_id,specialty,title,site,created_by)
      VALUES($1,$2,'SYNTHETIC case',$3,'synthetic') RETURNING id`, [owner, specialty, site]))[0].id;
  const caseA = await makeCase(); const caseB = await makeCase();
  const link = (caseId: number | null, priority = 1) => db.setPlanItemCase({ ...actor, itemId, caseId, priority });
  const close = (id = caseB) => db.changeClinicalCaseStatus({ ...actor, id, status: "completed", outcome: "SYNTHETIC complete" });
  const open = (caseId = caseB) => endo.openEndoTreatment({ ...actor, patientId, caseId, toothCode: 36, kind: "initial" });
  const snapshot = async () => ({
    item: await q(`SELECT * FROM plan_items WHERE id=$1`, [itemId]),
    audit: await q(`SELECT * FROM audit_log WHERE entity='patient' AND entity_id=$1 ORDER BY id`, [String(patientId)]),
    endo: await q(`SELECT * FROM endo_treatments WHERE patient_id=$1 ORDER BY id`, [patientId]),
    invoice: await q(`SELECT * FROM invoices WHERE patient_id=$1 ORDER BY id`, [patientId]),
    payments: await q(`SELECT * FROM payments WHERE patient_id=$1 ORDER BY id`, [patientId]),
  });
  return { patientId, planId, serviceId, itemId, caseA, caseB, makeCase, link, close, open, snapshot };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

describe("canonical plan-item case identity", () => {
  it("allows draft relink/detach and refuses foreign or missing cases atomically", async () => {
    const f = await fixture(); const other = await fixture();
    for (const id of [f.caseA, f.caseB, null]) expect(await f.link(id)).toEqual({ ok: true });
    const before = await f.snapshot();
    for (const id of [other.caseA, 2147483647]) expect(await f.link(id)).toEqual({ ok: false, reason: "bad_case" });
    expect(await f.snapshot()).toEqual(before);
  });
  it.each([
    ["prosthodontics", "36", "wrong_specialty"],
    ["endodontics", "11", "wrong_site"],
    ["endodontics", null, "scope_unknown"],
  ] as const)("rejects RCT36 → %s / %s (%s) without writes", async (specialty, site, reason) => {
    const f = await fixture(); const target = await f.makeCase(specialty, site);
    const before = await f.snapshot();
    expect(await f.link(target)).toEqual({ ok: false, reason });
    expect(await f.snapshot()).toEqual(before);
  });
  it.each(["case", "item", "plan"] as const)("rejects terminal %s identity changes but preserves same-case priority", async terminal => {
    const f = await fixture(); expect(await f.link(f.caseA)).toEqual({ ok: true });
    if (terminal === "case") expect(await f.close()).toMatchObject({ ok: true });
    if (terminal === "item") await q(`UPDATE plan_items SET status='done' WHERE id=$1`, [f.itemId]);
    if (terminal === "plan") await q(`UPDATE treatment_plans SET status='cancelled' WHERE id=$1`, [f.planId]);
    const before = await f.snapshot();
    expect(await f.link(f.caseB)).toEqual({ ok: false, reason: "closed" });
    expect(await f.snapshot()).toEqual(before);
    expect(await f.link(f.caseA, 8)).toEqual({ ok: true });
  });
  it.each(["crown", "bridge", "ortho"])("does not infer missing %s episode/arch scope from target or note", async category => {
    const f = await fixture();
    await q(`UPDATE services SET category=$2 WHERE id=$1`, [f.serviceId, category]);
    await q(`UPDATE plan_items SET category=$2,tooth_code=$3,note='الفك العلوي 36 37' WHERE id=$1`,
      [f.itemId, category, category === "ortho" ? null : 36]);
    const target = await f.makeCase(category === "ortho" ? "orthodontics" : "prosthodontics", category === "ortho" ? "الفك العلوي" : "36، 37");
    const before = await f.snapshot();
    expect(await f.link(target)).toEqual({ ok: false, reason: "scope_unknown" });
    expect(await f.snapshot()).toEqual(before);
    // Historical unknown scope is preserved, not reclassified as proven scope.
    await q(`UPDATE plan_items SET case_id=$2 WHERE id=$1`, [f.itemId, target]);
    expect(await f.link(target, 7)).toEqual({ ok: true });
  });
  it("refuses a closed bridged Ortho case even if the generic row remains active", async () => {
    const f = await fixture();
    await q(`UPDATE services SET category='ortho' WHERE id=$1`, [f.serviceId]);
    await q(`UPDATE plan_items SET category='ortho',tooth_code=NULL WHERE id=$1`, [f.itemId]);
    const orthoId = (await q<{ id: number }>(`INSERT INTO ortho_cases(patient_id,status,closed_at,closed_by,created_by)
      VALUES($1,'completed',NOW(),'synthetic','synthetic') RETURNING id`, [f.patientId]))[0].id;
    const target = await f.makeCase("orthodontics", "الفك العلوي");
    await q(`UPDATE clinical_cases SET ortho_case_id=$2 WHERE id=$1`, [target, orthoId]);
    const before = await f.snapshot();
    expect(await f.link(target)).toEqual({ ok: false, reason: "closed" });
    expect(await f.snapshot()).toEqual(before);
    await q(`UPDATE plan_items SET case_id=$2 WHERE id=$1`, [f.itemId, target]);
    expect(await f.link(target, 9)).toEqual({ ok: true });
  });
});

describe("Endo opening uses the canonical case tooth", () => {
  it.each([["11", "bad_site"], [null, "scope_unknown"]] as const)("refuses site %s with %s before any episode/audit", async (site, reason) => {
    const f = await fixture(); const target = await f.makeCase("endodontics", site);
    const before = await f.snapshot();
    expect(await f.open(target)).toEqual({ ok: false, reason });
    expect(await f.snapshot()).toEqual(before);
  });
  it("retains patient/specialty/terminal safeguards and permits an exact FDI match", async () => {
    const f = await fixture(); const other = await fixture();
    const wrongSpecialty = await f.makeCase("prosthodontics");
    const before = await f.snapshot();
    for (const target of [other.caseA, wrongSpecialty, 2147483647]) expect(await f.open(target)).toEqual({ ok: false, reason: "bad_case" });
    expect(await f.snapshot()).toEqual(before);
    expect(await f.close()).toMatchObject({ ok: true });
    const closed = await f.snapshot();
    expect(await f.open()).toEqual({ ok: false, reason: "case_closed" });
    expect(await f.snapshot()).toEqual(closed);
    expect(await f.open(f.caseA)).toMatchObject({ ok: true, treatment: { toothCode: 36, caseId: f.caseA } });
  });
});

async function waitForBlocker(observer: Client, blocker: number): Promise<number> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { rows } = await observer.query<{ pid: number }>(`SELECT pid FROM pg_stat_activity
      WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active'
      AND wait_event_type='Lock' AND $1::int=ANY(pg_blocking_pids(pid))`, [blocker]);
    if (rows[0]) return rows[0].pid;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Expected PostgreSQL blocker edge to backend ${blocker}`);
}

/** Trigger gates are synthetic-only. Neither Promise.all nor elapsed time proves contention. */
async function closureRace(f: Fixture, operation: "link" | "open", first: "close" | "operation") {
  const gate = new Client({ connectionString: process.env.DATABASE_URL!, ssl: false });
  const observer = new Client({ connectionString: process.env.DATABASE_URL!, ssl: false });
  const pending: Promise<unknown>[] = [];
  const table = first === "close" ? "clinical_cases" : operation === "link" ? "plan_items" : "endo_treatments";
  const event = first === "close" ? "UPDATE OF status" : operation === "link" ? "UPDATE OF case_id" : "INSERT";
  const condition = table === "endo_treatments" ? `NEW.patient_id=${f.patientId}` : `NEW.id=${table === "clinical_cases" ? f.caseB : f.itemId}`;
  let gateConnected = false; let observerConnected = false; let installed = false;
  try {
    await gate.connect(); gateConnected = true;
    await observer.connect(); observerConnected = true;
    const gatePid = (await gate.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await q(`CREATE FUNCTION case_identity_gate() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(194281,1); RETURN NEW; END $$`);
    installed = true;
    await q(`CREATE TRIGGER case_identity_gate BEFORE ${event} ON ${table}
      FOR EACH ROW WHEN (${condition}) EXECUTE FUNCTION case_identity_gate()`);
    await gate.query("BEGIN"); await gate.query("SELECT pg_advisory_xact_lock(194281,1)");
    const action = () => operation === "link" ? f.link(f.caseB) : f.open();
    pending.push(first === "close" ? f.close() : action());
    void pending[0].catch(() => {});
    const firstPid = await waitForBlocker(observer, gatePid);
    const firstQuery = (await observer.query<{ query: string }>(
      `SELECT query FROM pg_stat_activity WHERE pid=$1`, [firstPid])).rows[0].query;
    expect(firstQuery).toMatch(first === "close" ? /UPDATE clinical_cases/
      : operation === "link" ? /UPDATE plan_items SET case_id/ : /INSERT INTO endo_treatments/);
    pending.push(first === "close" ? action() : f.close());
    void pending[1].catch(() => {});
    const secondPid = await waitForBlocker(observer, firstPid);
    const secondQuery = (await observer.query<{ query: string }>(
      `SELECT query FROM pg_stat_activity WHERE pid=$1`, [secondPid])).rows[0].query;
    expect(secondQuery).toMatch(/SELECT id FROM patients WHERE id = \$1 FOR (?:NO KEY UPDATE|UPDATE)/);
    expect(new Set([gatePid, firstPid, secondPid]).size).toBe(3);
    await gate.query("COMMIT");
    const result = await Promise.all(pending);
    return { closed: result[first === "close" ? 0 : 1], operated: result[first === "close" ? 1 : 0] };
  } finally {
    if (gateConnected) await gate.query("ROLLBACK").catch(() => {});
    await Promise.allSettled(pending);
    try {
      if (installed) {
        await q(`DROP TRIGGER IF EXISTS case_identity_gate ON ${table}`);
        await q("DROP FUNCTION IF EXISTS case_identity_gate()");
      }
    } finally {
      if (gateConnected) await gate.end();
      if (observerConnected) await observer.end();
    }
  }
}

describe("case closure races have observed lock edges and deterministic outcomes", () => {
  it.each(["link", "open"] as const)("closure-first makes waiting %s refuse committed closure", async operation => {
    const f = await fixture(); const result = await closureRace(f, operation, "close");
    expect(result.closed).toMatchObject({ ok: true });
    expect(result.operated).toEqual({ ok: false, reason: operation === "link" ? "closed" : "case_closed" });
    expect((await f.snapshot()).item[0]).toMatchObject({ case_id: null });
    expect((await f.snapshot()).endo).toEqual([]);
    expect(await q(`SELECT action FROM audit_log WHERE entity_id=$1 AND action IN ('plan.item_case','endo.open')`, [String(f.patientId)])).toEqual([]);
  });
  it.each(["link", "open"] as const)("%s-first retains committed identity before queued closure", async operation => {
    const f = await fixture(); const result = await closureRace(f, operation, "operation");
    expect(result.operated).toMatchObject({ ok: true });
    expect(result.closed).toMatchObject({ ok: true });
    if (operation === "link") expect((await f.snapshot()).item[0]).toMatchObject({ case_id: f.caseB });
    else expect((await f.snapshot()).endo).toEqual([expect.objectContaining({ case_id: f.caseB, tooth_code: 36 })]);
  });
});

/** Ownership can change while a writer waits for its discovery-time patient.
 * The real merge moves every FK then deletes the source. Gate that deletion so
 * the second writer demonstrably discovers the old committed owner first. */
async function mergeIdentityRace(f: Fixture, operation: "link" | "close", first: "merge" | "writer") {
  const targetId = (await q<{ id: number }>(`INSERT INTO patients(patient_number,full_name)
    VALUES($1,'SYNTHETIC merged identity target') RETURNING id`, [`CASE-IDENTITY-MERGE-${++seq}`]))[0].id;
  const gate = new Client({ connectionString: process.env.DATABASE_URL!, ssl: false });
  const observer = new Client({ connectionString: process.env.DATABASE_URL!, ssl: false });
  const pending: Promise<unknown>[] = [];
  const table = first === "merge" ? "patients" : operation === "link" ? "plan_items" : "clinical_cases";
  const event = first === "merge" ? "DELETE" : operation === "link" ? "UPDATE OF case_id" : "UPDATE OF status";
  const row = first === "merge" ? "OLD" : "NEW";
  const id = first === "merge" ? f.patientId : operation === "link" ? f.itemId : f.caseB;
  let gateConnected = false; let observerConnected = false; let installed = false;
  const writer = () => operation === "link" ? f.link(f.caseB, 9) : f.close();
  const merge = () => db.mergeDuplicatePatient(f.patientId, targetId, { ...actor, reason: "SYNTHETIC duplicate correction" });
  try {
    await gate.connect(); gateConnected = true;
    await observer.connect(); observerConnected = true;
    const gatePid = (await gate.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await q(`CREATE FUNCTION case_identity_merge_gate() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(194282,1); RETURN ${row}; END $$`);
    installed = true;
    await q(`CREATE TRIGGER case_identity_merge_gate BEFORE ${event} ON ${table}
      FOR EACH ROW WHEN (${row}.id=${id}) EXECUTE FUNCTION case_identity_merge_gate()`);
    await gate.query("BEGIN"); await gate.query("SELECT pg_advisory_xact_lock(194282,1)");
    pending.push(first === "merge" ? merge() : writer());
    void pending[0].catch(() => {});
    const firstPid = await waitForBlocker(observer, gatePid);
    const firstQuery = (await observer.query<{ query: string }>(
      `SELECT query FROM pg_stat_activity WHERE pid=$1`, [firstPid])).rows[0].query;
    expect(firstQuery).toMatch(first === "merge" ? /DELETE FROM patients/
      : operation === "link" ? /UPDATE plan_items SET case_id/ : /UPDATE clinical_cases/);
    if (first === "merge") {
      // The merge's reference moves/deletion are still uncommitted. The ordinary
      // discovery SELECT sees the source patient, not the destination patient.
      expect((await observer.query<{ patient_id: number }>(
        `SELECT patient_id FROM treatment_plans WHERE id=$1`, [f.planId])).rows).toEqual([{ patient_id: f.patientId }]);
      expect((await observer.query<{ patient_id: number }>(
        `SELECT patient_id FROM clinical_cases WHERE id=$1`, [f.caseB])).rows).toEqual([{ patient_id: f.patientId }]);
    }
    pending.push(first === "merge" ? writer() : merge());
    void pending[1].catch(() => {});
    const secondPid = await waitForBlocker(observer, firstPid);
    const secondQuery = (await observer.query<{ query: string }>(
      `SELECT query FROM pg_stat_activity WHERE pid=$1`, [secondPid])).rows[0].query;
    expect(secondQuery).toMatch(first === "merge"
      ? /SELECT id FROM patients WHERE id = \$1 FOR NO KEY UPDATE/
      : /FROM patients WHERE id = ANY\(\$1::int\[\]\) ORDER BY id FOR UPDATE/);
    expect(new Set([gatePid, firstPid, secondPid]).size).toBe(3);
    await gate.query("COMMIT");
    const results = await Promise.all(pending);
    return { targetId, merged: results[first === "merge" ? 0 : 1], written: results[first === "merge" ? 1 : 0] };
  } finally {
    if (gateConnected) await gate.query("ROLLBACK").catch(() => {});
    await Promise.allSettled(pending);
    try {
      if (installed) {
        await q(`DROP TRIGGER IF EXISTS case_identity_merge_gate ON ${table}`);
        await q("DROP FUNCTION IF EXISTS case_identity_merge_gate()");
      }
    } finally {
      await Promise.all([
        ...(gateConnected ? [gate.end()] : []),
        ...(observerConnected ? [observer.end()] : []),
      ]);
    }
  }
}

async function mergeIdentityState(f: Fixture) {
  return {
    item: (await q(`SELECT * FROM plan_items WHERE id=$1`, [f.itemId]))[0],
    plan: (await q(`SELECT * FROM treatment_plans WHERE id=$1`, [f.planId]))[0],
    cases: await q(`SELECT * FROM clinical_cases WHERE id=ANY($1::int[]) ORDER BY id`, [[f.caseA, f.caseB]]),
    writerAudit: await q(`SELECT * FROM audit_log WHERE actor=$1 AND action IN ('plan.item_case','case.status')
      AND entity_id=$2 ORDER BY id`, [actor.actor, String(f.patientId)]),
  };
}

describe("clinical identity refuses stale patient ownership after canonical duplicate merge", () => {
  it.each(["link", "close"] as const)("merge-first makes waiting %s return owner_changed without a clinical or audit write", async operation => {
    const f = await fixture(); const before = await mergeIdentityState(f);
    const result = await mergeIdentityRace(f, operation, "merge");
    expect(result.merged).toMatchObject({ ok: true, target: { id: result.targetId } });
    expect(result.written).toEqual({ ok: false, reason: "owner_changed" });
    expect(await q(`SELECT id FROM patients WHERE id=$1`, [f.patientId])).toEqual([]);
    const after = await mergeIdentityState(f);
    expect(after.item).toEqual(before.item);
    expect(after.plan).toEqual({ ...before.plan, patient_id: result.targetId });
    expect(after.cases).toEqual(before.cases.map(row => ({ ...row, patient_id: result.targetId })));
    expect(after.writerAudit).toEqual(before.writerAudit);
    expect(await q(`SELECT * FROM audit_log WHERE action IN ('plan.item_case','case.status') AND entity_id=$1`,
      [String(result.targetId)])).toEqual([]);
    expect(await q(`SELECT action FROM audit_log WHERE action='patient.merge' AND entity_id=$1`,
      [String(result.targetId)])).toEqual([{ action: "patient.merge" }]);
    expect(await q(`SELECT id FROM invoices WHERE patient_id=ANY($1::int[])`, [[f.patientId, result.targetId]])).toEqual([]);
    expect(await q(`SELECT id FROM payments WHERE patient_id=ANY($1::int[])`, [[f.patientId, result.targetId]])).toEqual([]);
  });
  it.each(["link", "close"] as const)("%s-first commits on its authorized owner before the queued merge moves identity", async operation => {
    const f = await fixture();
    const result = await mergeIdentityRace(f, operation, "writer");
    expect(result.written).toMatchObject({ ok: true });
    if (operation === "close") expect(result.written).toMatchObject({ case: { patientId: f.patientId } });
    expect(result.merged).toMatchObject({ ok: true, target: { id: result.targetId } });
    expect(await q(`SELECT id FROM patients WHERE id=$1`, [f.patientId])).toEqual([]);
    const state = await mergeIdentityState(f);
    expect(state.plan).toMatchObject({ patient_id: result.targetId });
    expect(state.cases.every(row => row.patient_id === result.targetId)).toBe(true);
    expect(state.item).toMatchObject(operation === "link" ? { case_id: f.caseB, priority: 9 } : { case_id: null, priority: null });
    expect(state.cases.find(row => row.id === f.caseB)).toMatchObject({ status: operation === "close" ? "completed" : "active" });
    expect(state.writerAudit).toEqual([expect.objectContaining({ action: operation === "link" ? "plan.item_case" : "case.status" })]);
    expect(await q(`SELECT * FROM audit_log WHERE action IN ('plan.item_case','case.status') AND entity_id=$1`,
      [String(result.targetId)])).toEqual([]);
  });
});

describe("authorized owner is bound across the route guard to storage boundary", () => {
  it.each(["relink", "same_case_priority", "same_case_noop", "close"] as const)(
    "rejects stale expectedPatientId for %s even when merge finished before store discovery", async operation => {
      const f = await fixture();
      // The old owner was what the route authorized; no write is authorized on
      // the eventual destination simply because a merge transferred the rows.
      expect(await f.link(f.caseA, 1)).toEqual({ ok: true });
      const targetId = (await q<{ id: number }>(`INSERT INTO patients(patient_number,full_name)
        VALUES($1,'SYNTHETIC guard destination') RETURNING id`, [`CASE-IDENTITY-GUARD-${++seq}`]))[0].id;
      expect(await db.mergeDuplicatePatient(f.patientId, targetId, actor)).toMatchObject({ ok: true });
      const before = await mergeIdentityState(f);
      const auditBefore = await q(`SELECT * FROM audit_log WHERE entity_id=ANY($1::text[]) ORDER BY id`,
        [[String(f.patientId), String(targetId)]]);
      const result = operation === "close"
        ? await db.changeClinicalCaseStatus({ ...actor, id: f.caseB, expectedPatientId: f.patientId,
          status: "completed", outcome: "SYNTHETIC stale guard" })
        : await db.setPlanItemCase({ ...actor, itemId: f.itemId, expectedPatientId: f.patientId,
          caseId: operation === "relink" ? f.caseB : f.caseA, priority: operation === "same_case_noop" ? 1 : 9 });
      expect(result).toEqual({ ok: false, reason: "owner_changed" });
      expect(await mergeIdentityState(f)).toEqual(before);
      expect(await q(`SELECT * FROM audit_log WHERE entity_id=ANY($1::text[]) ORDER BY id`,
        [[String(f.patientId), String(targetId)]])).toEqual(auditBefore);
    });
});
