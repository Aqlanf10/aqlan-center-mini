// Reconciled from recovered 09:01/09:10 source fragments after environment loss.
// Later arrival/case/audit regressions below are reconstructed and need fresh PG proof.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { validatePostgresTestTarget } from "./_safe-target";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
import { PERIODONTICS_SQL } from "../../lib/periodontics-schema";
import { type PerioDraft, type PerioObservation } from "../../lib/periodontics";
import type { DbClient } from "../../lib/db";

// Every fixture below is synthetic in the repository's explicitly guarded disposable PG18 database.
const target = validatePostgresTestTarget(process.env, { allowDatabaseUrlFallback: true });
assertRealPostgresUrl(); stubPostgresEnv();
process.env.SKIP_SEED = "true";
const db = await import("../../lib/db");
const perio = await import("../../lib/periodontics-db");
const q = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.getPool().query<T>(sql, values)).rows;
let sequence = 0; let doctor: number; let otherDoctor: number; let supplier: number;
const actor = { actor: "synthetic recorder", actorRole: "admin" };
const site = (change: Partial<PerioObservation> = {}): PerioObservation => ({ toothCode: 11, site: "MB", probingDepthMm: 0, bleedingOnProbing: false, ...change });
beforeAll(async () => {
  await dropPublicSchema(target.testUrl.toString()); await db.ensureSchema();
  const providers = await q<{ id: number }>(`INSERT INTO parties (kind, name) VALUES ('doctor','Perio doctor'),('doctor','Other doctor'),('supplier','Not a doctor') RETURNING id`);
  [doctor, otherDoctor, supplier] = providers.map((provider) => provider.id);
});
afterAll(async () => { vi.restoreAllMocks(); await db.resetPoolForTesting(); });
async function fixture() {
  const patientId = (await q<{ id: number }>(`INSERT INTO patients (patient_number, full_name) VALUES ($1, 'Synthetic periodontal patient') RETURNING id`, [`PERIO-${++sequence}`]))[0].id;
  const visitId = (await q<{ id: number }>(`INSERT INTO visits (patient_id, patient_name, doctor_id) VALUES ($1,'Synthetic periodontal patient',$2) RETURNING id`, [patientId, otherDoctor]))[0].id;
  const caseId = (await q<{ id: number }>(`INSERT INTO clinical_cases (patient_id,specialty,title,created_by) VALUES ($1,'periodontics','Synthetic perio case','synthetic') RETURNING id`, [patientId]))[0].id;
  const draft = (sites: PerioObservation[] = [site()], changes: Partial<PerioDraft> = {}): PerioDraft => ({ doctorId: doctor, caseId, sites, ...changes });
  const save = (sites: PerioObservation[] = [site()], expectedRevision: number | null = null, changes: Partial<PerioDraft> = {}) =>
    perio.savePerioExam({ ...actor, patientId, visitId, draft: draft(sites, changes), expectedRevision });
  const sign = () => db.signClinicalVisit({ visitId, baseCurrency: "YER", signedBy: "synthetic signer", signerDoctorPartyId: otherDoctor });
  return { patientId, visitId, caseId, draft, save, sign };
}
async function snapshot(visitId: number) {
  return { exams: await q(`SELECT * FROM perio_exams WHERE visit_id=$1 ORDER BY id`, [visitId]),
    sites: await q(`SELECT s.* FROM perio_site_observations s JOIN perio_exams e ON e.id=s.exam_id WHERE e.visit_id=$1 ORDER BY s.id`, [visitId]),
    addenda: await q(`SELECT a.* FROM perio_addenda a JOIN perio_exams e ON e.id=a.exam_id WHERE e.visit_id=$1 ORDER BY a.id`, [visitId]),
    audits: await q(`SELECT * FROM audit_log WHERE action LIKE 'perio.%' AND details->>'visitId'=$1 ORDER BY id`, [String(visitId)]) };
}
async function waitForLock(fragment: string, client: DbClient) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await client.query(`SELECT pg_stat_clear_snapshot()`);
    const { rows } = await client.query<{ waiting: boolean }>(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1) AS waiting`, [`%${fragment}%`]);
    if (rows[0].waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Expected lock wait: ${fragment}`);
}
describe("periodontal durable capture and identity", () => {
  it("fresh schema persists explicit null/zero/false and permits populated repeat migration with stable IDs/content", async () => {
    const f = await fixture();
    const result = await f.save([site(), site({ site: "B", probingDepthMm: null, bleedingOnProbing: true }), site({ toothCode: 55, site: "DL", probingDepthMm: 99.99, bleedingOnProbing: null })]);
    expect(result).toMatchObject({ ok: true, created: true, exam: { doctorId: doctor, recordedBy: actor.actor,
      summary: { recordedDepthSites: 2, recordedBleedingSites: 2, bleedingSites: 1, bleedingPercent: 50 } } });
    const before = await snapshot(f.visitId);
    await q(PERIODONTICS_SQL); await q(PERIODONTICS_SQL);
    expect(await snapshot(f.visitId)).toEqual(before);
    expect((await perio.listPatientPerio(f.patientId))[0].sites).toEqual(f.draft([site(), site({ site: "B", probingDepthMm: null, bleedingOnProbing: true }), site({ toothCode: 55, site: "DL", probingDepthMm: 99.99, bleedingOnProbing: null })]).sites);
  });
  it("serializes first create and exact retry without audit/version/time/site changes", async () => {
    const f = await fixture();
    const created = await Promise.all(Array.from({ length: 5 }, () => f.save()));
    expect(created.every((result) => result.ok)).toBe(true);
    expect(created.filter((result) => result.ok && result.created)).toHaveLength(1);
    await f.save([site({ probingDepthMm: 1.01 })], 1);
    const before = await snapshot(f.visitId);
    for (const revision of [null, 1, 2]) expect(await f.save([site({ probingDepthMm: 1.01 })], revision)).toMatchObject({ ok: true, unchanged: true });
    expect(await snapshot(f.visitId)).toEqual(before);
    expect(await f.save([site({ probingDepthMm: 1.01 })], 3)).toEqual({ ok: false, reason: "revision_conflict" });
    expect(await f.save([site({ probingDepthMm: 4 })], 1)).toEqual({ ok: false, reason: "revision_conflict" });
    expect(await snapshot(f.visitId)).toEqual(before);
  });
  it("concurrent conflicting edits have one winner and retain the existing site ID", async () => {
    const f = await fixture(); await f.save(); const before = await snapshot(f.visitId);
    const edits = await Promise.all([f.save([site({ probingDepthMm: 1 })], 1), f.save([site({ probingDepthMm: 2 })], 1)]);
    expect(edits.filter((result) => result.ok)).toHaveLength(1);
    expect(edits.filter((result) => !result.ok && result.reason === "revision_conflict")).toHaveLength(1);
    const after = await snapshot(f.visitId);
    expect(after.sites[0].id).toBe(before.sites[0].id); expect(after.exams[0].revision).toBe(2); expect(after.audits).toHaveLength(2);
  });
  it("rejects patient, case, specialty, status and non-doctor mismatches without mutation", async () => {
    const f = await fixture(); const other = await fixture();
    const wrongCase = (await q<{ id: number }>(`INSERT INTO clinical_cases (patient_id,specialty,title,created_by) VALUES ($1,'endodontics','Wrong specialty','synthetic') RETURNING id`, [f.patientId]))[0].id;
    expect(await perio.savePerioExam({ ...actor, patientId: other.patientId, visitId: f.visitId, draft: f.draft(), expectedRevision: null })).toEqual({ ok: false, reason: "not_found" });
    expect(await f.save([site()], null, { caseId: other.caseId })).toEqual({ ok: false, reason: "bad_case" });
    expect(await f.save([site()], null, { caseId: wrongCase })).toEqual({ ok: false, reason: "bad_case" });
    expect(await f.save([site()], null, { doctorId: supplier })).toEqual({ ok: false, reason: "bad_doctor" });
    await q(`UPDATE clinical_cases SET status='completed',completed_at=NOW() WHERE id=$1`, [f.caseId]);
    expect(await f.save()).toEqual({ ok: false, reason: "case_closed" });
    expect((await snapshot(f.visitId)).exams).toEqual([]);
    expect(await f.save([site()], null, { caseId: null })).toMatchObject({ ok: true, exam: { caseId: null, doctorId: doctor } });
    expect(await perio.listPatientPerio(other.patientId)).toEqual([]);
  });
  it("rejects invalid numeric data in application and SQL instead of rounding", async () => {
    const f = await fixture();
    expect(await f.save([site({ probingDepthMm: 1.234 })])).toEqual({ ok: false, reason: "bad_draft" });
    const saved = await f.save(); if (!saved.ok) throw new Error(saved.reason);
    for (const value of ["1.234", "1.230", "-0.1", "100", "NaN", "Infinity", "-Infinity"]) {
      await expect(q(`UPDATE perio_site_observations SET probing_depth_mm=$2::numeric WHERE exam_id=$1`, [saved.exam.id, value])).rejects.toThrow();
    }
    expect((await snapshot(f.visitId)).sites[0].probing_depth_mm).toBe("0");
  });
  it("rolls back the complete create/edit/addendum if the transactional audit throws", async () => {
    const f = await fixture(); const g = await fixture(); await g.save();
    const before = await snapshot(g.visitId);
    await q(`CREATE FUNCTION synthetic_refuse_perio_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action LIKE 'perio.%' THEN RAISE EXCEPTION 'synthetic perio audit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER synthetic_refuse_perio_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_refuse_perio_audit()`);
    try {
      await expect(f.save()).rejects.toThrow("synthetic perio audit failure");
      await expect(g.save([site({ probingDepthMm: 9 })], 1)).rejects.toThrow("synthetic perio audit failure");
      expect(await snapshot(g.visitId)).toEqual(before); expect((await snapshot(f.visitId)).exams).toEqual([]);
      await g.sign();
      await expect(perio.addPerioAddendum({ ...actor, patientId: g.patientId, examId: before.exams[0].id as number, text: "Correction", requestKey: "perio:audit-failure" })).rejects.toThrow("synthetic perio audit failure");
      expect((await snapshot(g.visitId)).addenda).toEqual([]);
    } finally { await q(`DROP TRIGGER synthetic_refuse_perio_audit ON audit_log; DROP FUNCTION synthetic_refuse_perio_audit()`); }
  });
});
describe("signed periodontal records and correction history", () => {
  it("empty header/all-null rows cannot sign; zero PD or recorded negative BOP can sign without money", async () => {
    for (const observations of [[], [site({ probingDepthMm: null, bleedingOnProbing: null })]]) {
      const f = await fixture(); await f.save(observations); expect((await f.sign()).reason).toBe("empty");
    }
    for (const observations of [[site({ probingDepthMm: null })], [site({ bleedingOnProbing: null })]]) {
      const f = await fixture(); await f.save(observations); const signed = await f.sign();
      expect(signed.reason).toBeNull(); expect(signed.invoiceId).toBeNull(); expect(signed.duesMinor).toBe(0);
      expect(await q(`SELECT 1 FROM visit_procedures WHERE visit_id=$1`, [f.visitId])).toEqual([]);
      expect(await q(`SELECT 1 FROM invoices WHERE patient_id=$1`, [f.patientId])).toEqual([]);
      expect(await f.save(observations, 1)).toEqual({ ok: false, reason: "visit_signed" });
    }
  });
  it("refuses direct SQL signed header/provider/context/sites/signature rewrites and inserts", async () => {
    const f = await fixture(); const g = await fixture(); const saved = await f.save(); if (!saved.ok) throw new Error(saved.reason);
    await f.sign(); const before = await snapshot(f.visitId);
    for (const sql of [
      `UPDATE perio_exams SET doctor_id=${otherDoctor} WHERE id=${saved.exam.id}`,
      `UPDATE perio_exams SET case_id=NULL WHERE id=${saved.exam.id}`,
      `UPDATE perio_exams SET revision=revision+1 WHERE id=${saved.exam.id}`,
      `UPDATE perio_exams SET visit_id=${g.visitId} WHERE id=${saved.exam.id}`,
      `DELETE FROM perio_exams WHERE id=${saved.exam.id}`,
      `UPDATE perio_site_observations SET probing_depth_mm=9 WHERE exam_id=${saved.exam.id}`,
      `DELETE FROM perio_site_observations WHERE exam_id=${saved.exam.id}`,
      `INSERT INTO perio_site_observations(exam_id,tooth_code,site,bleeding_on_probing) VALUES (${saved.exam.id},12,'MB',false)`,
      `UPDATE visits SET signed_at=NULL,signed_by=NULL WHERE id=${f.visitId}`,
      `UPDATE visits SET signed_by='other signer' WHERE id=${f.visitId}`,
    ]) await expect(q(sql)).rejects.toThrow();
    expect(await snapshot(f.visitId)).toEqual(before);
    // Legitimate lifecycle changes that preserve the signature remain available.
    await q(`UPDATE visits SET note='Operational note',status='done' WHERE id=$1`, [f.visitId]);
    expect((await perio.listPatientPerio(f.patientId))[0]).toMatchObject({ doctorId: doctor, signedBy: "synthetic signer" });
  });
  it("addenda serialize/replay once, bind exact exam/actor/body and remain append-only", async () => {
    const f = await fixture(); const g = await fixture(); const saved = await f.save(); if (!saved.ok) throw new Error(saved.reason);
    const input = { ...actor, patientId: f.patientId, examId: saved.exam.id, text: "Correction", requestKey: "perio:concurrent-addendum" };
    expect(await perio.addPerioAddendum(input)).toEqual({ ok: false, reason: "not_signed" });
    await f.sign(); const results = await Promise.all(Array.from({ length: 5 }, () => perio.addPerioAddendum(input)));
    expect(results.filter((result) => result.ok && result.created)).toHaveLength(1);
    expect(results.every((result) => result.ok)).toBe(true); const before = await snapshot(f.visitId);
    expect(await perio.addPerioAddendum({ ...input, text: "  Correction  " })).toMatchObject({ ok: true, unchanged: true });
    expect(await perio.addPerioAddendum({ ...input, text: "Other" })).toEqual({ ok: false, reason: "idempotency_conflict" });
    expect(await perio.addPerioAddendum({ ...input, actor: "someone else" })).toEqual({ ok: false, reason: "idempotency_conflict" });
    expect(await perio.addPerioAddendum({ ...input, patientId: g.patientId })).toEqual({ ok: false, reason: "not_found" });
    for (const sql of [`UPDATE perio_addenda SET body='other' WHERE exam_id=$1`, `UPDATE perio_addenda SET author='other' WHERE exam_id=$1`, `DELETE FROM perio_addenda WHERE exam_id=$1`]) await expect(q(sql, [saved.exam.id])).rejects.toThrow("append-only");
    expect(await snapshot(f.visitId)).toEqual(before);
  });
  it("preserves exam/site/addendum identities and contents through the existing synthetic whole-patient merge", async () => {
    const f = await fixture(); const g = await fixture(); const saved = await f.save(); if (!saved.ok) throw new Error(saved.reason);
    await f.sign(); await perio.addPerioAddendum({ ...actor, patientId: f.patientId, examId: saved.exam.id, text: "Correction", requestKey: "perio:merge-correction" });
    const before = await snapshot(f.visitId);
    expect(await db.mergeDuplicatePatient(f.patientId, g.patientId, { ...actor, reason: "Synthetic duplicate proof" })).toMatchObject({ ok: true });
    expect(await snapshot(f.visitId)).toEqual(before);
    expect(await perio.listPatientPerio(f.patientId)).toEqual([]);
    expect((await perio.listPatientPerio(g.patientId))[0]).toMatchObject({ id: saved.exam.id, patientId: g.patientId, visitId: f.visitId, caseId: f.caseId, signedBy: "synthetic signer" });
    expect((await q(`SELECT patient_id FROM clinical_cases WHERE id=$1`, [f.caseId]))[0].patient_id).toBe(g.patientId);
  });
  it("refuses ordinary relink and patient/visit deletion even for empty persisted headers", async () => {
    const f = await fixture(); const g = await fixture(); await f.save([]);
    expect(await db.linkVisitToPatient(f.visitId, g.patientId)).toMatchObject({ ok: false });
    expect(await db.deleteVisit(f.visitId, actor)).toEqual({ ok: false, reason: "has_clinical_history" });
    expect(await db.deletePatientCascade(f.patientId, actor)).toMatchObject({ ok: false, reason: "has_clinical_history", counts: { periodontalExams: 1 } });
    expect((await perio.listPatientPerio(f.patientId))).toHaveLength(1);
  });
});
describe("save/sign/relink ordering with independent PostgreSQL connections", () => {
  it("save owns visit first: sign waits and consumes the complete committed snapshot", async () => {
    const f = await fixture(); const gate = await db.getPool().connect();
    let saving: ReturnType<typeof f.save> | undefined; let signing: ReturnType<typeof f.sign> | undefined;
    try {
      await gate.query(`SELECT pg_advisory_lock(784101)`);
      await q(`CREATE FUNCTION synthetic_pause_perio_save() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        PERFORM pg_advisory_xact_lock(784101); RETURN NEW; END $$;
        CREATE TRIGGER synthetic_pause_perio_save BEFORE INSERT ON perio_site_observations FOR EACH ROW EXECUTE FUNCTION synthetic_pause_perio_save()`);
      // A persisted recorded BOP makes the sign preflight eligible while this edit is in flight.
      await gate.query(`SELECT pg_advisory_unlock(784101)`); await f.save(); await gate.query(`SELECT pg_advisory_lock(784101)`);
      await q(`UPDATE visits SET patient_phone='777000111' WHERE id=$1`, [f.visitId]);
      expect((await q(`SELECT phone FROM patients WHERE id=$1`, [f.patientId]))[0].phone).toBeNull();
      saving = f.save([site({ probingDepthMm: 3 })], 1); void saving.catch(() => undefined);
      await waitForLock("INSERT INTO perio_site_observations", gate);
      signing = f.sign(); void signing.catch(() => undefined); await waitForLock("FROM visits WHERE id = $1 AND signed_at IS NULL FOR UPDATE", gate);
      await gate.query(`SELECT pg_advisory_unlock(784101)`);
      expect(await saving).toMatchObject({ ok: true, exam: { revision: 2 } }); expect((await signing).reason).toBeNull();
      expect((await perio.listPatientPerio(f.patientId))[0]).toMatchObject({ revision: 2, sites: [site({ probingDepthMm: 3 })], signedBy: "synthetic signer" });
      expect((await q(`SELECT phone FROM patients WHERE id=$1`, [f.patientId]))[0].phone).not.toBeNull();
    } finally {
      await gate.query(`SELECT pg_advisory_unlock(784101)`); await Promise.allSettled([saving, signing].filter(Boolean));
      await q(`DROP TRIGGER IF EXISTS synthetic_pause_perio_save ON perio_site_observations; DROP FUNCTION IF EXISTS synthetic_pause_perio_save()`); gate.release();
    }
  });
  it("sign owns visit first: a queued changed save rechecks signature and refuses without mutation", async () => {
    const f = await fixture(); await f.save(); const before = await snapshot(f.visitId); const gate = await db.getPool().connect();
    let saving: ReturnType<typeof f.save> | undefined; let signing: ReturnType<typeof f.sign> | undefined;
    try {
      await q(`UPDATE visits SET patient_phone='777000112' WHERE id=$1`, [f.visitId]);
      expect((await q(`SELECT phone FROM patients WHERE id=$1`, [f.patientId]))[0].phone).toBeNull();
      // Statement trigger pauses BEFORE row locking: save can acquire its patient fence while sign owns the visit.
      // An UPDATE patient fence here would deadlock on release; KEY SHARE permits the non-key phone UPDATE.
      await gate.query(`SELECT pg_advisory_lock(784103)`);
      await q(`CREATE FUNCTION synthetic_pause_perio_sign() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        PERFORM pg_advisory_xact_lock(784103); RETURN NULL; END $$;
        CREATE TRIGGER synthetic_pause_perio_sign BEFORE UPDATE ON patients FOR EACH STATEMENT EXECUTE FUNCTION synthetic_pause_perio_sign()`);
      signing = f.sign(); void signing.catch(() => undefined); await waitForLock("UPDATE patients SET phone", gate);
      saving = f.save([site({ probingDepthMm: 3 })], 1); void saving.catch(() => undefined);
      await waitForLock("SELECT patient_id, signed_at, case_id FROM visits", gate);
      await gate.query(`SELECT pg_advisory_unlock(784103)`);
      expect((await signing).reason).toBeNull();
      expect(await saving).toEqual({ ok: false, reason: "visit_signed" }); expect(await snapshot(f.visitId)).toEqual(before);
      expect((await q(`SELECT phone FROM patients WHERE id=$1`, [f.patientId]))[0].phone).not.toBeNull();
    } finally {
      await gate.query(`SELECT pg_advisory_unlock(784103)`); await Promise.allSettled([saving, signing].filter(Boolean));
      await q(`DROP TRIGGER IF EXISTS synthetic_pause_perio_sign ON patients; DROP FUNCTION IF EXISTS synthetic_pause_perio_sign()`); gate.release();
    }
  });
  it("relink owns visit first: a queued save rechecks route-authorized patient and refuses", async () => {
    const f = await fixture(); const other = await fixture(); const gate = await db.getPool().connect(); let saving: ReturnType<typeof f.save> | undefined;
    try {
      await gate.query("BEGIN"); await gate.query(`SELECT id FROM visits WHERE id=$1 FOR UPDATE`, [f.visitId]);
      saving = f.save(); void saving.catch(() => undefined); await waitForLock("SELECT patient_id, signed_at, case_id FROM visits", gate);
      await gate.query(`UPDATE visits SET patient_id=$2 WHERE id=$1`, [f.visitId, other.patientId]); await gate.query("COMMIT");
      expect(await saving).toEqual({ ok: false, reason: "not_found" }); expect((await snapshot(f.visitId)).exams).toEqual([]);
    } finally { await gate.query("ROLLBACK").catch(() => undefined); await Promise.allSettled([saving].filter(Boolean)); gate.release(); }
  });
  it("save owns visit first: ordinary relink waits and refuses after exam commits", async () => {
    const f = await fixture(); const other = await fixture(); const gate = await db.getPool().connect();
    let saving: ReturnType<typeof f.save> | undefined; let relinking: ReturnType<typeof db.linkVisitToPatient> | undefined;
    try {
      await gate.query(`SELECT pg_advisory_lock(784102)`);
      await q(`CREATE FUNCTION synthetic_pause_perio_relink() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        PERFORM pg_advisory_xact_lock(784102); RETURN NEW; END $$;
        CREATE TRIGGER synthetic_pause_perio_relink BEFORE INSERT ON perio_site_observations FOR EACH ROW EXECUTE FUNCTION synthetic_pause_perio_relink()`);
      saving = f.save(); void saving.catch(() => undefined); await waitForLock("INSERT INTO perio_site_observations", gate);
      relinking = db.linkVisitToPatient(f.visitId, other.patientId); void relinking.catch(() => undefined);
      await waitForLock("SELECT signed_at, patient_id FROM visits", gate); await gate.query(`SELECT pg_advisory_unlock(784102)`);
      expect(await saving).toMatchObject({ ok: true }); expect(await relinking).toMatchObject({ ok: false });
      expect((await perio.listPatientPerio(f.patientId))).toHaveLength(1);
    } finally {
      await gate.query(`SELECT pg_advisory_unlock(784102)`); await Promise.allSettled([saving, relinking].filter(Boolean));
      await q(`DROP TRIGGER IF EXISTS synthetic_pause_perio_relink ON perio_site_observations; DROP FUNCTION IF EXISTS synthetic_pause_perio_relink()`); gate.release();
    }
  });
  it.each(["merge", "delete"] as const)("patient KEY SHARE fences concurrent %s until the exam commits", async (operation) => {
    const f = await fixture(); const other = await fixture(); const gate = await db.getPool().connect();
    let saving: ReturnType<typeof f.save> | undefined;
    let parentChange: ReturnType<typeof db.mergeDuplicatePatient> | ReturnType<typeof db.deletePatientCascade> | undefined;
    try {
      await gate.query(`SELECT pg_advisory_lock(784104)`);
      await q(`CREATE FUNCTION synthetic_pause_perio_parent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        PERFORM pg_advisory_xact_lock(784104); RETURN NEW; END $$;
        CREATE TRIGGER synthetic_pause_perio_parent BEFORE INSERT ON perio_site_observations FOR EACH ROW EXECUTE FUNCTION synthetic_pause_perio_parent()`);
      saving = f.save(); void saving.catch(() => undefined); await waitForLock("INSERT INTO perio_site_observations", gate);
      parentChange = operation === "merge" ? db.mergeDuplicatePatient(f.patientId, other.patientId, actor) : db.deletePatientCascade(f.patientId, actor);
      void parentChange.catch(() => undefined);
      await waitForLock(operation === "merge" ? "ORDER BY id FOR UPDATE" : "FROM patients WHERE id = $1 FOR UPDATE", gate);
      await gate.query(`SELECT pg_advisory_unlock(784104)`);
      const saved = await saving; expect(saved).toMatchObject({ ok: true });
      const changed = await parentChange;
      if (operation === "merge") {
        expect(changed).toMatchObject({ ok: true });
        expect((await perio.listPatientPerio(other.patientId))[0]).toMatchObject({ id: saved.ok ? saved.exam.id : -1, visitId: f.visitId, sites: [site()] });
      } else {
        expect(changed).toMatchObject({ ok: false, reason: "has_clinical_history" });
        expect((await perio.listPatientPerio(f.patientId))).toHaveLength(1);
      }
    } finally {
      await gate.query(`SELECT pg_advisory_unlock(784104)`); await Promise.allSettled([saving, parentChange].filter(Boolean));
      await q(`DROP TRIGGER IF EXISTS synthetic_pause_perio_parent ON perio_site_observations; DROP FUNCTION IF EXISTS synthetic_pause_perio_parent()`); gate.release();
    }
  });
});

// Reconstructed regressions for reviewed changes after the retained source snapshot.
describe("periodontal audit and explicit visit/case context", () => {
  it("persists structured before/after values and attribution when summary counts are unchanged", async () => {
    const f = await fixture();
    const beforeSites = [site(), site({ site: "B", probingDepthMm: 2, bleedingOnProbing: true }), site({ site: "DB", probingDepthMm: null, bleedingOnProbing: null })];
    await f.save(beforeSites);
    const afterSites = [site({ probingDepthMm: 1 }), site({ site: "B", probingDepthMm: null, bleedingOnProbing: null }), site({ site: "DL", bleedingOnProbing: true })];
    const result = await f.save(afterSites, 1, { doctorId: otherDoctor, caseId: null });
    expect(result).toMatchObject({ ok: true, exam: { revision: 2, doctorId: otherDoctor, caseId: null } });
    const audits = await q<{ actor: string; details: Record<string, unknown> }>(
      `SELECT actor,details FROM audit_log WHERE action='perio.exam_save' AND details->>'visitId'=$1 ORDER BY id`, [String(f.visitId)]);
    expect(audits).toHaveLength(2);
    expect(audits[1]).toMatchObject({ actor: actor.actor, details: {
      before: { doctorId: doctor, caseId: f.caseId, revision: 1 },
      after: { doctorId: otherDoctor, caseId: null, revision: 2 },
      changedSites: [
        { toothCode: 11, site: "MB", before: { probingDepthMm: 0, bleedingOnProbing: false }, after: { probingDepthMm: 1, bleedingOnProbing: false } },
        { toothCode: 11, site: "B", before: { probingDepthMm: 2, bleedingOnProbing: true }, after: { probingDepthMm: null, bleedingOnProbing: null } },
        { toothCode: 11, site: "DB", before: { probingDepthMm: null, bleedingOnProbing: null }, after: null },
        { toothCode: 11, site: "DL", before: null, after: { probingDepthMm: 0, bleedingOnProbing: true } },
      ],
    } });
    for (const key of ["recordedDepthSites", "recordedBleedingSites", "bleedingSites", "bleedingPercent"]) {
      expect(audits[1].details[key]).toEqual(audits[0].details[key]);
    }
  });
  it("requires an exact existing nonnull visit case in both writer and direct SQL", async () => {
    const f = await fixture();
    await q(`UPDATE visits SET case_id=$2 WHERE id=$1`, [f.visitId, f.caseId]);
    expect(await f.save([site()], null, { caseId: null })).toEqual({ ok: false, reason: "bad_case" });
    await expect(q(`INSERT INTO perio_exams(visit_id,doctor_id,recorded_by) VALUES ($1,$2,'synthetic')`, [f.visitId, doctor])).rejects.toThrow("existing visit case");
    expect(await f.save()).toMatchObject({ ok: true, exam: { caseId: f.caseId } });
  });
  it("permits same-case late association and unsigned clearing, but rejects conflicting or signed case changes", async () => {
    const f = await fixture(); await f.save();
    const otherCase = (await q<{ id: number }>(`INSERT INTO clinical_cases(patient_id,specialty,title,created_by) VALUES ($1,'periodontics','Other context','synthetic') RETURNING id`, [f.patientId]))[0].id;
    await expect(q(`UPDATE visits SET case_id=$2 WHERE id=$1`, [f.visitId, otherCase])).rejects.toThrow("visit case conflicts");
    await q(`UPDATE visits SET case_id=$2 WHERE id=$1`, [f.visitId, f.caseId]);
    await q(`UPDATE visits SET case_id=NULL WHERE id=$1`, [f.visitId]);
    expect((await perio.listPatientPerio(f.patientId))[0].caseId).toBe(f.caseId);
    await q(`UPDATE visits SET case_id=$2 WHERE id=$1`, [f.visitId, f.caseId]);
    expect((await f.sign()).reason).toBeNull();
    await expect(q(`UPDATE visits SET case_id=NULL WHERE id=$1`, [f.visitId])).rejects.toThrow("visit case conflicts");
    await expect(q(`UPDATE visits SET case_id=$2 WHERE id=$1`, [f.visitId, otherCase])).rejects.toThrow("visit case conflicts");
  });
  it("keeps an explicitly unassigned exam unassigned until a revision-controlled edit selects a case", async () => {
    const f = await fixture(); await f.save([site()], null, { caseId: null });
    await expect(q(`UPDATE visits SET case_id=$2 WHERE id=$1`, [f.visitId, f.caseId])).rejects.toThrow("visit case conflicts");
    expect(await f.save([site()], 1)).toMatchObject({ ok: true, exam: { revision: 2, caseId: f.caseId } });
    await q(`UPDATE visits SET case_id=$2 WHERE id=$1`, [f.visitId, f.caseId]);
  });
});

describe("actual referral arrival with an existing periodontal exam", () => {
  it.each(["matching", "conflicting", "unassigned"] as const)("completes arrival with %s exam context and audits the actual association", async (context) => {
    const f = await fixture();
    const examCase = context === "unassigned" ? null : f.caseId;
    await f.save([site()], null, { caseId: examCase });
    const before = await snapshot(f.visitId);
    const requestedCaseId = context === "matching" ? f.caseId : (await q<{ id: number }>(
      `INSERT INTO clinical_cases(patient_id,specialty,title,created_by) VALUES ($1,'periodontics','Referral case','synthetic') RETURNING id`, [f.patientId]))[0].id;
    const created = await db.createInternalReferral({ patientId: f.patientId, doctorPartyId: doctor,
      toPartyId: otherDoctor, toSpecialty: "periodontics", reason: "Synthetic periodontal consultation", teeth: "11", urgency: "routine",
      caseId: requestedCaseId, blocksCaseId: null, planItemId: null, requestedServiceId: null, ...actor });
    if (!created.ok) throw new Error(created.reason);
    const appointmentId = (await q<{ id: number }>(
      `INSERT INTO appointments(patient_id,scheduled_date,scheduled_time,doctor_id)
       VALUES ($1,(NOW() AT TIME ZONE $2)::date,'10:00',$3) RETURNING id`, [f.patientId, db.CLINIC_TIME_ZONE, otherDoctor]))[0].id;
    expect(await db.transitionInternalReferral({ id: created.referral.id, action: "schedule", appointmentId,
      note: null, procedurePerformed: null, followupRequired: null, mayReturn: null, ...actor })).toMatchObject({ ok: true });
    expect(await db.arriveAppointment(appointmentId, actor)).toBe(true);
    expect(await db.getReferral(created.referral.id)).toMatchObject({ workflowState: "arrived" });
    expect((await q(`SELECT status FROM appointments WHERE id=$1`, [appointmentId]))[0].status).toBe("arrived");
    expect(await q(`SELECT id,case_id FROM visits WHERE appointment_id=$1`, [appointmentId])).toEqual([
      { id: f.visitId, case_id: context === "matching" ? requestedCaseId : null },
    ]);
    expect(await snapshot(f.visitId)).toEqual(before);
    expect((await perio.listPatientPerio(f.patientId))[0].caseId).toBe(examCase);
    const audit = await q<{ details: Record<string, unknown> }>(
      `SELECT details FROM audit_log WHERE action='referral.arrive' AND entity_id=$1 ORDER BY id`, [String(f.patientId)]);
    expect(audit).toHaveLength(1);
    expect(audit[0].details).toMatchObject({ requestedCaseId, caseAssociated: context === "matching" });
    expect(await q(`SELECT id FROM invoices WHERE patient_id=$1`, [f.patientId])).toEqual([]);
    expect(await q(`SELECT id FROM visit_procedures WHERE visit_id=$1`, [f.visitId])).toEqual([]);
  });
});

describe("late visit-case association and periodontal save serialize", () => {
  it("case assignment first makes a queued incompatible save refuse after recheck", async () => {
    const f = await fixture(); const gate = await db.getPool().connect();
    let saving: ReturnType<typeof f.save> | undefined;
    try {
      await gate.query("BEGIN");
      await gate.query(`UPDATE visits SET case_id=$2 WHERE id=$1`, [f.visitId, f.caseId]);
      saving = f.save([site()], null, { caseId: null }); void saving.catch(() => undefined);
      await waitForLock("SELECT patient_id, signed_at, case_id FROM visits", gate);
      await gate.query("COMMIT");
      expect(await saving).toEqual({ ok: false, reason: "bad_case" });
      expect((await snapshot(f.visitId)).exams).toEqual([]);
    } finally { await gate.query("ROLLBACK").catch(() => undefined); await Promise.allSettled([saving].filter(Boolean)); gate.release(); }
  });
  it("save first makes a queued incompatible case assignment fail without changing either context", async () => {
    const f = await fixture(); const gate = await db.getPool().connect();
    let saving: ReturnType<typeof f.save> | undefined; let assigning: ReturnType<typeof q> | undefined;
    try {
      await gate.query(`SELECT pg_advisory_lock(784105)`);
      await q(`CREATE FUNCTION synthetic_pause_perio_case() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        PERFORM pg_advisory_xact_lock(784105); RETURN NEW; END $$;
        CREATE TRIGGER synthetic_pause_perio_case BEFORE INSERT ON perio_site_observations FOR EACH ROW EXECUTE FUNCTION synthetic_pause_perio_case()`);
      saving = f.save([site()], null, { caseId: null }); void saving.catch(() => undefined);
      await waitForLock("INSERT INTO perio_site_observations", gate);
      assigning = q(`UPDATE visits SET case_id=$2 WHERE id=$1`, [f.visitId, f.caseId]); void assigning.catch(() => undefined);
      await waitForLock("UPDATE visits SET case_id=$2 WHERE id=$1", gate);
      await gate.query(`SELECT pg_advisory_unlock(784105)`);
      expect(await saving).toMatchObject({ ok: true, exam: { caseId: null } });
      await expect(assigning).rejects.toThrow("visit case conflicts");
      expect((await q(`SELECT case_id FROM visits WHERE id=$1`, [f.visitId]))[0].case_id).toBeNull();
    } finally {
      await gate.query(`SELECT pg_advisory_unlock(784105)`); await Promise.allSettled([saving, assigning].filter(Boolean));
      await q(`DROP TRIGGER IF EXISTS synthetic_pause_perio_case ON perio_site_observations; DROP FUNCTION IF EXISTS synthetic_pause_perio_case()`); gate.release();
    }
  });
});
