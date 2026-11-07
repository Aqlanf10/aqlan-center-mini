import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import * as ceph from "../lib/ceph";
import type { LandmarkMap, MeasurementResult } from "../lib/ceph";

const script = readFileSync(new URL("../scripts/verify-ceph.mjs", import.meta.url), "utf8");
// Execute the actual script's fixture and verification block, not a copied gate.
// The only database operation permitted by this harness is the scoped SELECT
// checking whether a quarantined output was physically stamped. No DB is opened.
const calibrationSource = script.match(/const calibrationState = \(study\) => \(\{[^\n]*\}\);/)?.[0];
if (!calibrationSource) throw new Error("verify-ceph calibration state helper not found");
const calibrationState = runInNewContext(`${calibrationSource}\ncalibrationState;`, {}, { timeout: 1000 });
const snapshotSource = script.match(/const completionSnapshot = \(study\) => \(\{[\s\S]*?\n\}\);/)?.[0];
if (!snapshotSource) throw new Error("verify-ceph completion snapshot helper not found");
const completionSnapshot = runInNewContext(`${snapshotSource}\ncompletionSnapshot;`, {}, { timeout: 1000 });
const fixtureSource = script.match(/const pt = \{[\s\S]*?\};/)?.[0];
if (!fixtureSource) throw new Error("verify-ceph fixture not found");
const pt = runInNewContext(`${fixtureSource}\npt;`, {}, { timeout: 1000 }) as Record<string, [number, number]>;
const points: LandmarkMap = Object.fromEntries(Object.entries(pt).map(([code, [x, y]]) => [code, { x, y }]));
const gateStart = script.indexOf("  const PENDING_LANDMARKS = {");
const gateEnd = script.indexOf("  // ٤) المعتمد يقفل:", gateStart);
if (gateStart < 0 || gateEnd < 0) throw new Error("verify-ceph stamping gate not found");
const gateSource = script.slice(gateStart, gateEnd);

type Stamp = { code: string; value: number };
type Check = { label: string; ok: boolean; extra: string };
async function executeGate(options: {
  computed?: MeasurementResult[];
  stamps?: Stamp[];
  returned?: Stamp[];
  rawQuarantined?: { code: string }[];
} = {}) {
  const computed = options.computed ?? ceph.computeAll(points, 1);
  const stamps = options.stamps ?? computed.filter(row => row.value !== null)
    .map(row => ({ code: row.code, value: row.value! }));
  const checks: Check[] = [];
  const queries: { sql: string; args: unknown[] }[] = [];
  const context = {
    ceph, computed, L: points, mmPerPixel: 1, stamped: stamps, id: 37,
    done: { measurements: options.returned ?? stamps },
    val: (code: string) => stamps.find(row => row.code === code)?.value ?? null,
    check: (label: string, ok: boolean, extra = "") => checks.push({ label, ok, extra }),
    db: { getPool: () => ({ query: async (sql: string, args: unknown[]) => {
      queries.push({ sql, args });
      if (!/^SELECT\s+code\s+FROM\s+ceph_measurements\s+WHERE\s+analysis_id\s*=\s*\$1\s+AND\s+code\s*=\s*\$2\s*$/i.test(sql.trim())) {
        throw new Error(`Unexpected verification query: ${sql}`);
      }
      if (JSON.stringify(args) !== JSON.stringify([37, "EXT_INDEX"])) throw new Error("Unscoped quarantine query");
      return { rows: options.rawQuarantined ?? [] };
    } }) },
  };
  await runInNewContext(`(async () => {${gateSource}\n})()`, context, { timeout: 1000 });
  return { checks, queries, failures: checks.filter(check => !check.ok) };
}

const changed = (code: string, changes: Partial<MeasurementResult>) => ceph.computeAll(points, 1)
  .map(row => row.code === code ? { ...row, ...changes } : row);

describe("operational ceph verification script", () => {
  it("uses anatomically ordered lower-incisor points and independent corrected benchmarks", () => {
    expect(pt.L1A).toEqual([49, 99.2]);
    expect(pt.L1).toEqual([68, 64]);
    expect(pt.Or).toEqual([60, 25]);
    expect(pt.Po).toEqual([0, 25]);
    // Independent analytic references, not expected values taken from computeAll.
    for (const [code, expected] of [["IMPA", 93.4], ["FMIA", 61.6], ["INTER", 131],
      ["SNGOGN", 25.2], ["L1NB_D", 3.2]] as const) {
      expect(gateSource).toMatch(new RegExp(`\\["${code}", ${expected}\\]`));
      expect(ceph.measure(code, points, 1)).toBeCloseTo(expected, 1);
    }
  });

  it("accepts incomplete descriptive EI and excludes the historical code while retaining stamp checks", async () => {
    const result = await executeGate();
    expect(result.failures).toEqual([]);
    expect(result.checks.filter(check => check.label.includes("EXT_INDEX"))).toHaveLength(1);
    expect(result.queries).toHaveLength(1);
  });

  it.each([
    { value: 0 }, { value: 140 }, { value: NaN }, { status: "within" as const },
    { display: "0" }, { severityStars: "*" as const }, { note: undefined },
    { note: "missing landmarks" }, { mean: 153.8 }, { tol: 7.76 },
    { requiresCalibration: false }, { calculationVersion: "legacy" },
  ])("rejects a corrupted incomplete descriptive-index contract %j", async changes => {
    const result = await executeGate({ computed: changed("EI_KIM_1996", changes) });
    expect(result.failures.some(check => check.label.includes("EI_KIM_1996"))).toBe(true);
  });

  it("rejects disappearance of the declared descriptive index", async () => {
    const result = await executeGate({ computed: ceph.computeAll(points, 1).filter(row => row.code !== "EI_KIM_1996") });
    expect(result.failures.some(check => check.label.includes("EI_KIM_1996"))).toBe(true);
  });

  it("rejects a quarantined raw stamp even when the public getter filters it out", async () => {
    const result = await executeGate({ rawQuarantined: [{ code: "EXT_INDEX" }] });
    expect(result.failures.some(check => check.label.includes("EXT_INDEX"))).toBe(true);
    expect(result.queries[0]?.args).toEqual([37, "EXT_INDEX"]);
  });

  it("rejects a quarantined value in the returned approval snapshot", async () => {
    const stamps = ceph.computeAll(points, 1).filter(row => row.value !== null)
      .map(row => ({ code: row.code, value: row.value! }));
    const result = await executeGate({ returned: [...stamps, { code: "EXT_INDEX", value: 140 }] });
    expect(result.failures.some(check => check.label.includes("EXT_INDEX"))).toBe(true);
  });

  it("does not exempt unrelated missing or mismatched measurements", async () => {
    const missing = await executeGate({ computed: changed("SNA", { value: null, display: "—", status: null }) });
    expect(missing.failures.length).toBeGreaterThan(0);
    const stamps = ceph.computeAll(points, 1).filter(row => row.value !== null)
      .map(row => ({ code: row.code, value: row.code === "SNA" ? 0 : row.value! }));
    const mismatch = await executeGate({ stamps });
    expect(mismatch.failures.some(check => check.label.includes("المختوم يساوي الحي"))).toBe(true);
  });

  it("retains environment isolation, ownership cleanup and lifecycle guards", () => {
    const guardIndex = script.indexOf("validateOperationalVerificationEnvironment(process.env, { requireSource: true })");
    const clientIndex = script.indexOf("new Client(");
    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(clientIndex).toBeGreaterThan(guardIndex);
    expect(script).toContain("if (databaseCreated)");
    expect(script).toContain("afterEdit.ok === false");
    expect(script).toContain("afterCal.ok === false");
    expect(script).toContain("afterDx.ok === false");
    expect(script).toContain("again.ok === true");
    expect(script).toContain("JSON.stringify(await readSealState()) === beforeReplay");
    expect(script).toContain("cannotDeleteCompleted.ok === false");
    expect(script).toContain("!wrongActor");
  });
});


const eiStart = script.indexOf("  // BEGIN VERSIONED EI SCENARIO:");
const eiEnd = script.indexOf("  // END VERSIONED EI SCENARIO", eiStart);
if (eiStart < 0 || eiEnd < 0) throw new Error("Versioned EI operational scenario not found");
const eiScenario = script.slice(eiStart, eiEnd);

async function executeVersionedScenario(options: { corruptRaw?: boolean; hideReopened?: boolean } = {}) {
  const checks: Check[] = [];
  let placed: LandmarkMap = {};
  let calibration = NaN;
  let calibrationSource: { x1: number; y1: number; x2: number; y2: number; mm: number } | null = null;
  let snapshots: Stamp[] = [];
  const ensureId = (id: number) => { if (id !== 38) throw new Error("Wrong synthetic analysis"); };
  const context = {
    ceph, calibrationState, completionSnapshot, session: { userId: 91, username: "Synthetic operator", role: "admin", expiresAt: 4_000_000_000_000, credentialVersion: "synthetic" }, patient: { id: 1 }, documentId: 2, doctor: "Synthetic operator",
    check: (label: string, ok: boolean, extra = "") => checks.push({ label, ok, extra }),
    db: {
      createCephAnalysis: async () => ({ ok: true, id: 38 }),
      updateCephCalibration: async (id: number, value: { x1: number; y1: number; x2: number; y2: number; mm: number }, _actor: string, expected: unknown) => {
        ensureId(id);
        expect(expected).toEqual({ calibration: null, mmPerPixel: null });
        calibrationSource = value;
        calibration = ceph.computeMmPerPixel({ x: value.x1, y: value.y1 }, { x: value.x2, y: value.y2 }, value.mm);
        return { ok: true };
      },
      updateCephLandmarks: async (id: number, landmarks: { code: string; x: number; y: number }[]) => {
        ensureId(id);
        placed = Object.fromEntries(landmarks.map(row => [row.code, { x: row.x, y: row.y }]));
        return { ok: true };
      },
      completeCephAnalysis: async (id: number, _actor: string, expected: unknown, session: { userId: number }, sources: unknown) => {
        expect(sources).toEqual({ synthetic: "stable-reviewed-sources" });
        expect(session.userId).toBe(91);
        ensureId(id);
        expect(expected).toMatchObject({ patientId: 1, documentId: 2, refSet: "builtin_default", mmPerPixel: calibration, calibration: calibrationSource });
        if (ceph.REQUIRED_LANDMARKS.some(code => !placed[code])) throw new Error("Incomplete required landmarks");
        snapshots = ceph.computeAll(placed, calibration).filter(row => row.value !== null)
          .map(row => ({ code: row.code, value: row.value! }));
        return { ok: true, measurements: snapshots };
      },
      getCephStudy: async (id: number) => {
        ensureId(id);
        return { completionSources: { state: "available", identity: { synthetic: "stable-reviewed-sources" } }, analysis: { patientId: 1, documentId: 2, refSet: "builtin_default", calibration: calibrationSource, mmPerPixel: Number.isFinite(calibration) ? calibration : null },
          landmarks: Object.entries(placed).map(([code, point]) => ({ code, ...point, source: "manual" })), diagnosis: null,
          measurements: options.hideReopened ? snapshots.filter(row => row.code !== "EI_KIM_1996") : snapshots };
      },
      getCephStampedValues: async (id: number) => { ensureId(id); return snapshots; },
      getPool: () => ({ query: async (sql: string, args: number[]) => {
        expect(sql.trim()).toBe("SELECT code, value FROM ceph_measurements WHERE analysis_id = $1");
        expect(args).toEqual([38]);
        return { rows: options.corruptRaw ? [...snapshots, { code: "EXT_INDEX", value: 140 }] : snapshots };
      } }),
    },
  };
  await runInNewContext(`(async () => {${eiScenario}\n})()`, context, { timeout: 1000 });
  return { checks, failures: checks.filter(check => !check.ok), snapshots };
}

describe("versioned EI operational scenario", () => {
  it("verifies independent CF/INTER/perpendicular lips and versioned stamp/read paths", async () => {
    const outcome = await executeVersionedScenario();
    expect(outcome.failures).toEqual([]);
    expect(outcome.snapshots.find(row => row.code === "EI_KIM_1996")?.value).toBe(151);
    expect(outcome.checks.length).toBeGreaterThanOrEqual(5);
  });
  it.each([{ corruptRaw: true }, { hideReopened: true }])("fails on a corrupted persistence boundary %j", async options => {
    expect((await executeVersionedScenario(options)).failures.some(check => check.label.includes("EI_KIM_1996=151"))).toBe(true);
  });
});

const replayStart = script.indexOf('  // BEGIN READONLY COMPLETION REPLAY');
const replayEnd = script.indexOf('  // END READONLY COMPLETION REPLAY', replayStart);
if (replayStart < 0 || replayEnd < 0) throw new Error('Readonly completion replay gate missing');
const replaySource = script.slice(replayStart, replayEnd);
describe('operational same-actor completion retry', () => {
  it.each([false, true])('checks retained seal and audit state, mutation=%s', async (mutated) => {
    const checks: Check[] = [];
    let queries = 0;
    const session = { userId: 91, username: 'Synthetic signer', role: 'admin', expiresAt: 4_000_000_000_000 };
    await runInNewContext(`(async () => {${replaySource}\n})()`, {
      id: 37, doctor: session.username, session, reviewedSources: { synthetic: 'original-reviewed-sources' }, completionSnapshot: () => ({ reviewed: true }),
      afterEdit: { ok: false }, afterCal: { ok: false }, afterDx: { ok: false },
      check: (label: string, ok: boolean, extra = '') => checks.push({ label, ok, extra }),
      db: {
        getCephStudy: async () => ({}),
        completeCephAnalysis: async (id: number, actor: string, snapshot: unknown, actualSession: unknown, sources: unknown) => {
          expect(sources).toEqual({ synthetic: "original-reviewed-sources" });
          expect(id).toBe(37); expect(actor).toBe(session.username); expect(snapshot).toEqual({ reviewed: true });
          expect(actualSession).toBe(session); return { ok: true };
        },
        getPool: () => ({ query: async (sql: string, params: unknown[]) => {
          expect(sql).toContain('ceph_completion_provenance'); expect(sql).toContain('audit_log'); expect(params).toEqual([37]);
          return { rows: [{ state: { seal: 'unchanged', auditCount: ++queries === 2 && mutated ? 2 : 1 } }] };
        } }),
      },
    }, { timeout: 1000 });
    expect(queries).toBe(2);
    expect(checks.at(-1)?.ok).toBe(!mutated);
  });
});
