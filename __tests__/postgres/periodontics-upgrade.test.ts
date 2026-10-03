// Reconstructed after environment loss; proof applies only to fresh guarded fixtures.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validatePostgresTestTarget } from "./_safe-target";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
import { loadMigrationFiles, migrate } from "../../lib/migrations";
import { PERIODONTICS_SQL } from "../../lib/periodontics-schema";

const target = validatePostgresTestTarget(process.env, { allowDatabaseUrlFallback: true });
assertRealPostgresUrl(); stubPostgresEnv(); process.env.SKIP_SEED = "true";
const db = await import("../../lib/db");
const perio = await import("../../lib/periodontics-db");
const q = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.getPool().query<T>(sql, values)).rows;
let patientId: number; let visitId: number; let caseId: number; let doctorId: number;
let parentsBefore: unknown; let registryBefore: unknown;
const parents = async () => ({
  patients: await q(`SELECT * FROM patients WHERE id=$1`, [patientId]),
  visits: await q(`SELECT * FROM visits WHERE id=$1`, [visitId]),
  cases: await q(`SELECT * FROM clinical_cases WHERE id=$1`, [caseId]),
});
beforeAll(async () => {
  await dropPublicSchema(target.testUrl.toString());
  const files = await loadMigrationFiles();
  expect(files).toHaveLength(41);
  const oldFiles = files.filter((file) => file.version !== "0041");
  const fresh = await migrate(db.getPool(), { apply: true, files: oldFiles });
  expect(fresh.adoptedBaseline).toBe(false);
  expect(fresh.appliedVersions).toHaveLength(40);
  doctorId = (await q<{ id: number }>(`INSERT INTO parties(name,kind) VALUES ('Synthetic upgrade doctor','doctor') RETURNING id`))[0].id;
  patientId = (await q<{ id: number }>(`INSERT INTO patients(patient_number,full_name) VALUES ('PERIO-UPGRADE','Synthetic upgrade patient') RETURNING id`))[0].id;
  visitId = (await q<{ id: number }>(`INSERT INTO visits(patient_id,patient_name,doctor_id) VALUES ($1,'Synthetic upgrade patient',$2) RETURNING id`, [patientId, doctorId]))[0].id;
  caseId = (await q<{ id: number }>(`INSERT INTO clinical_cases(patient_id,specialty,title,created_by) VALUES ($1,'periodontics','Existing upgrade context','synthetic') RETURNING id`, [patientId]))[0].id;
  parentsBefore = await parents();
  registryBefore = await q(`SELECT * FROM schema_migrations ORDER BY version`);
});
afterAll(async () => { await db.resetPoolForTesting(); });

describe("populated periodontal migration without baseline adoption", () => {
  it("applies only0041 and preserves preexisting patient/visit/case and old migration registry", async () => {
    expect((await q(`SELECT to_regclass('public.perio_exams') AS name`))[0].name).toBeNull();
    const upgraded = await migrate(db.getPool(), { apply: true });
    expect(upgraded).toMatchObject({ adoptedBaseline: false, appliedVersions: ["0041"] });
    expect(await parents()).toEqual(parentsBefore);
    expect(await q(`SELECT * FROM schema_migrations WHERE version <> '0041' ORDER BY version`)).toEqual(registryBefore);
    expect(await q(`SELECT * FROM perio_exams`)).toEqual([]);
  });
  it("repeated numbered/runtime SQL preserves signed exams, observation IDs and append-only addenda", async () => {
    const saved = await perio.savePerioExam({ patientId, visitId, actor: "synthetic recorder", expectedRevision: null,
      draft: { doctorId, caseId, sites: [{ toothCode: 11, site: "MB", probingDepthMm: 0, bleedingOnProbing: false }] } });
    if (!saved.ok) throw new Error(saved.reason);
    expect((await db.signClinicalVisit({ visitId, baseCurrency: "YER", signedBy: "synthetic signer", signerDoctorPartyId: doctorId })).reason).toBeNull();
    expect(await perio.addPerioAddendum({ patientId, examId: saved.exam.id, actor: "synthetic recorder", text: "Synthetic correction", requestKey: "perio:upgrade-repeat" })).toMatchObject({ ok: true });
    const snapshot = async () => ({
      exams: await q(`SELECT * FROM perio_exams ORDER BY id`), sites: await q(`SELECT * FROM perio_site_observations ORDER BY id`),
      addenda: await q(`SELECT * FROM perio_addenda ORDER BY id`), registry: await q(`SELECT * FROM schema_migrations ORDER BY version`),
      view: await perio.listPatientPerio(patientId),
    });
    const before = await snapshot();
    expect(await migrate(db.getPool(), { apply: true })).toMatchObject({ adoptedBaseline: false, appliedVersions: [], alreadyUpToDate: true });
    await q(PERIODONTICS_SQL); await q(PERIODONTICS_SQL);
    expect(await snapshot()).toEqual(before);
  });
});
