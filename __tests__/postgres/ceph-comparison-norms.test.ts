import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { validateOwnershipHarnessEnvironment } from "../../scripts/verify-schema-ownership";
import { computeAll, type LandmarkMap } from "../../lib/ceph";
import { enrichPresentedCephMeasurements } from "../../lib/cephPresentation";
import { compareAnalyses } from "../../lib/cephCompare";

// Real production readers, genuine PostgreSQL, synthetic owned fixtures only.
const database = `aqlan_ceph_norm_${randomUUID().replace(/-/g, "")}`;
let maintenanceUrl: string;
let created = false;
let db: typeof import("../../lib/db") | undefined;
let fixtureNumber = 0;

beforeAll(async () => {
  const target = validateOwnershipHarnessEnvironment();
  if ([...target.testUrl.searchParams.keys()].some((key) => key !== "sslmode")) {
    throw new Error("Unexpected test connection override.");
  }
  if (!/^aqlan_ceph_norm_[a-f0-9]{32}$/.test(database)) throw new Error("Unsafe fixture database name.");
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

/** pool.end() may finish before all backend sockets have disconnected. */
async function waitForFixtureConnectionsToClose(admin: Client): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (true) {
    const { rows: [row] } = await admin.query<{ connection_count: number }>(
      "SELECT count(*)::int AS connection_count FROM pg_stat_activity WHERE datname = $1",
      [database],
    );
    if (row.connection_count === 0) return;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out draining owned ceph fixture ${database}: ${row.connection_count} connections remain`);
    }
    await delay(25);
  }
}

afterAll(async () => {
  try {
    await db?.resetPoolForTesting();
  } finally {
    vi.unstubAllEnvs();
    if (created) {
      const admin = new Client({ connectionString: maintenanceUrl, ssl: false });
      await admin.connect();
      try {
        await waitForFixtureConnectionsToClose(admin);
        // A new/unexpected connection must fail cleanup, never be force-killed.
        await admin.query(`DROP DATABASE ${database}`);
      }
      finally { await admin.end(); }
    }
  }
});


async function setCatalog(key: string, mean: number | null, active = true) {
  const { rows: [set] } = await db!.getPool().query<{ id: number }>(
    `INSERT INTO ceph_reference_sets(key,name,population,age_min,age_max,sex,version,active,created_by)
     VALUES($1,'Synthetic reference','Synthetic population',20,30,'female','v1',$2,'synthetic-test')
     ON CONFLICT(key) DO UPDATE SET active=EXCLUDED.active RETURNING id`, [key, active]);
  if (mean !== null) await db!.getPool().query(
    `INSERT INTO ceph_reference_values(set_id,code,mean,sd) VALUES($1,'SNA',$2,3)
     ON CONFLICT(set_id,code) DO UPDATE SET mean=EXCLUDED.mean`, [set.id, mean]);
}
// Independent reader fixtures, each with its own patient's only draft. Their
// helper-level comparison below is a mathematical boundary test, NOT a pair
// the public API can admit (cross-patient comparison is correctly prohibited).
async function createReaderFixtures(refSet: string | null, secondRefSet = refSet) {
  const pair: number[] = [];
  for (const [i, angle] of [90, 84].entries()) {
    const n = ++fixtureNumber;
    const { rows: [patient] } = await db!.getPool().query<{ id: number }>(
      `INSERT INTO patients(patient_number,full_name,birth_year)
       VALUES($1,'Synthetic comparison norms fixture',1990) RETURNING id`, [`SYN-CEPH-NORM-${n}`]);
    const { rows: [document] } = await db!.getPool().query<{ id: number }>(
      `INSERT INTO patient_documents(patient_id,kind,title,mime_type,size_bytes,sha256,storage_key,uploaded_by,width,height)
       VALUES($1,'imaging','Synthetic image','image/png',1,$2,'synthetic/no-file.png','synthetic-test',800,600) RETURNING id`,
      [patient.id, 'a'.repeat(64)]);
    const opened = await db!.createCephAnalysis({ patientId: patient.id, documentId: document.id, refSet: i === 0 ? refSet : secondRefSet,
      xrayDate: i === 0 ? "2020-01-01" : "2022-01-01", createdBy: "synthetic-test" });
    if (!opened.ok) throw Error(opened.message);
    const points: LandmarkMap = { S: { x: 0, y: 0 }, N: { x: 100, y: 0 },
      A: { x: 100 - 100 * Math.cos(angle * Math.PI / 180), y: 100 * Math.sin(angle * Math.PI / 180) } };
    expect(computeAll(points, NaN).find(row => row.code === "SNA")?.value).toBe(angle);
    const saved = await db!.updateCephLandmarks(opened.id, Object.entries(points).map(([code, point]) => ({
      code: code as "S" | "N" | "A", x: point!.x, y: point!.y, source: "manual" as const,
    })), "synthetic-test", [], []);
    expect(saved.ok).toBe(true); pair.push(opened.id);
  }
  return pair;
}
async function readPair(pair: number[]) {
  const rows = await Promise.all(pair.map(id => db!.getCephAnalysisForCompare(id)));
  expect(rows.every(Boolean)).toBe(true);
  expect(rows[0]!.patientId).not.toBe(rows[1]!.patientId);
  return rows.map(row => row!);
}
function expectDescriptive(rows: Awaited<ReturnType<typeof readPair>>) {
  expect(rows.map(row => row.measurements.find(m => m.code === "SNA")?.value)).toEqual([90, 84]);
  for (const row of rows) expect.soft(row.measurements.every(m => m.mean === null), "No built-in or selected norm is projected as a comparative target").toBe(true);
  const result = compareAnalyses(rows[0].measurements, rows[1].measurements);
  expect.soft(result).toMatchObject({ interpretation: { mode: "descriptive_only", reason: "reference_suitability_not_established" }, improved: 0, worsened: 0, steady: 0 });
  expect.soft(result.measurements.find(m => m.key === "SNA")).toMatchObject({ before: 90, after: 84, delta: -6, gapBefore: null, gapAfter: null, direction: "ungraded" });
}

describe("actual comparison readers never promote mutable references into clinical trend targets", () => {
  it("preserves the one-draft-per-patient constraint rather than inventing a public two-draft pair", async () => {
    const ids = await createReaderFixtures(null); const first = (await readPair(ids))[0];
    const duplicate = await db!.createCephAnalysis({ patientId: first.patientId, documentId: first.documentId,
      createdBy: "synthetic-test", xrayDate: "2023-01-01" });
    expect(duplicate).toMatchObject({ ok: false });
    expect((await db!.getPool().query("SELECT id FROM ceph_analyses WHERE patient_id=$1 AND status='draft'", [first.patientId])).rows).toHaveLength(1);
  });
  it.each(["selected", "default", "missing", "inactive", "missing-code"])("preserves raw measurements with %s catalog", async kind => {
    const key = kind === "default" ? "builtin_default" : `synthetic-${kind}`;
    if (kind !== "missing") await setCatalog(key, kind === "missing-code" ? null : kind === "default" ? 82 : 95, kind !== "inactive");
    const pair = await createReaderFixtures(kind === "default" ? null : key);
    const rows = await readPair(pair);
    const study = await db!.getCephStudy(pair[0]); expect(study?.analysis.refSet).toBe(key);
    const ref = await db!.getCephReferenceSet(key);
    if (kind === "selected" || kind === "default") expect(ref?.values.SNA.mean).toBe(kind === "selected" ? 95 : 82);
    else if (kind === "missing-code") expect(ref?.values.SNA).toBeUndefined();
    else expect(ref).toBeNull();
    // This documents the source mismatch, not clinical applicability of either mean.
    if (kind === "selected") {
      const presented = enrichPresentedCephMeasurements(computeAll(rows[0].points, NaN), ref!.values, false);
      expect(presented.find(row => row.code === "SNA")?.refMean).toBe(95);
      expect(Math.abs(84 - 82)).toBeLessThan(Math.abs(90 - 82));
      expect(Math.abs(84 - 95)).toBeGreaterThan(Math.abs(90 - 95));
    }
    expectDescriptive(rows);
    // Read-only comparison must not rewrite the selected source or clinical state.
    expect((await db!.getCephStudy(pair[0]))?.analysis).toEqual(study?.analysis);
  });
  it("does not grade independent reader outputs using different selected catalogs", async () => {
    const firstKey = "synthetic-different-first", secondKey = "synthetic-different-second";
    await setCatalog(firstKey, 95); await setCatalog(secondKey, 82);
    const ids = await createReaderFixtures(firstKey, secondKey), rows = await readPair(ids);
    expect((await db!.getCephStudy(ids[0]))?.analysis.refSet).toBe(firstKey);
    expect((await db!.getCephStudy(ids[1]))?.analysis.refSet).toBe(secondKey);
    expect((await db!.getCephReferenceSet(firstKey))?.values.SNA.mean).toBe(95);
    expect((await db!.getCephReferenceSet(secondKey))?.values.SNA.mean).toBe(82);
    expectDescriptive(rows);
  });
  it("keeps raw projection equality when the same catalog key/version changes without changing measurements", async () => {
    const key = "synthetic-mutable"; await setCatalog(key, 95); const pair = await createReaderFixtures(key);
    const before = await readPair(pair); const sourceBefore = (await db!.getCephStudy(pair[0]))!.completionSources;
    await setCatalog(key, 82);
    const after = await readPair(pair); const sourceAfter = (await db!.getCephStudy(pair[0]))!.completionSources;
    expect((await db!.getCephReferenceSet(key))?.version).toBe("v1");
    expect(sourceBefore.state).toBe("available"); expect(sourceAfter.state).toBe("available");
    if (sourceBefore.state === "available" && sourceAfter.state === "available") {
      expect(sourceBefore.identity.referenceSetSha256).not.toBe(sourceAfter.identity.referenceSetSha256);
    }
    expect(after).toEqual(before); expectDescriptive(after);
  });
  it("keeps an unchanged value descriptive after a selected catalog changes", async () => {
    const key = "synthetic-unchanged"; await setCatalog(key, 82); const pair = await createReaderFixtures(key);
    const before = (await readPair(pair))[0]; await setCatalog(key, 90); const after = (await readPair(pair))[0];
    const result = compareAnalyses(before.measurements, after.measurements);
    expect.soft(result.measurements.find(row => row.key === "SNA")).toMatchObject({ delta: 0, gapBefore: null, gapAfter: null, direction: "ungraded" });
    expect.soft(result.steady).toBe(0);
  });
});
