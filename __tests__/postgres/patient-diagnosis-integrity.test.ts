import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validatePostgresTestTarget } from "./_safe-target";
import { assertRealPostgresUrl, dropPublicSchema, rawPool, stubPostgresEnv } from "./_setup";

// Refuse non-test/production targets before any test environment normalization.
validatePostgresTestTarget();
assertRealPostgresUrl();
stubPostgresEnv();
const db = await import("../../lib/db");
const pool = rawPool();
let patient: number, foreignPatient: number, caseId: number, oldCase: number, foreignCase: number;
let visitId: number, signedVisit: number, foreignVisit: number, unlinkedVisit: number;
const input = (extra: Partial<Parameters<typeof db.recordPatientDiagnosis>[0]> = {}) => ({
  patientId: patient, content: { note: "Synthetic diagnosis integrity" }, label: null, orthoCaseId: null,
  visitId: null, createdBy: "synthetic-diagnosis-doctor", ...extra,
});
const snapshot = async () => (await pool.query("SELECT * FROM patient_diagnoses ORDER BY id")).rows;

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await db.ensureSchema();
  const patients = await pool.query("INSERT INTO patients (patient_number,full_name) VALUES ('DX-A','Synthetic A'),('DX-B','Synthetic B') RETURNING id");
  [patient, foreignPatient] = patients.rows.map(r => r.id);
  const cases = await pool.query(`INSERT INTO ortho_cases (patient_id,appliance,arches,slot,start_date,planned_months,created_by,status)
    VALUES ($1,'fixed_metal','both','022',CURRENT_DATE,12,'synthetic','active'),
           ($1,'fixed_metal','both','022',CURRENT_DATE,12,'synthetic','completed'),
           ($2,'fixed_metal','both','022',CURRENT_DATE,12,'synthetic','active') RETURNING id`, [patient, foreignPatient]);
  [caseId, oldCase, foreignCase] = cases.rows.map(r => r.id);
  const visits = await pool.query(`INSERT INTO visits (patient_id,patient_name,status)
    VALUES ($1,'Synthetic A','waiting'),($1,'Synthetic A signed','done'),($2,'Synthetic B','waiting'),(NULL,'Unlinked','waiting') RETURNING id`, [patient, foreignPatient]);
  [visitId, signedVisit, foreignVisit, unlinkedVisit] = visits.rows.map(r => r.id);
  await pool.query("UPDATE visits SET signed_at=NOW() WHERE id=$1", [signedVisit]);
});
afterAll(async () => { await pool.end(); await db.resetPoolForTesting(); });

describe("canonical diagnosis linkage and immutable history", () => {
  it("keeps optional independent links, historical cases, signed visits, and one patient-wide version chain", async () => {
    const links = [{}, { orthoCaseId: caseId }, { visitId }, { orthoCaseId: oldCase, visitId: signedVisit }];
    const saved = [];
    for (const link of links) saved.push(await db.recordPatientDiagnosis(input(link)));
    const rows = (await pool.query("SELECT * FROM patient_diagnoses WHERE patient_id=$1 ORDER BY id", [patient])).rows;
    expect(rows).toHaveLength(links.length); expect(rows.map(row => row.version)).toEqual([1, 2, 3, 4]);
    expect(rows.map(row => row.supersedes)).toEqual([null, ...saved.slice(0, -1).map(row => row.id)]);
    expect(rows.map(row => row.ortho_case_id)).toEqual([null, caseId, null, oldCase]);
    expect(rows.map(row => row.visit_id)).toEqual([null, null, visitId, signedVisit]);
    expect((await db.listPatientDiagnoses(patient)).map(row => row.id)).toEqual(saved.map(row => row.id).reverse());
    expect((await db.listPatientDiagnoses(patient, caseId)).map(row => row.id)).toEqual([saved[1].id]);
    expect((await db.listPatientDiagnoses(patient, oldCase)).map(row => row.id)).toEqual([saved[3].id]);
  });
  it("rejects absent patients and malformed direct-caller IDs without any diagnosis mutation", async () => {
    const before = await snapshot();
    await expect(db.recordPatientDiagnosis(input({ patientId: 2147483647 }))).rejects.toMatchObject({ name: "DiagnosisAssociationError" });
    for (const field of ["patientId", "orthoCaseId", "visitId"] as const) {
      for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2147483648]) {
        await expect(db.recordPatientDiagnosis(input({ [field]: value }))).rejects.toMatchObject({ name: "DiagnosisAssociationError" });
      }
    }
    expect(await snapshot()).toEqual(before);
  });
  it("rejects missing/foreign cases and missing/foreign/unlinked visits atomically", async () => {
    const before = await snapshot();
    for (const links of [{ orthoCaseId: foreignCase }, { orthoCaseId: 2147483647 },
      { visitId: foreignVisit }, { visitId: unlinkedVisit }, { visitId: 2147483647 },
      { orthoCaseId: caseId, visitId: foreignVisit }, { orthoCaseId: foreignCase, visitId }]) {
      await expect(db.recordPatientDiagnosis(input(links))).rejects.toMatchObject({ name: "DiagnosisAssociationError" });
    }
    expect(await snapshot()).toEqual(before);
  });
  it("preserves the global history but never displays an inconsistent legacy association as case history", async () => {
    // Deliberately seed historical corruption in the disposable fixture. The read
    // projection must suppress it only in a case view, without correcting data.
    const { rows: [legacy] } = await pool.query(`INSERT INTO patient_diagnoses
      (patient_id,version,content,label,ortho_case_id,created_by)
      VALUES ($1,99,'{"note":"Synthetic legacy mismatch"}',NULL,$2,'synthetic') RETURNING id`, [patient, foreignCase]);
    const before = await snapshot();
    expect((await db.listPatientDiagnoses(patient)).some(row => row.id === legacy.id)).toBe(true);
    expect(await db.listPatientDiagnoses(patient, foreignCase)).toEqual([]);
    expect(await db.listPatientDiagnoses(foreignPatient, caseId)).toEqual([]);
    expect(await db.listPatientDiagnoses(patient, 2147483647)).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });
});

describe("real PostgreSQL diagnosis serialization", () => {
  it("serializes simultaneous first and later versions, including across cases and standalone history", async () => {
    const { rows: [fresh] } = await pool.query("INSERT INTO patients (patient_number,full_name) VALUES ('DX-RACE','Synthetic race') RETURNING id");
    const { rows: freshCases } = await pool.query(`INSERT INTO ortho_cases (patient_id,appliance,arches,slot,start_date,planned_months,created_by,status)
      VALUES ($1,'fixed_metal','both','022',CURRENT_DATE,12,'synthetic','active'),
             ($1,'fixed_metal','both','022',CURRENT_DATE,12,'synthetic','completed') RETURNING id`, [fresh.id]);
    for (let round = 0; round < 2; round++) {
      const before = (await pool.query("SELECT * FROM patient_diagnoses WHERE patient_id=$1 ORDER BY id", [fresh.id])).rows;
      const results = await Promise.all(Array.from({ length: 8 }, (_, i) => db.recordPatientDiagnosis(input({ patientId: fresh.id,
        orthoCaseId: i % 3 === 0 ? null : freshCases[i % 2].id,
        content: { note: `Synthetic concurrent ${round}-${i}` } }))));
      expect(new Set(results.map(row => row.version)).size).toBe(8);
      const history = await db.listPatientDiagnoses(fresh.id);
      const count = (round + 1) * 8;
      expect(history.map(row => row.version)).toEqual(Array.from({ length: count }, (_, i) => count - i));
      const ascending = [...history].reverse(); expect(ascending.map(row => row.supersedes)).toEqual([null, ...ascending.slice(0, -1).map(row => row.id)]);
      const after = (await pool.query("SELECT * FROM patient_diagnoses WHERE patient_id=$1 ORDER BY id", [fresh.id])).rows;
      expect(after.slice(0, before.length)).toEqual(before);
    }
  });
  it("does not deadlock a visit-holder filling a non-key patient field", async () => {
    const blocker = await pool.connect();
    const before = await snapshot();
    let result: ReturnType<typeof db.recordPatientDiagnosis> | null = null;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SET LOCAL lock_timeout = '2s'");
      const { rows: [identity] } = await blocker.query("SELECT pg_backend_pid() AS pid");
      await blocker.query("SELECT id FROM visits WHERE id=$1 FOR UPDATE", [visitId]);
      result = db.recordPatientDiagnosis(input({ visitId, orthoCaseId: caseId }));
      const deadline = Date.now() + 10_000;
      let blocked = false;
      while (Date.now() < deadline) {
        const { rows: [state] } = await pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS blocked", [identity.pid]);
        if (state.blocked) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(blocked).toBe(true);
      // Mirrors resolveVisitPatientDetailed's visit → non-key patient UPDATE:
      // a diagnosis's parent lock must not turn this into the opposite order.
      await blocker.query("UPDATE patients SET phone='770000001' WHERE id=$1", [patient]);
      await blocker.query("COMMIT");
      const saved = await result;
      const after = await snapshot(); expect(after.slice(0, before.length)).toEqual(before);
      expect(after).toHaveLength(before.length + 1); expect(after.at(-1)?.id).toBe(saved.id);
    } finally {
      await blocker.query("ROLLBACK").catch(() => {}); blocker.release();
      if (result) await result.catch(() => {});
      await pool.query("UPDATE patients SET phone=NULL WHERE id=$1", [patient]);
    }
  });
  it("rechecks a visit after a concurrent ownership update and refuses the diagnosis without a row", async () => {
    const blocker = await pool.connect();
    const before = await snapshot();
    let result: Promise<{ error: unknown }> | null = null;
    try {
      await blocker.query("BEGIN");
      const { rows: [identity] } = await blocker.query("SELECT pg_backend_pid() AS pid");
      await blocker.query("UPDATE visits SET patient_id=$2 WHERE id=$1", [visitId, foreignPatient]);
      result = db.recordPatientDiagnosis(input({ visitId, orthoCaseId: caseId })).then(() => ({ error: null }), error => ({ error }));
      const deadline = Date.now() + 10_000;
      let blocked = false;
      while (Date.now() < deadline) {
        const { rows: [state] } = await pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS blocked", [identity.pid]);
        if (state.blocked) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(blocked).toBe(true);
      await blocker.query("COMMIT");
      expect((await result).error).toMatchObject({ name: "DiagnosisAssociationError" });
      expect(await snapshot()).toEqual(before);
    } finally {
      await blocker.query("ROLLBACK").catch(() => {}); blocker.release();
      if (result) await result;
      await pool.query("UPDATE visits SET patient_id=$2 WHERE id=$1", [visitId, patient]);
    }
  });
});
