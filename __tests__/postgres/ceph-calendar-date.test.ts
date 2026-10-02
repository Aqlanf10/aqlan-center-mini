import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { validateOwnershipHarnessEnvironment } from "../../scripts/verify-schema-ownership";

// DATE is a calendar value. The pg driver returns local midnight, which must
// not be shifted to UTC before serializing the cephalometric study date.
const database = `aqlan_ceph_date_${randomUUID().replace(/-/g, "")}`;
const originalTimeZone = process.env.TZ;
let maintenanceUrl: string;
let created = false;
let db: typeof import("../../lib/db") | undefined;
let fixtureNumber = 0;

beforeAll(async () => {
  const target = validateOwnershipHarnessEnvironment();
  if ([...target.testUrl.searchParams.keys()].some((key) => key !== "sslmode")) {
    throw new Error("Unexpected test connection override.");
  }
  if (!/^aqlan_ceph_date_[a-f0-9]{32}$/.test(database)) throw new Error("Unsafe fixture database name.");
  maintenanceUrl = target.maintenanceUrl.toString();
  const admin = new Client({ connectionString: maintenanceUrl, ssl: false });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${database}`);
    created = true;
  } finally {
    await admin.end();
  }
  target.testUrl.pathname = `/${database}`;
  vi.stubEnv("DATABASE_URL", target.testUrl.toString());
  vi.stubEnv("DATABASE_ENVIRONMENT", "test");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("USE_LOCAL_DB", "false");
  vi.stubEnv("SKIP_SEED", "true");
  db = await import("../../lib/db");
  await db.resetPoolForTesting();
  await db.ensureSchema();
});

afterEach(() => {
  if (originalTimeZone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimeZone;
});

afterAll(async () => {
  try {
    await db?.resetPoolForTesting();
  } finally {
    vi.unstubAllEnvs();
    if (created) {
      const admin = new Client({ connectionString: maintenanceUrl, ssl: false });
      await admin.connect();
      try { await admin.query(`DROP DATABASE ${database} WITH (FORCE)`); }
      finally { await admin.end(); }
    }
  }
});

async function createStudy(xrayDate: string | null) {
  const { rows: [patient] } = await db!.getPool().query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name, birth_year)
     VALUES ($1, 'Synthetic ceph calendar-date fixture', 1990) RETURNING id`,
    [`SYN-CEPH-DATE-${++fixtureNumber}`],
  );
  const { rows: [document] } = await db!.getPool().query<{ id: number }>(
    `INSERT INTO patient_documents
       (patient_id, kind, title, mime_type, size_bytes, sha256, storage_key, uploaded_by)
     VALUES ($1, 'imaging', 'Synthetic image', 'image/jpeg', 1,
             'ceph-date-fixture', 'synthetic/no-file.jpg', 'ceph-date-test') RETURNING id`,
    [patient.id],
  );
  const result = await db!.createCephAnalysis({
    patientId: patient.id, documentId: document.id, createdBy: "ceph-date-test",
    xrayDate, phase: "during", device: "Synthetic fixture",
  });
  if (!result.ok) throw new Error(result.message);
  return { id: result.id, patientId: patient.id };
}

async function readStudy(id: number, patientId: number) {
  const study = await db!.getCephStudy(id);
  const listed = (await db!.listPatientCephAnalyses(patientId)).find((row) => row.id === id);
  const comparison = await db!.getCephAnalysisForCompare(id);
  expect(study).not.toBeNull();
  expect(listed).toBeDefined();
  expect(comparison).not.toBeNull();
  return { study: study!.analysis, listed: listed!, comparison: comparison! };
}

describe.each([
  { zone: "UTC", januaryOffset: 0 },
  { zone: "Asia/Aden", januaryOffset: -180 },
  { zone: "Europe/Berlin", januaryOffset: -60 },
  { zone: "America/New_York", januaryOffset: 300 },
])("ceph calendar dates on PostgreSQL in $zone", ({ zone, januaryOffset }) => {
  beforeEach(() => {
    process.env.TZ = zone;
    // Fail rather than silently claiming timezone coverage if the runner does
    // not apply TZ to JavaScript Date and the driver's DATE parser.
    expect(new Date(2026, 0, 1).getTimezoneOffset()).toBe(januaryOffset);
  });

  it.each(["2026-08-20", "2026-01-01", null])(
    "round-trips writer DATE %s through study, list, and comparison",
    async (xrayDate) => {
      const { id, patientId } = await createStudy(xrayDate);
      const { rows: [stored] } = await db!.getPool().query<{
        xray_date: Date | null; date_text: string | null; created_at: Date;
      }>("SELECT xray_date, xray_date::text AS date_text, created_at FROM ceph_analyses WHERE id = $1", [id]);
      expect(stored.date_text).toBe(xrayDate);
      if (xrayDate !== null) {
        expect(stored.xray_date).toBeInstanceOf(Date);
        expect(stored.xray_date!.getHours()).toBe(0);
      }
      const readers = await readStudy(id, patientId);
      for (const [name, row] of Object.entries(readers)) {
        expect.soft(row.xrayDate, `${name} calendar date`).toBe(xrayDate);
        expect.soft(row.createdAt, `${name} timestamp`).toBe(stored.created_at.toISOString());
        if (xrayDate === "2026-01-01") {
          // The print report derives age from this year. A shift into December
          // changes the reported age even though the stored DATE is correct.
          expect.soft(new Date(row.xrayDate!).getUTCFullYear() - 1990, `${name} report age`).toBe(36);
        }
      }
      expect(readers.study.completedAt).toBeNull();
      expect(readers.listed.completedAt).toBeNull();
    },
  );

  it("preserves full UTC timestamps when serializing calendar dates", async () => {
    const { id, patientId } = await createStudy(null);
    const createdAt = "2025-12-31T22:30:15.123Z";
    const completedAt = "2026-01-01T01:45:30.456Z";
    // Fixed timestamp fixtures only; clinical completion rules are tested by
    // verify:ceph and are deliberately outside this date-mapping regression.
    await db!.getPool().query(
      `UPDATE ceph_analyses SET status = 'completed', created_at = $2::timestamptz,
         completed_at = $3::timestamptz, completed_by = 'ceph-date-test' WHERE id = $1`,
      [id, createdAt, completedAt],
    );
    const readers = await readStudy(id, patientId);
    for (const row of Object.values(readers)) {
      expect(row).toMatchObject({ xrayDate: null, createdAt, status: "completed" });
    }
    expect(readers.study.completedAt).toBe(completedAt);
    expect(readers.listed.completedAt).toBe(completedAt);
    const { rows: [stored] } = await db!.getPool().query<{ created_at: Date; completed_at: Date }>(
      "SELECT created_at, completed_at FROM ceph_analyses WHERE id = $1", [id],
    );
    expect(stored.created_at.toISOString()).toBe(createdAt);
    expect(stored.completed_at.toISOString()).toBe(completedAt);
  });
});
