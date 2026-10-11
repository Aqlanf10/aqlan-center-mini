import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { validateOwnershipHarnessEnvironment } from "../../scripts/verify-schema-ownership";

// Real pg, never a global int8 parser override. This database belongs only to
// this synthetic test. No production connection, sequence or data is touched.
const database = `aqlan_ceph_dto_${randomUUID().replace(/-/g, "")}`;
let maintenanceUrl: string;
let created = false;
let db: typeof import("../../lib/db") | undefined;
let fixtureNumber = 0;

beforeAll(async () => {
  const target = validateOwnershipHarnessEnvironment();
  if ([...target.testUrl.searchParams.keys()].some(key => key !== "sslmode")) throw new Error("Unexpected connection override.");
  if (!/^aqlan_ceph_dto_[a-f0-9]{32}$/.test(database)) throw new Error("Unsafe owned fixture name.");
  maintenanceUrl = target.maintenanceUrl.toString();
  const admin = new Client({ connectionString: maintenanceUrl, ssl: false });
  await admin.connect();
  try { await admin.query(`CREATE DATABASE ${database}`); created = true; }
  finally { await admin.end(); }
  target.testUrl.pathname = `/${database}`;
  vi.stubEnv("DATABASE_URL", target.testUrl.toString());
  vi.stubEnv("DATABASE_ENVIRONMENT", "test");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("USE_LOCAL_DB", "false");
  vi.stubEnv("SKIP_SEED", "true");
  db = await import("../../lib/db");
  await db.resetPoolForTesting();
  await db.ensureSchema();
  expect(db.getPool()).toBeInstanceOf(Pool);
});

afterAll(async () => {
  try { await db?.resetPoolForTesting(); }
  finally {
    vi.unstubAllEnvs();
    if (created) {
      const admin = new Client({ connectionString: maintenanceUrl, ssl: false });
      await admin.connect();
      try {
        const deadline = Date.now() + 5_000;
        while (true) {
          const { rows: [row] } = await admin.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = $1", [database]);
          if (row.count === 0) break;
          if (Date.now() >= deadline) throw new Error("Owned fixture connections did not drain.");
          await delay(25);
        }
        // Unexpected new connections refuse cleanup; no forced termination.
        await admin.query(`DROP DATABASE ${database}`);
      } finally { await admin.end(); }
    }
  }
});

async function fixture() {
  const { rows: [patient] } = await db!.getPool().query<{ id: number }>(
    "INSERT INTO patients (patient_number, full_name) VALUES ($1, 'Synthetic Ceph DTO fixture') RETURNING id",
    [`SYN-CEPH-DTO-${++fixtureNumber}`]);
  const { rows: [document] } = await db!.getPool().query<{ id: number }>(
    `INSERT INTO patient_documents (patient_id, kind, title, mime_type, size_bytes, sha256, storage_key, uploaded_by)
     VALUES ($1, 'imaging', 'Synthetic image', 'image/png', 1, 'synthetic-ceph-dto', 'synthetic/no-file.png', 'synthetic-ceph-dto') RETURNING id`, [patient.id]);
  return { patientId: patient.id, documentId: document.id };
}

const safeId = (value: unknown, expected: number) => {
  expect(typeof value).toBe("number");
  expect(Number.isSafeInteger(value)).toBe(true);
  expect(value).toBe(expected);
};

describe("Ceph identity DTOs through the actual PostgreSQL pool", () => {
  it.each([1, 2_147_483_648])("round-trips identity, stored findings and exact correction lineage starting at %s", async start => {
    const f = await fixture();
    await db!.getPool().query("SELECT setval(pg_get_serial_sequence('ceph_analyses', 'id'), $1::bigint, false)", [String(start)]);
    const opened = await db!.createCephAnalysis({ ...f, phase: "during", xrayDate: "2026-08-20", createdBy: "synthetic-ceph-dto" });
    if (!opened.ok) throw new Error(opened.message);
    safeId(opened.id, start);
    // Stored measurements are deliberately explicit literals, not recalculated
    // from landmarks; identity normalization must not hide or change them.
    await db!.getPool().query(`UPDATE ceph_analyses SET status='completed', completed_by='synthetic-ceph-dto', completed_at=NOW(),
      cal_x1=10.25, cal_y1=20.5, cal_x2=30.75, cal_y2=40.125, cal_mm=5.5, mm_per_pixel=0.125 WHERE id=$1`, [opened.id]);
    await db!.getPool().query("INSERT INTO ceph_measurements (analysis_id, code, value) VALUES ($1,'ANB',3.4),($1,'FMA',27.25),($1,'WITS',-2.5)", [opened.id]);
    const before = (await db!.getPool().query("SELECT to_jsonb(a) AS row FROM ceph_analyses a WHERE id=$1", [opened.id])).rows[0].row;
    const stored = (await db!.getPool().query<{ analysis_id: string; code: string; value: number }>(
      "SELECT analysis_id,code,value FROM ceph_measurements WHERE analysis_id=$1 ORDER BY code", [opened.id])).rows;
    const raw = (await db!.getPool().query<{ id: string }>("SELECT id FROM ceph_analyses WHERE id=$1", [opened.id])).rows[0];
    expect(raw.id).toBe(String(start));
    expect(stored.every(row => typeof row.analysis_id === "string" && row.analysis_id === raw.id)).toBe(true);

    const study = await db!.getCephStudy(opened.id);
    const listed = (await db!.listPatientCephAnalyses(f.patientId)).find(row => row.id === opened.id);
    const comparison = await db!.getCephAnalysisForCompare(opened.id);
    expect(study).not.toBeNull(); expect(listed).toBeDefined(); expect(comparison).not.toBeNull();
    for (const row of [study!.analysis, listed!, comparison!]) {
      safeId(row.id, start); safeId(row.patientId, f.patientId); safeId(row.documentId, f.documentId);
      expect(row.orthoCaseId).toBeNull(); expect(row.xrayDate).toBe("2026-08-20"); expect(row.mmPerPixel).toBe(0.125);
    }
    expect(listed!.findings).toEqual({ anb: 3.4, fma: 27.25, wits: -2.5 });
    expect(study!.measurements).toEqual(expect.arrayContaining(stored.map(({ code, value }) => ({ code, value }))));
    expect(study!.analysis.calibration).toEqual({ x1: 10.25, y1: 20.5, x2: 30.75, y2: 40.125, mm: 5.5 });

    const correction = await db!.duplicateCephAnalysis(opened.id, "synthetic-ceph-dto");
    if (!correction.ok) throw new Error(correction.message);
    safeId(correction.id, start + 1); expect(correction.replayed).toBe(false);
    expect(await db!.duplicateCephAnalysis(opened.id, "synthetic-ceph-dto")).toEqual({ ok: true, id: start + 1, replayed: true });
    const original = (await db!.getCephStudy(opened.id))!.analysis;
    const child = (await db!.getCephStudy(correction.id))!.analysis;
    expect(original.correctsAnalysisId).toBeNull(); expect(original.correctedBy).toEqual([start + 1]);
    safeId(child.correctsAnalysisId, start); expect(child.correctedBy).toEqual([]);
    const lineage = (await db!.getPool().query<{ parent: string; children: string[] }>(
      "SELECT $1::bigint AS parent, ARRAY[$2::bigint] AS children", [opened.id, correction.id])).rows[0];
    expect(lineage).toEqual({ parent: String(start), children: [String(start + 1)] });
    expect((await db!.getPool().query("SELECT to_jsonb(a) AS row FROM ceph_analyses a WHERE id=$1", [opened.id])).rows[0].row).toEqual(before);
    expect((await db!.getPool().query("SELECT analysis_id,code,value FROM ceph_measurements WHERE analysis_id=$1 ORDER BY code", [opened.id])).rows).toEqual(stored);
  });

  it("refuses unsafe BIGINT identities and lineage rather than rounding them into a DTO", async () => {
    const f = await fixture();
    await db!.getPool().query(`INSERT INTO ceph_analyses (id,patient_id,document_id,status,created_by)
      VALUES ('9007199254740993'::bigint,$1,$2,'completed','synthetic-ceph-dto')`, [f.patientId, f.documentId]);
    await expect(db!.listPatientCephAnalyses(f.patientId)).rejects.toThrow(RangeError);
    const parentFixture = await fixture();
    const parent = await db!.createCephAnalysis({ ...parentFixture, createdBy: "synthetic-ceph-dto" });
    if (!parent.ok) throw new Error(parent.message);
    await db!.getPool().query("UPDATE ceph_analyses SET status='completed' WHERE id=$1", [parent.id]);
    await db!.getPool().query(`INSERT INTO ceph_analyses (id,patient_id,document_id,status,created_by,corrects_analysis_id)
      VALUES ('9007199254740995'::bigint,$1,$2,'draft','synthetic-ceph-dto',$3)`, [parentFixture.patientId, parentFixture.documentId, parent.id]);
    await expect(db!.getCephStudy(parent.id)).rejects.toThrow(RangeError);
    await expect(db!.duplicateCephAnalysis(parent.id, "synthetic-ceph-dto")).rejects.toThrow(RangeError);
  });
});
