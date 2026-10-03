import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validatePostgresTestTarget } from "./_safe-target";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
import { PrescriptionIdentityConflict } from "../../lib/prescription-identity";
import type { DbClient, PrescriptionRecord, VitalsRecord } from "../../lib/db";
import type { PrescriptionDraft } from "../../lib/prescription";

// Ordinary already-linked synthetic owners only, in a guarded disposable PG18
// database. No real patient data, external HTTP, or unlinked-access harness.
const target = validatePostgresTestTarget(process.env, { allowDatabaseUrlFallback: true });
assertRealPostgresUrl();
stubPostgresEnv();
const priorClinicZone = process.env.CLINIC_TIME_ZONE;
process.env.CLINIC_TIME_ZONE = "Asia/Aden";
const db = await import("../../lib/db");
const q = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []) =>
  (await db.getPool().query<T>(sql, values)).rows;
const insertId = async (sql: string, values: unknown[] = []) => (await q<{ id: number }>(sql, values))[0].id;
let sequence = 0;
let doctorId: number;
const actor = "synthetic-rx-vitals-admin";
const vitalInput = { bpSystolic: 121, bpDiastolic: 79, pulse: 73, temperature: 36.7, spo2: 98, glucose: 104, weightKg: 68.5 };

beforeAll(async () => {
  await dropPublicSchema(target.testUrl.toString());
  await db.ensureSchema();
  doctorId = await insertId(`INSERT INTO parties (kind, name) VALUES ('doctor', 'Synthetic Rx/vitals doctor') RETURNING id`);
}, 180_000);
afterAll(async () => {
  await db.resetPoolForTesting();
  if (priorClinicZone === undefined) delete process.env.CLINIC_TIME_ZONE;
  else process.env.CLINIC_TIME_ZONE = priorClinicZone;
});

async function fixture() {
  const n = ++sequence;
  const patientId = await insertId(`INSERT INTO patients (patient_number, full_name)
    VALUES ($1, 'Synthetic Rx/vitals A') RETURNING id`, [`RV-A-${n}`]);
  const otherPatientId = await insertId(`INSERT INTO patients (patient_number, full_name)
    VALUES ($1, 'Synthetic Rx/vitals B') RETURNING id`, [`RV-B-${n}`]);
  const visitId = await insertId(`INSERT INTO visits (patient_id, patient_name, doctor_id, status)
    VALUES ($1, 'Synthetic Rx/vitals A', $2, 'done') RETURNING id`, [patientId, doctorId]);
  return { patientId, otherPatientId, visitId };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Kind = "Rx" | "vitals";
type Mutation = "relink" | "delete" | "merge" | "sign";
type Saved = PrescriptionRecord | VitalsRecord;
const kinds: Kind[] = ["Rx", "vitals"];
const mutations: Mutation[] = ["relink", "delete", "merge", "sign"];
const tableOf = (kind: Kind) => kind === "Rx" ? "prescriptions" : "patient_vitals";
const visitWaitOf = (kind: Kind) => kind === "Rx"
  ? "SELECT patient_id FROM visits WHERE id = $1 FOR SHARE"
  : "SELECT v.id FROM visits v WHERE v.patient_id = $1 AND v.signed_at IS NULL";
const rxDraft = (f: Fixture, visitId: number | null = f.visitId): PrescriptionDraft => ({
  patientId: f.patientId, visitId, diagnosis: "Synthetic diagnosis", notes: "Synthetic preserved notes", instructionsLang: "both",
  items: [{ name: "Paracetamol 500mg", dose: "500mg", form: "Tablets", frequency: "every 8 hours", duration: "3 days", instructions: "Synthetic instruction", instructionsEn: "Synthetic instruction" }],
});
async function waitUntil(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Expected synthetic condition: ${label}`);
}
async function saveRx(f: Fixture, visitId: number | null = f.visitId) {
  const record = await db.savePrescription(rxDraft(f, visitId), actor, doctorId);
  // Creation audit remains asynchronous; drain this known success before taking
  // later audit snapshots rather than claiming audit/record transaction atomicity.
  await waitUntil(async () => (await q(`SELECT id FROM audit_log WHERE action = 'prescription.create' AND entity_id = $1`, [record.id])).length === 1, "Rx success audit");
  return record;
}
const write = (kind: Kind, f: Fixture): Promise<Saved | null> => kind === "Rx"
  ? saveRx(f)
  : db.recordVitals(f.patientId, vitalInput, actor, { medicalAlert: "Synthetic updated alert" });
async function readSaved(kind: Kind, id: number, patientId: number) {
  return kind === "Rx" ? db.getPrescription(id) : (await db.listVitals(patientId, 100)).find(record => record.id === id);
}
const auditSnapshot = () => q(`SELECT * FROM audit_log WHERE action = 'prescription.create' ORDER BY id`);
async function waitForLock(observer: DbClient, queryFragment: string) {
  await waitUntil(async () => {
    await observer.query("SELECT pg_stat_clear_snapshot()");
    const { rows: [row] } = await observer.query<{ waiting: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
        AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query LIKE $1) AS waiting`, [`%${queryFragment}%`]);
    return row.waiting;
  }, `lock wait: ${queryFragment}`);
}
async function triggerGate(table: string, event: "INSERT" | "UPDATE" | "DELETE", when = "") {
  const gate = await db.getPool().connect();
  await gate.query("SELECT pg_advisory_lock(716521)");
  await q(`CREATE FUNCTION rxv_pause() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_advisory_xact_lock(716521); IF TG_OP = 'DELETE' THEN RETURN OLD; END IF; RETURN NEW; END $$`);
  await q(`CREATE TRIGGER rxv_pause BEFORE ${event} ON ${table} FOR EACH ROW ${when} EXECUTE FUNCTION rxv_pause()`);
  return {
    gate,
    unlock: () => gate.query("SELECT pg_advisory_unlock(716521)"),
    close: async (operations: Array<Promise<unknown> | undefined>) => {
      await gate.query("SELECT pg_advisory_unlock(716521)").catch(() => {});
      await Promise.allSettled(operations);
      await q(`DROP TRIGGER IF EXISTS rxv_pause ON ${table}`);
      await q("DROP FUNCTION IF EXISTS rxv_pause()");
      gate.release();
    },
  };
}
async function prepareSign(f: Fixture) {
  await q(`UPDATE visits SET diagnosis = 'Synthetic signed diagnosis', patient_phone = '+967700000909' WHERE id = $1`, [f.visitId]);
  expect(await q(`SELECT phone FROM patients WHERE id = $1`, [f.patientId])).toEqual([{ phone: null }]);
}
const mutate = (mutation: Mutation, f: Fixture) => {
  switch (mutation) {
    case "relink": return db.linkVisitToPatient(f.visitId, f.otherPatientId);
    case "delete": return db.deleteVisit(f.visitId, { actor, actorRole: "admin" });
    case "merge": return db.mergeDuplicatePatient(f.patientId, f.otherPatientId, { actor, actorRole: "admin" });
    case "sign": return db.signClinicalVisit({ visitId: f.visitId, signedBy: actor, signerRole: "admin", signerDoctorPartyId: doctorId, baseCurrency: "YER" });
  }
};
const mutationWait: Record<Mutation, string> = {
  relink: "SELECT signed_at, patient_id FROM visits WHERE id = $1 FOR UPDATE",
  delete: "FROM visits WHERE id = $1 FOR UPDATE",
  merge: "FROM patients WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE",
  sign: "FROM visits WHERE id = $1 AND signed_at IS NULL FOR UPDATE",
};
async function assertNoMixedOwners() {
  for (const table of ["prescriptions", "patient_vitals"]) {
    expect(await q(`SELECT r.id FROM ${table} r JOIN visits v ON v.id = r.visit_id
      WHERE r.patient_id IS DISTINCT FROM v.patient_id`)).toEqual([]);
  }
}

describe("prescription and vital identity compatibility", () => {
  it.each(["linked", "patient-only", "signed"])("preserves the %s prescription contract", async mode => {
    const f = await fixture();
    if (mode === "signed") await q(`UPDATE visits SET signed_at = NOW(), signed_by = $2 WHERE id = $1`, [f.visitId, actor]);
    const visitId = mode === "patient-only" ? null : f.visitId;
    const record = await saveRx(f, visitId);
    expect(record).toMatchObject({ ...rxDraft(f, visitId), createdBy: actor, doctorPartyId: doctorId, status: "active" });
    expect(await db.getPrescription(record.id)).toEqual(record);
  });
  it.each(["mismatched", "deleted-visit", "deleted-patient"])("refuses %s prescription identity without a row or success audit", async mode => {
    const f = await fixture();
    if (mode === "mismatched") expect(await db.linkVisitToPatient(f.visitId, f.otherPatientId)).toMatchObject({ ok: true });
    if (mode === "deleted-visit") expect(await db.deleteVisit(f.visitId, { actor })).toEqual({ ok: true });
    if (mode === "deleted-patient") expect(await db.mergeDuplicatePatient(f.patientId, f.otherPatientId, { actor })).toMatchObject({ ok: true });
    const audits = await auditSnapshot();
    await expect(saveRx(f)).rejects.toBeInstanceOf(PrescriptionIdentityConflict);
    expect(await q("SELECT id FROM prescriptions WHERE patient_id = $1", [f.patientId])).toEqual([]);
    expect(await auditSnapshot()).toEqual(audits);
  });
  it.each(["active", "void"])("retains %s prescriptions as relink history and allows same-owner refresh", async status => {
    const f = await fixture();
    const record = await saveRx(f);
    if (status === "void") await db.voidPrescription({ id: record.id, reason: "Synthetic correction", actor }, doctorId);
    const before = await db.getPrescription(record.id);
    expect(await db.linkVisitToPatient(f.visitId, f.otherPatientId)).toMatchObject({ ok: false, reason: "has_clinical_history" });
    expect(await db.linkVisitToPatient(f.visitId, f.patientId)).toMatchObject({ ok: true });
    expect(await db.getPrescription(record.id)).toEqual(before);
  });
  it("selects latest-ID unsigned local-day vitals regardless of queue status", async () => {
    const f = await fixture();
    const later = await insertId(`INSERT INTO visits (patient_id, patient_name, status)
      VALUES ($1, 'Synthetic Rx/vitals A', 'left') RETURNING id`, [f.patientId]);
    await insertId(`INSERT INTO visits (patient_id, patient_name, signed_at)
      VALUES ($1, 'Synthetic Rx/vitals A', NOW()) RETURNING id`, [f.patientId]);
    await insertId(`INSERT INTO visits (patient_id, patient_name, arrived_at)
      VALUES ($1, 'Synthetic Rx/vitals A', NOW() - INTERVAL '2 days') RETURNING id`, [f.patientId]);
    const record = await write("vitals", f);
    expect(record).toMatchObject({ ...vitalInput, patientId: f.patientId, visitId: later, recordedBy: actor });
    expect(await readSaved("vitals", record!.id, f.patientId)).toEqual(record);
  });
  it("preserves explicit clinic date, timestamp and standalone capture", async () => {
    const f = await fixture();
    await q(`UPDATE visits SET arrived_at = '2026-09-10T21:30:00Z' WHERE id = $1`, [f.visitId]);
    const record = await db.recordVitals(f.patientId, vitalInput, actor, { recordedDate: "2026-09-11" });
    expect(record).toMatchObject({ ...vitalInput, patientId: f.patientId, visitId: f.visitId, recordedBy: actor, recordedAt: "2026-09-10T21:00:00.000Z" });
    const standalone = await db.recordVitals(f.patientId, vitalInput, actor, { recordedDate: "2026-09-12" });
    expect(standalone).toMatchObject({ ...vitalInput, visitId: null, recordedAt: "2026-09-11T21:00:00.000Z" });
  });
  it("returns null for a removed patient without changing alerts or creating readings", async () => {
    const f = await fixture();
    expect(await db.mergeDuplicatePatient(f.patientId, f.otherPatientId, { actor })).toMatchObject({ ok: true });
    expect(await write("vitals", f)).toBeNull();
    expect(await q("SELECT id FROM patient_vitals WHERE patient_id = $1", [f.patientId])).toEqual([]);
    expect(await q("SELECT medical_alert FROM patients WHERE id = $1", [f.otherPatientId])).toEqual([{ medical_alert: null }]);
  });
  it("rolls the reading and alert back together if the optional alert update fails", async () => {
    const f = await fixture();
    await q(`CREATE FUNCTION rxv_fail_alert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Synthetic alert failure'; END $$`);
    await q(`CREATE TRIGGER rxv_fail_alert BEFORE UPDATE ON patients FOR EACH ROW
      WHEN (NEW.medical_alert IS DISTINCT FROM OLD.medical_alert) EXECUTE FUNCTION rxv_fail_alert()`);
    try {
      await expect(write("vitals", f)).rejects.toThrow("Synthetic alert failure");
      expect(await q("SELECT id FROM patient_vitals WHERE patient_id = $1", [f.patientId])).toEqual([]);
      expect(await q("SELECT medical_alert FROM patients WHERE id = $1", [f.patientId])).toEqual([{ medical_alert: null }]);
    } finally {
      await q("DROP TRIGGER rxv_fail_alert ON patients");
      await q("DROP FUNCTION rxv_fail_alert()");
    }
  });
});

describe("writer-first linked ownership races", () => {
  it.each(kinds.flatMap(kind => mutations.map(mutation => [kind, mutation] as const)))(
    "%s first serializes %s without mixed ownership or lost content", async (kind, mutation) => {
      const f = await fixture();
      if (mutation === "sign") await prepareSign(f);
      const pause = await triggerGate(tableOf(kind), "INSERT");
      let writing: ReturnType<typeof write> | undefined;
      let changing: ReturnType<typeof mutate> | undefined;
      try {
        writing = write(kind, f); void writing.catch(() => {});
        await waitForLock(pause.gate, `INSERT INTO ${tableOf(kind)}`);
        changing = mutate(mutation, f); void changing.catch(() => {});
        await waitForLock(pause.gate, mutationWait[mutation]);
        await pause.unlock();
        const saved = await writing;
        expect(saved).not.toBeNull();
        const changed = await changing;
        if (mutation === "relink") expect(changed).toMatchObject({ ok: false, reason: "has_clinical_history" });
        else if (mutation === "sign") {
          expect(changed).toMatchObject({ reason: null, visit: { status: "signed" } });
          expect(await q("SELECT phone FROM patients WHERE id = $1", [f.patientId])).toEqual([{ phone: "967700000909" }]);
        } else expect(changed).toMatchObject({ ok: true });
        const patientId = mutation === "merge" ? f.otherPatientId : f.patientId;
        expect(await readSaved(kind, saved!.id, patientId)).toEqual({
          ...saved, patientId, visitId: mutation === "delete" ? null : f.visitId,
        });
        if (mutation === "merge") expect(await q("SELECT id FROM patients WHERE id = $1", [f.patientId])).toEqual([]);
        await assertNoMixedOwners();
      } finally { await pause.close([writing, changing]); }
    }, 25_000,
  );
});

describe("mutation-first linked ownership races", () => {
  it.each(kinds.flatMap(kind => (["relink", "delete", "merge"] as const).map(mutation => [kind, mutation] as const)))(
    "%s rechecks after %s wins", async (kind, mutation) => {
      const f = await fixture();
      const audits = await auditSnapshot();
      const pause = await triggerGate("visits", mutation === "delete" ? "DELETE" : "UPDATE",
        mutation === "delete" ? "" : "WHEN (NEW.patient_id IS DISTINCT FROM OLD.patient_id)");
      let writing: ReturnType<typeof write> | undefined;
      let changing: ReturnType<typeof mutate> | undefined;
      try {
        changing = mutate(mutation, f); void changing.catch(() => {});
        await waitForLock(pause.gate, mutation === "delete" ? "DELETE FROM visits WHERE id = $1"
          : mutation === "merge" ? "UPDATE visits SET patient_id = $1 WHERE patient_id = $2"
            : "UPDATE visits SET patient_id = $2, patient_name = $3");
        writing = write(kind, f); void writing.catch(() => {});
        await waitForLock(pause.gate, mutation === "merge" ? "SELECT id FROM patients WHERE id = $1 FOR KEY SHARE" : visitWaitOf(kind));
        await pause.unlock();
        expect(await changing).toMatchObject({ ok: true });
        if (kind === "Rx") {
          await expect(writing).rejects.toBeInstanceOf(PrescriptionIdentityConflict);
          expect(await q("SELECT id FROM prescriptions WHERE patient_id = ANY($1::int[])", [[f.patientId, f.otherPatientId]])).toEqual([]);
          expect(await auditSnapshot()).toEqual(audits);
        } else if (mutation === "merge") {
          expect(await writing).toBeNull();
          expect(await q("SELECT id FROM patient_vitals WHERE patient_id = ANY($1::int[])", [[f.patientId, f.otherPatientId]])).toEqual([]);
          expect(await q("SELECT medical_alert FROM patients WHERE id = $1", [f.otherPatientId])).toEqual([{ medical_alert: null }]);
        } else {
          const saved = await writing;
          expect(saved).toMatchObject({ ...vitalInput, patientId: f.patientId, visitId: null, recordedBy: actor });
          expect(await readSaved(kind, saved!.id, f.patientId)).toEqual(saved);
          expect(await q("SELECT medical_alert FROM patients WHERE id = $1", [f.patientId])).toEqual([{ medical_alert: "Synthetic updated alert" }]);
        }
        await assertNoMixedOwners();
      } finally { await pause.close([writing, changing]); }
    }, 25_000,
  );

  it.each(kinds)("real signing phone-fill completes ahead of %s without a patient/visit deadlock", async kind => {
    const f = await fixture();
    await prepareSign(f);
    const gate = await db.getPool().connect();
    let signing: ReturnType<typeof db.signClinicalVisit> | undefined;
    let writing: ReturnType<typeof write> | undefined;
    try {
      // A table SHARE gate pauses signing just before its patient UPDATE can
      // start, while allowing the writer's patient RowShare lock. This exposes
      // the old patient-FOR-UPDATE -> visit versus sign's visit -> patient cycle.
      await gate.query("BEGIN");
      await gate.query("LOCK TABLE patients IN SHARE MODE");
      signing = db.signClinicalVisit({ visitId: f.visitId, signedBy: actor, signerRole: "admin", signerDoctorPartyId: doctorId, baseCurrency: "YER" });
      void signing.catch(() => {});
      await waitForLock(gate, "UPDATE patients SET phone = $2 WHERE id = $1");
      writing = write(kind, f); void writing.catch(() => {});
      await waitForLock(gate, visitWaitOf(kind));
      await gate.query("COMMIT");
      expect(await signing).toMatchObject({ reason: null, visit: { status: "signed" } });
      const saved = await writing;
      expect(saved).toMatchObject({ patientId: f.patientId, visitId: kind === "Rx" ? f.visitId : null });
      expect(await readSaved(kind, saved!.id, f.patientId)).toEqual(saved);
      expect(await q("SELECT phone FROM patients WHERE id = $1", [f.patientId])).toEqual([{ phone: "967700000909" }]);
      if (kind === "vitals") expect(await q("SELECT medical_alert FROM patients WHERE id = $1", [f.patientId])).toEqual([{ medical_alert: "Synthetic updated alert" }]);
      await assertNoMixedOwners();
    } finally {
      await gate.query("ROLLBACK").catch(() => {});
      await Promise.allSettled([signing, writing]);
      gate.release();
    }
  }, 25_000);

  it("can select another qualifying original-owner visit after the latest is relinked", async () => {
    const f = await fixture();
    const newer = await insertId(`INSERT INTO visits (patient_id, patient_name) VALUES ($1, 'Synthetic Rx/vitals A') RETURNING id`, [f.patientId]);
    const pause = await triggerGate("visits", "UPDATE", "WHEN (NEW.patient_id IS DISTINCT FROM OLD.patient_id)");
    let relinking: ReturnType<typeof db.linkVisitToPatient> | undefined;
    let writing: ReturnType<typeof write> | undefined;
    try {
      relinking = db.linkVisitToPatient(newer, f.otherPatientId); void relinking.catch(() => {});
      await waitForLock(pause.gate, "UPDATE visits SET patient_id = $2, patient_name = $3");
      writing = write("vitals", f); void writing.catch(() => {});
      await waitForLock(pause.gate, visitWaitOf("vitals"));
      await pause.unlock();
      expect(await relinking).toMatchObject({ ok: true });
      expect(await writing).toMatchObject({ patientId: f.patientId, visitId: f.visitId });
      await assertNoMixedOwners();
    } finally { await pause.close([relinking, writing]); }
  }, 25_000);
});
