import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { validatePostgresTestTarget } from "./_safe-target";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
import { checkEndoVisitDraft } from "../../lib/endodontics";
import type { QueryResult } from "../../lib/db";

// Real SQL on the canonical disposable PG18 target. Every visit below is already
// linked to a synthetic patient. No HTTP, relink API, mocked SQL or production data.
const target = validatePostgresTestTarget(process.env, { allowDatabaseUrlFallback: true });
assertRealPostgresUrl(); stubPostgresEnv();
process.env.SKIP_SEED = "true";
const db = await import("../../lib/db");
const endo = await import("../../lib/endodontics-db");
const perio = await import("../../lib/periodontics-db");
const { getVisitStructuredClinical } = await import("../../lib/visit-structured-clinical-db");
const q = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<T[]> =>
  (await db.getPool().query<T>(sql, values)).rows;
let sequence = 0;
let endoDoctor: number; let perioDoctor: number; let coordinator: number;
const actor = { actor: "synthetic structured recorder", actorRole: "admin" };

beforeAll(async () => {
  // The suite follows the repository's guarded disposable-schema lifecycle.
  // The focused proof launcher additionally supplies a NEW private empty PG18 DB.
  const resetTarget = validatePostgresTestTarget(process.env, { allowDatabaseUrlFallback: true });
  if (resetTarget.testUrl.toString() !== target.testUrl.toString()) throw new Error("Disposable test target changed before fixture reset");
  await dropPublicSchema(resetTarget.testUrl.toString());
  await db.ensureSchema();
  const providers = await q<{ id: number }>(`INSERT INTO parties(kind,name) VALUES
    ('doctor','Structured Endo clinician'),('doctor','Structured Perio clinician'),('doctor','Structured visit coordinator') RETURNING id`);
  [endoDoctor, perioDoctor, coordinator] = providers.map((row) => row.id);
}, 180_000);
afterAll(async () => { vi.restoreAllMocks(); await db.resetPoolForTesting(); });

async function linkedVisit() {
  const patientId = (await q<{ id: number }>(`INSERT INTO patients(patient_number,full_name)
    VALUES($1,'Synthetic structured patient') RETURNING id`, [`STRUCTURED-${++sequence}`]))[0].id;
  const visitId = (await q<{ id: number }>(`INSERT INTO visits(patient_id,patient_name,doctor_id)
    VALUES($1,'Synthetic structured patient',$2) RETURNING id`, [patientId, endoDoctor]))[0].id;
  const makeCase = async (specialty: "endodontics" | "periodontics") => (await q<{ id: number }>(
    `INSERT INTO clinical_cases(patient_id,specialty,title,created_by) VALUES($1,$2,$3,'synthetic') RETURNING id`,
    [patientId, specialty, `Synthetic ${specialty} case`]))[0].id;
  return { patientId, visitId, makeCase };
}
async function savedVisit() {
  const f = await linkedVisit();
  const endoCaseId = await f.makeCase("endodontics");
  const perioCaseId = await f.makeCase("periodontics");
  const opened = await endo.openEndoTreatment({ ...actor, patientId: f.patientId, caseId: endoCaseId, toothCode: 36, kind: "initial" });
  if (!opened.ok) throw new Error(opened.reason);
  const draft = checkEndoVisitDraft({ stage: "shaping", note: "Synthetic narrative must not be copied into projection",
    canals: [{ label: "MB", workingLengthMm: 20.5, referencePoint: "cusp_tip", measurementMethod: "both", obturated: true },
      { label: "DB" }] });
  if (!draft.ok) throw new Error(draft.message);
  const saved = await endo.saveEndoVisit({ ...actor, patientId: f.patientId, treatmentId: opened.treatment.id,
    visitId: f.visitId, actorPartyId: endoDoctor, expectedVersion: null, draft: draft.value });
  if (!saved.ok) throw new Error(saved.reason);
  const endoRecord = saved.treatment.visits.find((record) => record.visitId === f.visitId);
  if (!endoRecord) throw new Error("Missing synthetic Endo record");
  // Visit coordinator and signatory are deliberately different from both recorded clinicians.
  await q(`UPDATE visits SET doctor_id=$2 WHERE id=$1`, [f.visitId, coordinator]);
  const exam = await perio.savePerioExam({ ...actor, patientId: f.patientId, visitId: f.visitId, expectedRevision: null,
    draft: { doctorId: perioDoctor, caseId: perioCaseId, sites: [
      { toothCode: 11, site: "MB", probingDepthMm: 0, bleedingOnProbing: false },
      { toothCode: 11, site: "B", probingDepthMm: null, bleedingOnProbing: true },
      { toothCode: 12, site: "DL", probingDepthMm: null, bleedingOnProbing: null },
    ] } });
  if (!exam.ok) throw new Error(exam.reason);
  return { ...f, endoCaseId, perioCaseId, treatmentId: opened.treatment.id, endoRecordId: endoRecord.id, perioExamId: exam.exam.id };
}
async function snapshot() {
  const tables = ["visits", "clinical_cases", "endo_treatments", "endo_visits", "endo_canal_records", "endo_addenda",
    "perio_exams", "perio_site_observations", "perio_addenda", "visit_procedures", "invoices", "invoice_items", "audit_log"] as const;
  return Object.fromEntries(await Promise.all(tables.map(async (table) => [table, await q(`SELECT * FROM ${table} ORDER BY id`)])));
}
const unavailable = (f: { visitId: number; patientId: number }) => ({ status: "unavailable", visitId: f.visitId, patientId: f.patientId });

describe("real exact-visit structured clinical projection", () => {
  it("returns ready-empty only for a genuinely empty already-linked visit, with its actual case context", async () => {
    const f = await linkedVisit();
    expect(await getVisitStructuredClinical(f.visitId, f.patientId)).toEqual({
      status: "ready", visitId: f.visitId, patientId: f.patientId, visitCaseId: null,
      signedAt: null, signedBy: null, endodontics: [], periodontics: [],
    });
    const caseId = await f.makeCase("endodontics");
    await q(`UPDATE visits SET case_id=$2 WHERE id=$1`, [f.visitId, caseId]);
    expect(await getVisitStructuredClinical(f.visitId, f.patientId)).toMatchObject({ status: "ready", visitCaseId: caseId, endodontics: [], periodontics: [] });
  });

  it("returns real saved refs, original clinicians, stage and explicit zero/false measurement coverage", async () => {
    const f = await savedVisit();
    await q(`UPDATE visits SET case_id=$2 WHERE id=$1`, [f.visitId, f.perioCaseId]);
    const result = await getVisitStructuredClinical(f.visitId, f.patientId);
    expect(result).toMatchObject({ status: "ready", visitId: f.visitId, patientId: f.patientId, visitCaseId: f.perioCaseId,
      signedAt: null, signedBy: null,
      endodontics: [{ id: f.endoRecordId, treatmentId: f.treatmentId, visitId: f.visitId, patientId: f.patientId,
        caseId: f.endoCaseId, toothCode: 36, version: 1, stage: "shaping", doctorId: endoDoctor, doctorName: "Structured Endo clinician",
        canalCount: 2, measuredCanalCount: 1, obturatedCanalCount: 1 }],
      periodontics: [{ id: f.perioExamId, visitId: f.visitId, patientId: f.patientId, caseId: f.perioCaseId,
        doctorId: perioDoctor, doctorName: "Structured Perio clinician", revision: 1, siteCount: 3, toothCount: 2,
        recordedDepthSites: 1, recordedBleedingSites: 2 }],
    });
    if (result.status !== "ready") throw new Error("Expected saved projection");
    expect(result.endodontics).toHaveLength(1); expect(result.periodontics).toHaveLength(1);
    expect(result.endodontics[0].recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Object.keys(result).sort()).toEqual(["status", "visitId", "patientId", "visitCaseId", "signedAt", "signedBy", "endodontics", "periodontics"].sort());
    expect(Object.keys(result.endodontics[0]).sort()).toEqual(["id", "visitId", "patientId", "caseId", "doctorId", "doctorName", "recordedAt", "updatedAt",
      "treatmentId", "toothCode", "version", "stage", "canalCount", "measuredCanalCount", "obturatedCanalCount"].sort());
    expect(Object.keys(result.periodontics[0]).sort()).toEqual(["id", "visitId", "patientId", "caseId", "doctorId", "doctorName", "recordedAt", "updatedAt",
      "revision", "siteCount", "toothCount", "recordedDepthSites", "recordedBleedingSites"].sort());
    expect(JSON.stringify(result)).not.toMatch(/Synthetic narrative|planItem|invoice|unitPrice|coordinator/);
  });

  it("reflects the canonical signature without changing the original clinicians or inventing a bill", async () => {
    const f = await savedVisit();
    const signed = await db.signClinicalVisit({ visitId: f.visitId, baseCurrency: "YER", signedBy: "Synthetic canonical signer", signerDoctorPartyId: coordinator });
    expect(signed.reason).toBeNull(); expect(signed.invoiceId).toBeNull(); expect(signed.duesMinor).toBe(0);
    const [canonical] = await q<{ signed_at: Date; signed_by: string }>(`SELECT signed_at,signed_by FROM visits WHERE id=$1`, [f.visitId]);
    const before = await snapshot();
    expect(await getVisitStructuredClinical(f.visitId, f.patientId)).toMatchObject({ status: "ready",
      signedAt: canonical.signed_at.toISOString(), signedBy: canonical.signed_by,
      endodontics: [{ doctorId: endoDoctor }], periodontics: [{ doctorId: perioDoctor }] });
    expect(await snapshot()).toEqual(before);
    expect(await q(`SELECT id FROM visit_procedures WHERE visit_id=$1`, [f.visitId])).toEqual([]);
    expect(await q(`SELECT id FROM invoices WHERE patient_id=$1`, [f.patientId])).toEqual([]);
  });

  it("fences the exact supplied patient and does not borrow another visit's records", async () => {
    const f = await savedVisit(); const other = await linkedVisit();
    const before = await snapshot();
    await expect(getVisitStructuredClinical(f.visitId, other.patientId)).rejects.toThrow("no longer in the authorized patient");
    expect(await getVisitStructuredClinical(other.visitId, other.patientId)).toMatchObject({ status: "ready", endodontics: [], periodontics: [] });
    expect(await snapshot()).toEqual(before);
  });

  it.each(["episode", "case"] as const)("hides an FK-valid legacy foreign Endo %s association as unavailable, never ready-empty", async (kind) => {
    const f = await linkedVisit(); const foreign = await linkedVisit();
    const ownCase = await f.makeCase("endodontics"); const foreignCase = await foreign.makeCase("endodontics");
    // Preseeded legacy inconsistency; the read helper is the only action under test.
    const treatmentId = (await q<{ id: number }>(`INSERT INTO endo_treatments(patient_id,case_id,tooth_code,created_by)
      VALUES($1,$2,36,'synthetic inconsistent seed') RETURNING id`, [kind === "episode" ? foreign.patientId : f.patientId, foreignCase]))[0].id;
    await q(`INSERT INTO endo_visits(treatment_id,visit_id,doctor_id,stage,note,recorded_by)
      VALUES($1,$2,$3,'assessment','Foreign fixture detail must not escape','synthetic')`, [treatmentId, f.visitId, endoDoctor]);
    expect(ownCase).not.toBe(foreignCase);
    const before = await snapshot();
    expect(await getVisitStructuredClinical(f.visitId, f.patientId)).toEqual(unavailable(f));
    expect(await snapshot()).toEqual(before);
  });

  it("hides a saved Perio exam whose preseeded legacy case owner no longer matches", async () => {
    const f = await savedVisit(); const foreign = await linkedVisit();
    // Do not disable a trigger or invoke a relink API. Seed only this synthetic
    // legacy case inconsistency before taking the read-only evidence snapshot.
    await q(`UPDATE clinical_cases SET patient_id=$2 WHERE id=$1`, [f.perioCaseId, foreign.patientId]);
    const before = await snapshot();
    expect(await getVisitStructuredClinical(f.visitId, f.patientId)).toEqual(unavailable(f));
    expect(await snapshot()).toEqual(before);
  });

  it("does not expose a preseeded canonical visit case owned by another synthetic patient", async () => {
    const f = await linkedVisit(); const foreign = await linkedVisit();
    const foreignCase = await foreign.makeCase("endodontics");
    await q(`UPDATE visits SET case_id=$2 WHERE id=$1`, [f.visitId, foreignCase]);
    const before = await snapshot();
    expect(await getVisitStructuredClinical(f.visitId, f.patientId)).toEqual(unavailable(f));
    expect(await snapshot()).toEqual(before);
  });

  it("performs repeated ordinary reads without altering clinical, audit or financial rows", async () => {
    const f = await savedVisit(); const before = await snapshot();
    const first = await getVisitStructuredClinical(f.visitId, f.patientId);
    expect(first.status).toBe("ready");
    for (let index = 0; index < 3; index++) expect(await getVisitStructuredClinical(f.visitId, f.patientId)).toEqual(first);
    expect(await snapshot()).toEqual(before);
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function pauseAfterRealSnapshot() {
  const paused = deferred(); const release = deferred();
  let readerPid = 0; let stopped = false; let transaction: { isolation: string; readOnly: string } | null = null;
  const pool = db.getPool(); const connect = pool.connect.bind(pool);
  const spy = vi.spyOn(pool, "connect").mockImplementation(async (...args: unknown[]) => {
    if (args.length > 0) return Reflect.apply(connect, pool, args);
    const client = await connect(); const query = client.query.bind(client);
    return {
      async query<T>(sql: string, values?: unknown[]): Promise<QueryResult<T>> {
        const result = await query<T>(sql, values);
        if (!stopped && /SELECT signed_at, signed_by, case_id/.test(sql)) {
          stopped = true;
          const [state] = (await query<{ pid: number; isolation: string; readOnly: string }>(`SELECT pg_backend_pid() AS pid,
            current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS "readOnly"`)).rows;
          readerPid = state.pid; transaction = { isolation: state.isolation, readOnly: state.readOnly };
          paused.resolve(); await release.promise;
        }
        return result;
      }, release: () => client.release(),
    };
  });
  return { paused, release, spy, readerPid: () => readerPid, transaction: () => transaction };
}

it("keeps record revisions, coverage, case and signature in one real repeatable-read snapshot across a second connection commit", async () => {
  const f = await savedVisit(); const gate = pauseAfterRealSnapshot();
  const writer = new Client({ connectionString: target.testUrl.toString(), ssl: false });
  const reading = getVisitStructuredClinical(f.visitId, f.patientId);
  let writerConnected = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([gate.paused.promise, reading.then(() => { throw new Error("Read finished without reaching real snapshot gate"); }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Real snapshot gate timed out")), 10_000); })]);
    clearTimeout(timer);
    expect(gate.transaction()).toEqual({ isolation: "repeatable read", readOnly: "on" });
    await writer.connect(); writerConnected = true;
    const writerPid = (await writer.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)).rows[0].pid;
    expect(writerPid).not.toBe(gate.readerPid());
    await writer.query("BEGIN");
    // Test-only concurrent transaction. Change all persisted sources atomically;
    // this is an MVCC read proof, not a substitute implementation of signing.
    await writer.query(`UPDATE endo_visits SET version=version+1,stage='obturation',updated_at=NOW() WHERE id=$1`, [f.endoRecordId]);
    await writer.query(`UPDATE endo_canal_records SET working_length_mm=21,reference_point='cusp_tip',measurement_method='both',obturated=true
      WHERE endo_visit_id=$1 AND canal_label='DB'`, [f.endoRecordId]);
    await writer.query(`UPDATE perio_exams SET revision=revision+1,updated_at=NOW() WHERE id=$1`, [f.perioExamId]);
    await writer.query(`UPDATE perio_site_observations SET probing_depth_mm=4.2,bleeding_on_probing=false
      WHERE exam_id=$1 AND tooth_code=12 AND site='DL'`, [f.perioExamId]);
    await writer.query(`UPDATE visits SET case_id=$2,signed_at='2026-10-03T11:00:00Z',signed_by='Concurrent synthetic signer' WHERE id=$1`, [f.visitId, f.perioCaseId]);
    await writer.query("COMMIT");
    const committed = await snapshot();
    gate.release.resolve();
    expect(await reading).toMatchObject({ status: "ready", visitCaseId: null, signedAt: null, signedBy: null,
      endodontics: [{ version: 1, stage: "shaping", measuredCanalCount: 1, obturatedCanalCount: 1 }],
      periodontics: [{ revision: 1, recordedDepthSites: 1, recordedBleedingSites: 2 }] });
    gate.spy.mockRestore();
    expect(await getVisitStructuredClinical(f.visitId, f.patientId)).toMatchObject({ status: "ready", visitCaseId: f.perioCaseId,
      signedAt: "2026-10-03T11:00:00.000Z", signedBy: "Concurrent synthetic signer",
      endodontics: [{ version: 2, stage: "obturation", measuredCanalCount: 2, obturatedCanalCount: 2 }],
      periodontics: [{ revision: 2, recordedDepthSites: 2, recordedBleedingSites: 3 }] });
    expect(await snapshot()).toEqual(committed);
  } finally {
    clearTimeout(timer); gate.release.resolve();
    await reading.catch(() => undefined); gate.spy.mockRestore();
    if (writerConnected) { await writer.query("ROLLBACK").catch(() => undefined); await writer.end().catch(() => undefined); }
  }
});
