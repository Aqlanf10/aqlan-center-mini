import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validatePostgresTestTarget } from "./_safe-target";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
import { VISIT_RECORD_REFERENCES } from "../../lib/visit-record-identity";
import type { DbClient } from "../../lib/db";
import { checkEndoVisitDraft } from "../../lib/endodontics";

// Ordinary, already-linked synthetic ownership fixtures only. Runtime belongs to
// the guarded disposable PostgreSQL 18 runner; no external route or access harness.
const target = validatePostgresTestTarget(process.env, { allowDatabaseUrlFallback: true });
assertRealPostgresUrl();
stubPostgresEnv();
const db = await import("../../lib/db");
const endo = await import("../../lib/endodontics-db");
const perio = await import("../../lib/periodontics-db");
const q = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []) =>
  (await db.getPool().query<T>(sql, values)).rows;
const insertId = async (sql: string, values: unknown[] = []) => (await q<{ id: number }>(sql, values))[0].id;
let sequence = 0;
let doctorId: number;
let serviceId: number;

beforeAll(async () => {
  await dropPublicSchema(target.testUrl.toString());
  await db.ensureSchema();
  doctorId = await insertId(`INSERT INTO parties (kind, name) VALUES ('doctor', 'Synthetic identity doctor') RETURNING id`);
  serviceId = await insertId(`INSERT INTO services (name, category, price_minor, price_configured)
    VALUES ('Synthetic identity service', 'cleaning', 100, TRUE) RETURNING id`);
}, 180_000);
afterAll(async () => { await db.resetPoolForTesting(); });

async function fixture() {
  const n = ++sequence;
  const patientId = await insertId(`INSERT INTO patients (patient_number, full_name) VALUES ($1, 'Synthetic owner A') RETURNING id`, [`VI-A-${n}`]);
  const otherPatientId = await insertId(`INSERT INTO patients (patient_number, full_name) VALUES ($1, 'Synthetic owner B') RETURNING id`, [`VI-B-${n}`]);
  const visitId = await insertId(`INSERT INTO visits (patient_id, patient_name, doctor_id, status, note)
    VALUES ($1, 'Synthetic owner A', $2, 'done', 'Operational note is not clinical history') RETURNING id`, [patientId, doctorId]);
  return { patientId, otherPatientId, visitId };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function snapshot(visitId: number) {
  const result: Record<string, unknown> = { visit: await q(`SELECT * FROM visits WHERE id = $1`, [visitId]) };
  for (const { table } of VISIT_RECORD_REFERENCES) {
    result[table] = await q(`SELECT * FROM ${table} WHERE visit_id = $1 ORDER BY id`, [visitId]);
  }
  return result;
}

async function addEndo(f: Fixture) {
  const caseId = await insertId(`INSERT INTO clinical_cases (patient_id, specialty, title, created_by)
    VALUES ($1, 'endodontics', 'Synthetic Endo', 'identity-test') RETURNING id`, [f.patientId]);
  const treatmentId = await insertId(`INSERT INTO endo_treatments (patient_id, case_id, tooth_code, created_by)
    VALUES ($1, $2, 36, 'identity-test') RETURNING id`, [f.patientId, caseId]);
  // An empty persisted header is still a record with stable identity.
  return insertId(`INSERT INTO endo_visits (treatment_id, visit_id, doctor_id, recorded_by)
    VALUES ($1, $2, $3, 'identity-test') RETURNING id`, [treatmentId, f.visitId, doctorId]);
}
async function addOrtho(f: Fixture) {
  const caseId = await insertId(`INSERT INTO ortho_cases (patient_id, appliance, arches, slot, start_date, planned_months, created_by)
    VALUES ($1, 'fixed_metal', 'both', '022', CURRENT_DATE, 12, 'identity-test') RETURNING id`, [f.patientId]);
  return insertId(`INSERT INTO ortho_adjustments (case_id, visit_id, done_on, elastics, next_weeks, recorded_by)
    VALUES ($1, $2, CURRENT_DATE, 'none', 4, 'identity-test') RETURNING id`, [caseId, f.visitId]);
}
async function addDocument(f: Fixture) {
  const record = await db.recordDocument({ patientId: f.patientId, visitId: f.visitId, kind: "photo",
    title: "Synthetic identity document", mimeType: "image/png", sizeBytes: 1, sha256: "a".repeat(64),
    storageKey: `synthetic-identity-${f.visitId}.png`, note: null, takenOn: null, uploadedBy: "identity-test" });
  await db.removeDocument({ id: record.id, actor: "identity-test", note: "Synthetic hidden metadata remains history" });
  return record.id;
}
const addChart = (f: Fixture) => db.recordToothCondition({ patientId: f.patientId, visitId: f.visitId,
  toothCode: 11, condition: "caries", stage: "existing", recordedBy: "identity-test" });
const addPerio = (f: Fixture) => insertId(`INSERT INTO perio_exams (visit_id, doctor_id, recorded_by)
  VALUES ($1, $2, 'identity-test') RETURNING id`, [f.visitId, doctorId]);
const addProcedure = (f: Fixture) => insertId(`INSERT INTO visit_procedures (visit_id, service_id, doctor_id, unit_price_minor, note)
  VALUES ($1, $2, $3, 100, 'Synthetic saved procedure') RETURNING id`, [f.visitId, serviceId, doctorId]);
const addDiagnosis = (f: Fixture) => insertId(`INSERT INTO patient_diagnoses (patient_id, visit_id, content, created_by)
  VALUES ($1, $2, '{"synthetic":"retained diagnosis"}'::jsonb, 'identity-test') RETURNING id`, [f.patientId, f.visitId]);
const addPlanned = (f: Fixture) => insertId(`INSERT INTO planned_visits (patient_id, visit_id, sequence, title)
  VALUES ($1, $2, 1, 'Synthetic planned visit') RETURNING id`, [f.patientId, f.visitId]);
async function addMovement(f: Fixture) {
  const itemId = await insertId(`INSERT INTO inventory_items (name, unit, created_by)
    VALUES ('Synthetic identity material', 'piece', 'identity-test') RETURNING id`);
  return insertId(`INSERT INTO inventory_movements (item_id, patient_id, visit_id, kind, qty, created_by)
    VALUES ($1, $2, $3, 'out', 1, 'identity-test') RETURNING id`, [itemId, f.patientId, f.visitId]);
}

describe("linked visit record identity", () => {
  it.each([
    ["chart", addChart], ["periodontal header", addPerio], ["Endo header", addEndo],
    ["Ortho adjustment", addOrtho], ["hidden document", addDocument], ["procedure", addProcedure],
  ] as const)("refuses moving %s without changing any linked record", async (_label, record) => {
    const f = await fixture();
    await record(f);
    const before = await snapshot(f.visitId);
    expect(await db.linkVisitToPatient(f.visitId, f.otherPatientId)).toMatchObject({ ok: false, reason: "has_clinical_history" });
    expect(await snapshot(f.visitId)).toEqual(before);
    expect(await db.linkVisitToPatient(f.visitId, f.patientId)).toEqual({ ok: true, patientName: "Synthetic owner A" });
    expect(await snapshot(f.visitId)).toEqual(before);
  });

  it.each(["chief_complaint", "examination", "diagnosis", "treatment_done", "next_plan", "addendum"])(
    "protects saved intrinsic %s while leaving the row intact", async column => {
      const f = await fixture();
      await q(`UPDATE visits SET ${column} = 'Synthetic saved clinical text' WHERE id = $1`, [f.visitId]);
      const before = await snapshot(f.visitId);
      expect(await db.linkVisitToPatient(f.visitId, f.otherPatientId)).toMatchObject({ ok: false, reason: "has_clinical_history" });
      expect(await snapshot(f.visitId)).toEqual(before);
    });

  it("retains empty standalone correction with operational notes", async () => {
    const f = await fixture();
    expect(await db.linkVisitToPatient(f.visitId, f.otherPatientId)).toEqual({ ok: true, patientName: "Synthetic owner B" });
    expect(await q(`SELECT patient_id, note FROM visits WHERE id = $1`, [f.visitId])).toEqual([
      { patient_id: f.otherPatientId, note: "Operational note is not clinical history" },
    ]);
  });

  it.each(["+967700000202", null])("replaces the prior owner's phone with the corrected owner's canonical %s", async phone => {
    const f = await fixture();
    await q(`UPDATE patients SET phone = '+967700000101' WHERE id = $1`, [f.patientId]);
    await q(`UPDATE visits SET patient_phone = '+967700000101' WHERE id = $1`, [f.visitId]);
    await q(`UPDATE patients SET phone = $2 WHERE id = $1`, [f.otherPatientId, phone]);
    expect(await db.linkVisitToPatient(f.visitId, f.otherPatientId)).toEqual({ ok: true, patientName: "Synthetic owner B" });
    expect(await q(`SELECT patient_id, patient_name, patient_phone FROM visits WHERE id = $1`, [f.visitId]))
      .toEqual([{ patient_id: f.otherPatientId, patient_name: "Synthetic owner B", patient_phone: phone }]);
  });

  it("preserves the existing same-owner visit contact refresh behavior", async () => {
    const f = await fixture();
    await q(`UPDATE patients SET phone = '+967700000101' WHERE id = $1`, [f.patientId]);
    await q(`UPDATE visits SET patient_phone = '+967700000303' WHERE id = $1`, [f.visitId]);
    expect(await db.linkVisitToPatient(f.visitId, f.patientId)).toMatchObject({ ok: true });
    expect(await q(`SELECT patient_phone FROM visits WHERE id = $1`, [f.visitId]))
      .toEqual([{ patient_phone: "+967700000303" }]);
  });

  it("retains signed refusal, including a same-patient request", async () => {
    const f = await fixture();
    await q(`UPDATE visits SET signed_at = NOW(), signed_by = 'identity-test' WHERE id = $1`, [f.visitId]);
    const before = await snapshot(f.visitId);
    expect(await db.linkVisitToPatient(f.visitId, f.patientId)).toMatchObject({ ok: false, reason: "signed" });
    expect(await snapshot(f.visitId)).toEqual(before);
  });

  it("refuses moving a blank appointment encounter without detaching its context", async () => {
    const f = await fixture();
    const appointmentId = await insertId(`INSERT INTO appointments (patient_id, scheduled_date, scheduled_time)
      VALUES ($1, CURRENT_DATE, '09:00') RETURNING id`, [f.patientId]);
    await q(`UPDATE visits SET appointment_id = $2 WHERE id = $1`, [f.visitId, appointmentId]);
    const before = await snapshot(f.visitId);
    expect(await db.linkVisitToPatient(f.visitId, f.otherPatientId)).toMatchObject({ ok: false, reason: "has_linked_workflow" });
    expect(await snapshot(f.visitId)).toEqual(before);
  });

  it("preserves eligible whole-patient merge with stable clinical record IDs and contents", async () => {
    const f = await fixture();
    await addEndo(f); await addOrtho(f); await addDocument(f); await addChart(f); await addPerio(f);
    const before = await snapshot(f.visitId);
    expect(await db.mergeDuplicatePatient(f.patientId, f.otherPatientId, { actor: "identity-test", actorRole: "admin" }))
      .toMatchObject({ ok: true });
    const after = await snapshot(f.visitId);
    for (const { table } of VISIT_RECORD_REFERENCES) {
      const normalize = (rows: unknown) => (rows as Record<string, unknown>[]).map(({ patient_id: _owner, ...record }) => record);
      expect(normalize(after[table])).toEqual(normalize(before[table]));
    }
    expect(await q(`SELECT patient_id FROM visits WHERE id = $1`, [f.visitId])).toEqual([{ patient_id: f.otherPatientId }]);
    expect(await q(`SELECT patient_id FROM endo_treatments WHERE id IN (SELECT treatment_id FROM endo_visits WHERE visit_id = $1)`, [f.visitId]))
      .toEqual([{ patient_id: f.otherPatientId }]);
  });
});

describe("existing visit deletion protections", () => {
  it.each([
    ["Endo", addEndo, "has_clinical_history"], ["Perio", addPerio, "has_clinical_history"],
    ["diagnosis", addDiagnosis, "has_clinical_history"], ["planned backlink", addPlanned, "has_linked_workflow"],
    ["inventory", addMovement, "has_financial_history"],
  ] as const)("returns a typed %s conflict before any detachment", async (_label, record, reason) => {
    const f = await fixture();
    await addChart(f); await addDocument(f); await addProcedure(f); await record(f);
    const before = await snapshot(f.visitId);
    const audits = await q(`SELECT id FROM audit_log WHERE action = 'visit.delete' ORDER BY id`);
    expect(await db.deleteVisit(f.visitId, { actor: "identity-test", actorRole: "admin" })).toEqual({ ok: false, reason });
    expect(await snapshot(f.visitId)).toEqual(before);
    expect(await q(`SELECT id FROM audit_log WHERE action = 'visit.delete' ORDER BY id`)).toEqual(audits);
  });

  it("retains explicitly permitted unsigned chart/vitals/document detach and procedure removal", async () => {
    const f = await fixture();
    const chart = await addChart(f);
    const documentId = await addDocument(f);
    await addProcedure(f);
    const vitalsId = await insertId(`INSERT INTO patient_vitals (patient_id, visit_id, pulse, recorded_by)
      VALUES ($1, $2, 70, 'identity-test') RETURNING id`, [f.patientId, f.visitId]);
    const chartBefore = (await q(`SELECT * FROM tooth_conditions WHERE id = $1`, [chart!.id]))[0];
    const vitalsBefore = (await q(`SELECT * FROM patient_vitals WHERE id = $1`, [vitalsId]))[0];
    const documentBefore = (await q(`SELECT * FROM patient_documents WHERE id = $1`, [documentId]))[0];
    expect(await db.deleteVisit(f.visitId, { actor: "identity-test", actorRole: "admin" })).toEqual({ ok: true });
    expect(await q(`SELECT * FROM visits WHERE id = $1`, [f.visitId])).toEqual([]);
    expect(await q(`SELECT * FROM visit_procedures WHERE visit_id = $1`, [f.visitId])).toEqual([]);
    expect(await q(`SELECT * FROM tooth_conditions WHERE id = $1`, [chart!.id])).toEqual([{ ...chartBefore, visit_id: null }]);
    expect(await q(`SELECT * FROM patient_vitals WHERE id = $1`, [vitalsId])).toEqual([{ ...vitalsBefore, visit_id: null }]);
    expect(await q(`SELECT * FROM patient_documents WHERE id = $1`, [documentId])).toEqual([{ ...documentBefore, visit_id: null }]);
  });
});

type WriterKind = "chart" | "Perio" | "Endo" | "Ortho" | "document" | "atomic draft";
async function prepareWriter(kind: WriterKind, f: Fixture): Promise<{
  table: string; event: "INSERT" | "UPDATE"; waitingSql: string; write: () => Promise<boolean>;
}> {
  const actor = { actor: "identity-test", actorRole: "admin" };
  switch (kind) {
    case "chart": return {
      table: "tooth_conditions", event: "INSERT", waitingSql: "SELECT id FROM visits WHERE id = $1 AND patient_id = $2 FOR SHARE",
      write: async () => { try { return (await addChart(f)) !== null; } catch (error) {
        if (error instanceof db.ToothVisitConflict) return false; throw error;
      } },
    };
    case "document": return {
      table: "patient_documents", event: "INSERT", waitingSql: "SELECT patient_id FROM visits WHERE id = $1 FOR SHARE",
      write: async () => { try { await addDocument(f); return true; } catch (error) {
        if (error instanceof db.DocumentAssociationError) return false; throw error;
      } },
    };
    case "Perio": return {
      table: "perio_exams", event: "INSERT", waitingSql: "SELECT patient_id, signed_at, case_id FROM visits",
      write: async () => {
        const result = await perio.savePerioExam({ ...actor, patientId: f.patientId, visitId: f.visitId,
          expectedRevision: null, draft: { doctorId, caseId: null, sites: [{ toothCode: 11, site: "MB", probingDepthMm: 2, bleedingOnProbing: false }] } });
        if (!result.ok) expect(result.reason).toBe("not_found");
        return result.ok;
      },
    };
    case "Endo": {
      const caseId = await insertId(`INSERT INTO clinical_cases (patient_id, specialty, title, created_by)
        VALUES ($1, 'endodontics', 'Synthetic race Endo', 'identity-test') RETURNING id`, [f.patientId]);
      const treatmentId = await insertId(`INSERT INTO endo_treatments (patient_id, case_id, tooth_code, created_by)
        VALUES ($1, $2, 36, 'identity-test') RETURNING id`, [f.patientId, caseId]);
      const draft = checkEndoVisitDraft({ note: "Synthetic saved Endo record" });
      if (!draft.ok) throw new Error(draft.message);
      return {
        table: "endo_visits", event: "INSERT", waitingSql: "SELECT patient_id, doctor_id, signed_at FROM visits",
        write: async () => {
          const result = await endo.saveEndoVisit({ ...actor, patientId: f.patientId, treatmentId, visitId: f.visitId,
            expectedVersion: null, actorPartyId: doctorId, draft: draft.value });
          if (!result.ok) expect(result.reason).toBe("wrong_patient");
          return result.ok;
        },
      };
    }
    case "Ortho": {
      const caseId = await insertId(`INSERT INTO ortho_cases (patient_id, appliance, arches, slot, start_date, planned_months, created_by)
        VALUES ($1, 'fixed_metal', 'both', '022', CURRENT_DATE, 12, 'identity-test') RETURNING id`, [f.patientId]);
      return {
        table: "ortho_adjustments", event: "INSERT", waitingSql: "SELECT signed_at FROM visits WHERE id = $1 FOR UPDATE",
        write: async () => {
          const result = await db.recordAdjustment({ caseId, visitId: f.visitId, doneOn: "2026-10-03", phase: null,
            upperWire: null, lowerWire: null, elastics: "none", elasticNote: null, done: "Synthetic adjustment",
            nextWeeks: 4, note: null, recordedBy: actor.actor, actorRole: actor.actorRole });
          if (!result.ok) expect(result.message).toContain("لمريضين مختلفين");
          return result.ok;
        },
      };
    }
    case "atomic draft": return {
      table: "visits", event: "UPDATE", waitingSql: "FROM visits WHERE id = $1 FOR UPDATE",
      write: async () => {
        try {
          return await db.saveClinicalDraft({ visitId: f.visitId, authorizedPatientId: f.patientId,
            actor: { username: actor.actor, role: "admin" }, doctorId,
            chiefComplaint: null, examination: null, diagnosis: "Synthetic atomic diagnosis", treatmentDone: null, nextPlan: null });
        } catch (error) { if (error instanceof db.ClinicalDraftAccessRejected) return false; throw error; }
      },
    };
  }
}

async function waitForLock(observer: DbClient, queryFragment: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    // The merge-order observer holds a transaction while checking multiple waits.
    await observer.query("SELECT pg_stat_clear_snapshot()");
    const { rows: [row] } = await observer.query<{ waiting: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
        AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query LIKE $1) AS waiting`, [`%${queryFragment}%`]);
    if (row.waiting) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Expected synthetic lock wait: ${queryFragment}`);
}

describe("already-fenced linked visit writers", () => {
  const kinds: WriterKind[] = ["chart", "Perio", "Endo", "Ortho", "document", "atomic draft"];
  it.each(kinds)("writer-first %s remains with its original visit owner", async kind => {
    const f = await fixture();
    const writer = await prepareWriter(kind, f);
    const gate = await db.getPool().connect();
    let write: Promise<boolean> | undefined;
    let relink: ReturnType<typeof db.linkVisitToPatient> | undefined;
    try {
      await gate.query(`SELECT pg_advisory_lock(716511)`);
      await q(`CREATE FUNCTION identity_pause_writer() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM pg_advisory_xact_lock(716511); RETURN NEW; END $$`);
      await q(`CREATE TRIGGER identity_pause_writer BEFORE ${writer.event} ON ${writer.table} FOR EACH ROW
        ${writer.event === "UPDATE" ? "WHEN (NEW.diagnosis IS DISTINCT FROM OLD.diagnosis)" : ""}
        EXECUTE FUNCTION identity_pause_writer()`);
      write = writer.write(); void write.catch(() => {});
      await waitForLock(gate, writer.event === "INSERT" ? `INSERT INTO ${writer.table}` : "UPDATE visits SET chief_complaint");
      relink = db.linkVisitToPatient(f.visitId, f.otherPatientId); void relink.catch(() => {});
      await waitForLock(gate, "SELECT signed_at, patient_id FROM visits WHERE id = $1 FOR UPDATE");
      await gate.query(`SELECT pg_advisory_unlock(716511)`);
      expect(await write).toBe(true);
      const before = await snapshot(f.visitId);
      expect(await relink).toMatchObject({ ok: false, reason: "has_clinical_history" });
      expect(await snapshot(f.visitId)).toEqual(before);
      expect(await q(`SELECT patient_id FROM visits WHERE id = $1`, [f.visitId])).toEqual([{ patient_id: f.patientId }]);
    } finally {
      await gate.query(`SELECT pg_advisory_unlock(716511)`).catch(() => {});
      await Promise.allSettled([write, relink]);
      await q(`DROP TRIGGER IF EXISTS identity_pause_writer ON ${writer.table}`);
      await q(`DROP FUNCTION IF EXISTS identity_pause_writer()`);
      gate.release();
    }
  }, 25_000);

  it.each(kinds)("relink-first %s rejects stale ownership without leaving a record", async kind => {
    const f = await fixture();
    const writer = await prepareWriter(kind, f);
    const gate = await db.getPool().connect();
    let write: Promise<boolean> | undefined;
    let relink: ReturnType<typeof db.linkVisitToPatient> | undefined;
    try {
      await gate.query(`SELECT pg_advisory_lock(716512)`);
      await q(`CREATE FUNCTION identity_pause_relink() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM pg_advisory_xact_lock(716512); RETURN NEW; END $$`);
      await q(`CREATE TRIGGER identity_pause_relink BEFORE UPDATE ON visits FOR EACH ROW
        WHEN (NEW.patient_id IS DISTINCT FROM OLD.patient_id) EXECUTE FUNCTION identity_pause_relink()`);
      relink = db.linkVisitToPatient(f.visitId, f.otherPatientId); void relink.catch(() => {});
      await waitForLock(gate, "UPDATE visits SET patient_id = $2, patient_name = $3");
      write = writer.write(); void write.catch(() => {});
      await waitForLock(gate, writer.waitingSql);
      await gate.query(`SELECT pg_advisory_unlock(716512)`);
      expect(await relink).toEqual({ ok: true, patientName: "Synthetic owner B" });
      expect(await write).toBe(false);
      for (const { table } of VISIT_RECORD_REFERENCES) {
        expect(await q(`SELECT id FROM ${table} WHERE visit_id = $1`, [f.visitId])).toEqual([]);
      }
      expect(await q(`SELECT patient_id, diagnosis FROM visits WHERE id = $1`, [f.visitId]))
        .toEqual([{ patient_id: f.otherPatientId, diagnosis: null }]);
    } finally {
      await gate.query(`SELECT pg_advisory_unlock(716512)`).catch(() => {});
      await Promise.allSettled([write, relink]);
      await q(`DROP TRIGGER IF EXISTS identity_pause_relink ON visits`);
      await q(`DROP FUNCTION IF EXISTS identity_pause_relink()`);
      gate.release();
    }
  }, 25_000);
});

describe("ordinary relink alongside whole-patient merge", () => {
  it("rechecks the sampled mapping after waiting behind a patient-first merge", async () => {
    const f = await fixture();
    const mergedOwner = await insertId(`INSERT INTO patients (patient_number, full_name)
      VALUES ($1, 'Synthetic merged owner') RETURNING id`, [`VI-MERGED-${++sequence}`]);
    const gate = await db.getPool().connect();
    let merge: ReturnType<typeof db.mergeDuplicatePatient> | undefined;
    let relink: ReturnType<typeof db.linkVisitToPatient> | undefined;
    try {
      await gate.query("BEGIN");
      await gate.query(`SELECT id FROM patients WHERE id = $1 FOR UPDATE`, [f.patientId]);
      merge = db.mergeDuplicatePatient(f.patientId, mergedOwner, { actor: "identity-test", actorRole: "admin" });
      void merge.catch(() => {});
      await waitForLock(gate, "FROM patients WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE");
      relink = db.linkVisitToPatient(f.visitId, f.otherPatientId); void relink.catch(() => {});
      await waitForLock(gate, "FROM patients WHERE id = ANY($1::int[]) ORDER BY id FOR KEY SHARE");
      await gate.query("COMMIT");
      expect(await merge).toMatchObject({ ok: true });
      expect(await relink).toMatchObject({ ok: false, reason: "identity_changed" });
      expect(await q(`SELECT patient_id FROM visits WHERE id = $1`, [f.visitId])).toEqual([{ patient_id: mergedOwner }]);
      expect(await q(`SELECT id FROM patients WHERE id = $1`, [f.patientId])).toEqual([]);
    } finally {
      await gate.query("ROLLBACK").catch(() => {});
      await Promise.allSettled([merge, relink]);
      gate.release();
    }
  }, 25_000);

  it("lets an eligible whole-patient merge follow a completed empty-visit correction", async () => {
    const f = await fixture();
    const mergedOwner = await insertId(`INSERT INTO patients (patient_number, full_name)
      VALUES ($1, 'Synthetic merged owner') RETURNING id`, [`VI-MERGED-${++sequence}`]);
    const gate = await db.getPool().connect();
    let merge: ReturnType<typeof db.mergeDuplicatePatient> | undefined;
    let relink: ReturnType<typeof db.linkVisitToPatient> | undefined;
    try {
      await gate.query(`SELECT pg_advisory_lock(716513)`);
      await q(`CREATE FUNCTION identity_pause_merge_order() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM pg_advisory_xact_lock(716513); RETURN NEW; END $$`);
      await q(`CREATE TRIGGER identity_pause_merge_order BEFORE UPDATE ON visits FOR EACH ROW
        WHEN (NEW.patient_id IS DISTINCT FROM OLD.patient_id) EXECUTE FUNCTION identity_pause_merge_order()`);
      relink = db.linkVisitToPatient(f.visitId, f.otherPatientId); void relink.catch(() => {});
      await waitForLock(gate, "UPDATE visits SET patient_id = $2, patient_name = $3");
      merge = db.mergeDuplicatePatient(f.otherPatientId, mergedOwner, { actor: "identity-test", actorRole: "admin" });
      void merge.catch(() => {});
      await waitForLock(gate, "FROM patients WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE");
      await gate.query(`SELECT pg_advisory_unlock(716513)`);
      expect(await relink).toMatchObject({ ok: true });
      expect(await merge).toMatchObject({ ok: true });
      expect(await q(`SELECT patient_id FROM visits WHERE id = $1`, [f.visitId])).toEqual([{ patient_id: mergedOwner }]);
    } finally {
      await gate.query(`SELECT pg_advisory_unlock(716513)`).catch(() => {});
      await Promise.allSettled([merge, relink]);
      await q(`DROP TRIGGER IF EXISTS identity_pause_merge_order ON visits`);
      await q(`DROP FUNCTION IF EXISTS identity_pause_merge_order()`);
      gate.release();
    }
  }, 25_000);
});
