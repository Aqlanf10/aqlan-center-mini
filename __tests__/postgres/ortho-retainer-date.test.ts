import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaseStatus, RetainerType } from "../../lib/ortho";
import { validatePostgresTestTarget } from "./_safe-target";
import { assertPostgresMajorOrThrow, postgresMajorFromVersionNum } from "../../lib/env-contract";

// Only authentication/access are mocked. PATCH, getOrthoCase, setRetainer,
// closeOrthoCase and all their SQL execute against a fresh owned PostgreSQL DB.
vi.mock("../../lib/session", () => ({ requireSession: vi.fn() }));
vi.mock("../../lib/patient-access", () => ({ canAccessPatient: vi.fn() }));
import { requireSession } from "../../lib/session";
import { canAccessPatient } from "../../lib/patient-access";

const database = `aqlan_retainer_date_${randomUUID().replace(/-/g, "")}`;
const ACTOR = "synthetic-retainer-date";
const D0 = "2026-07-15";
const D1 = "2026-08-20";
const D2 = "2026-10-06";
let maintenanceUrl: string;
let fixtureUrl: string;
let created = false;
let sequence = 0;
let db: typeof import("../../lib/db") | undefined;
let route: typeof import("../../app/api/ortho/[id]/route");
let countsBefore: Record<string, number>;

// Test-only forwarding input: old product writers ignore the optional probe
// flag; fixed writers consume it. No cast, flag deletion, SQL mock or branching.
// All required product fields and the real return type remain compiler-checked.
type RetainerProbeInput = Parameters<NonNullable<typeof db>["setRetainer"]>[0] & {
  preserveExistingDeliveryDate?: boolean;
};
function setRetainerForProbe(input: RetainerProbeInput) {
  return db!.setRetainer(input);
}

beforeAll(async () => {
  // Validate the ORIGINAL environment before replacing URLs or test markers.
  const target = validatePostgresTestTarget(process.env, { allowDatabaseUrlFallback: true });
  if ([...target.testUrl.searchParams.keys()].some((key) => key !== "sslmode")) {
    throw new Error("Unexpected test connection override.");
  }
  if (!/^aqlan_retainer_date_[a-f0-9]{32}$/.test(database)) throw new Error("Unsafe fixture name.");
  maintenanceUrl = target.maintenanceUrl.toString();
  const admin = new Client({ connectionString: maintenanceUrl, ssl: false });
  await admin.connect();
  try {
    const { rows: [server] } = await admin.query<{ version: string }>(
      "SELECT current_setting('server_version_num') AS version",
    );
    assertPostgresMajorOrThrow(postgresMajorFromVersionNum(server.version));
    // Fresh-only: collision is an error. Never drop an existing database here.
    await admin.query(`CREATE DATABASE ${database}`);
    created = true;
  } finally { await admin.end(); }
  target.testUrl.pathname = `/${database}`;
  fixtureUrl = target.testUrl.toString();
  vi.stubEnv("DATABASE_URL", fixtureUrl);
  vi.stubEnv("DATABASE_ENVIRONMENT", "test");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("USE_LOCAL_DB", "false");
  vi.stubEnv("SKIP_SEED", "true");
  vi.stubEnv("CLINIC_TIME_ZONE", "Asia/Aden");
  vi.stubEnv("TZ", "UTC");
  vi.stubEnv("DB_POOL_MAX", "5");
  db = await import("../../lib/db");
  await db.resetPoolForTesting();
  await db.ensureSchema();
  route = await import("../../app/api/ortho/[id]/route");
  expect(db.CLINIC_TIME_ZONE).toBe("Asia/Aden");
});

beforeEach(async () => {
  vi.mocked(requireSession).mockResolvedValue({
    userId: 7, username: ACTOR, role: "admin", expiresAt: 4_102_444_800_000,
  });
  vi.mocked(canAccessPatient).mockResolvedValue(true);
  countsBefore = await unrelatedCounts();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.clearAllMocks();
  if (db && countsBefore) expect(await unrelatedCounts()).toEqual(countsBefore);
});

afterAll(async () => {
  try { await db?.resetPoolForTesting(); }
  finally {
    vi.unstubAllEnvs();
    if (created) {
      const admin = new Client({ connectionString: maintenanceUrl, ssl: false });
      await admin.connect();
      try {
        await until(async () => {
          const { rows: [row] } = await admin.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1", [database],
          );
          return row.n === 0;
        }, "owned fixture connections drained");
        // No FORCE, no existing fixture reset, no Production target.
        await admin.query(`DROP DATABASE ${database}`);
      } finally { await admin.end(); }
    }
  }
});

async function unrelatedCounts(): Promise<Record<string, number>> {
  return (await db!.getPool().query<Record<string, number>>(`SELECT
    (SELECT count(*)::int FROM ortho_adjustments) AS adjustments,
    (SELECT count(*)::int FROM visits) AS visits,
    (SELECT count(*)::int FROM invoices) AS invoices,
    (SELECT count(*)::int FROM payments) AS payments,
    (SELECT count(*)::int FROM expenses) AS expenses,
    (SELECT count(*)::int FROM treatment_plans) AS plans,
    (SELECT count(*)::int FROM journal_manual) AS journals,
    (SELECT count(*)::int FROM journal_manual_lines) AS journal_lines`)).rows[0];
}

async function fixture(retainer: RetainerType | null = null, deliveredOn: string | null = null,
  status: CaseStatus = "active") {
  const { rows: [patient] } = await db!.getPool().query<{ id: number }>(
    "INSERT INTO patients (patient_number, full_name) VALUES ($1, $1) RETURNING id",
    [`SYN-RETAINER-${++sequence}`],
  );
  const { rows: [row] } = await db!.getPool().query<{ id: number }>(
    `INSERT INTO ortho_cases (patient_id, status, phase, retainer, retainer_on,
       upper_wire, lower_wire, start_date, planned_months, note, created_by,
       closed_at, closed_by, closed_note)
     VALUES ($1, $2, 'finishing', $3, $4::date, '019 SS', '017 TMA', '2025-01-01', 20,
       'Synthetic unchanged note', $5,
       CASE WHEN $2 IN ('completed','discontinued') THEN '2026-09-01T10:00:00Z'::timestamptz END,
       CASE WHEN $2 IN ('completed','discontinued') THEN $5 END,
       CASE WHEN $2 IN ('completed','discontinued') THEN 'Synthetic closure' END)
     RETURNING id`, [patient.id, status, retainer, deliveredOn, ACTOR],
  );
  return row.id;
}

async function state(id: number): Promise<Record<string, unknown>> {
  const { rows: [row] } = await db!.getPool().query<{ state: Record<string, unknown> }>(
    "SELECT to_jsonb(c) AS state FROM ortho_cases c WHERE id = $1", [id],
  );
  return row.state;
}

async function patch(id: number, body: unknown) {
  return route.PATCH(new Request(`https://synthetic.invalid/api/ortho/${id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: String(id) }) });
}

function at(instant: string) {
  // Keep timers and performance.now real so PostgreSQL barriers can progress.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(instant));
}

async function until(condition: () => Promise<boolean>, label: string) {
  const deadline = performance.now() + 8_000;
  while (performance.now() < deadline) {
    if (await condition()) return;
    // Time is only a polling interval, never the concurrency success oracle.
    await delay(20);
  }
  throw new Error(`Did not observe PostgreSQL barrier: ${label}`);
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };
function observe<T>(promise: Promise<T>) {
  const state: { result?: Outcome<T> } = {};
  const settled = promise.then(
    (value): Outcome<T> => (state.result = { ok: true, value }),
    (error: unknown): Outcome<T> => (state.result = { ok: false, error }),
  );
  return { state, settled };
}
function unwrap<T>(outcome: Outcome<T>): T {
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
const SETTER = "%UPDATE ortho_cases SET retainer =%";
const CLOSER = "%SELECT status, retainer FROM ortho_cases%";
const PHASE = "%UPDATE ortho_cases SET phase =%";

async function waitForWriter(observer: Client, pattern: string, blocker: number, exclude = 0) {
  let pid = 0;
  await until(async () => {
    const { rows } = await observer.query<{ pid: number }>(`SELECT pid FROM pg_stat_activity
      WHERE datname = current_database() AND application_name = 'aqlan-center-mini'
        AND state = 'active' AND wait_event_type = 'Lock' AND query ILIKE $1
        AND $2::int = ANY(pg_blocking_pids(pid)) AND pid <> $3 ORDER BY pid LIMIT 1`,
    [pattern, blocker, exclude]);
    pid = rows[0]?.pid ?? 0;
    return pid !== 0;
  }, `writer ${pattern} blocked behind pid ${blocker}`);
  return pid;
}

/** Three independent connections create an observed lock queue. The first
 * actual writer must block behind our row lock; the second must be blocked by
 * the first writer's PID (hard/soft PostgreSQL blocker), not merely be pending.
 * Both operations are real application calls, with no SQL/writer replacement. */
async function orderedPair<A, B>(id: number, first: () => Promise<A>, firstPattern: string,
  second: () => Promise<B>, secondPattern: string): Promise<[A, B]> {
  const controller = new Client({ connectionString: fixtureUrl, ssl: false });
  const observer = new Client({ connectionString: fixtureUrl, ssl: false });
  let a: ReturnType<typeof observe<A>> | undefined;
  let b: ReturnType<typeof observe<B>> | undefined;
  try {
    await controller.connect(); await observer.connect();
    await controller.query("BEGIN");
    const { rows: [owner] } = await controller.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    await controller.query("SELECT id FROM ortho_cases WHERE id = $1 FOR UPDATE", [id]);
    a = observe(first());
    const firstPid = await waitForWriter(observer, firstPattern, owner.pid);
    expect(a.state.result).toBeUndefined();
    b = observe(second());
    const secondPid = await waitForWriter(observer, secondPattern, firstPid, firstPid);
    expect(secondPid).not.toBe(firstPid);
    expect(a.state.result).toBeUndefined(); expect(b.state.result).toBeUndefined();
    await controller.query("COMMIT");
    return [unwrap(await a.settled), unwrap(await b.settled)];
  } finally {
    await controller.query("ROLLBACK").catch(() => {});
    await Promise.all([a?.settled, b?.settled]);
    await Promise.all([controller.end(), observer.end()]);
  }
}

describe("real PostgreSQL retainer delivery dates", () => {
  it.each([
    { label: "first delivery", beforeType: null, beforeDate: null, type: "essix", expected: D2 },
    { label: "repeat same type", beforeType: "essix", beforeDate: D1, type: "essix", expected: D1 },
    { label: "changed type", beforeType: "essix", beforeDate: D1, type: "hawley", expected: D2 },
    { label: "nullable prior date", beforeType: "essix", beforeDate: null, type: "essix", expected: D2 },
    { label: "none clears a known date", beforeType: "essix", beforeDate: D1, type: "none", expected: null },
    { label: "repeated none", beforeType: "none", beforeDate: null, type: "none", expected: null },
    { label: "none never preserves a stray known date", beforeType: "none", beforeDate: D1, type: "none", expected: null },
    { label: "none to delivery", beforeType: "none", beforeDate: null, type: "bonded", expected: D2 },
  ] as const)("$label preserves unrelated case fields", async ({ beforeType, beforeDate, type, expected }) => {
    const id = await fixture(beforeType, beforeDate);
    const unrelated = await fixture("hawley", D0, "retention");
    const before = await state(id); const otherBefore = await state(unrelated);
    expect(await setRetainerForProbe({ id, retainer: type, deliveredOn: type === "none" ? null : D2,
      preserveExistingDeliveryDate: true })).toBe(true);
    expect(await state(id)).toEqual({ ...before, retainer: type, retainer_on: expected, status: "retention" });
    expect(await state(unrelated)).toEqual(otherBefore);
    expect((await db!.getOrthoCase(id, D2))?.retainerOn).toBe(expected);
  });

  it("three-field direct callers and explicit false retain deliberate date corrections", async () => {
    const id = await fixture("essix", D1, "retention");
    expect(await db!.setRetainer({ id, retainer: "essix", deliveredOn: D0 })).toBe(true);
    expect((await state(id)).retainer_on).toBe(D0);
    expect(await setRetainerForProbe({ id, retainer: "essix", deliveredOn: D2,
      preserveExistingDeliveryDate: false })).toBe(true);
    expect((await state(id)).retainer_on).toBe(D2);
    // The old direct-call contract also permits null; do not broaden this fix.
    expect(await db!.setRetainer({ id, retainer: "essix", deliveredOn: null })).toBe(true);
    expect((await state(id)).retainer_on).toBeNull();
  });

  it("real PATCH on two different clinic days retains the first delivered date", async () => {
    const id = await fixture();
    at("2026-08-19T21:30:00.000Z");
    expect((await patch(id, { retainer: "essix" })).status).toBe(200);
    expect((await state(id)).retainer_on).toBe(D1);
    at("2026-10-05T21:30:00.000Z");
    expect((await patch(id, { retainer: "essix" })).status).toBe(200);
    expect((await state(id)).retainer_on).toBe(D1);
    expect((await patch(id, { retainer: "essix", retainerOn: D0 })).status).toBe(200);
    expect((await state(id)).retainer_on).toBe(D0);
    expect((await patch(id, { retainer: "essix" })).status).toBe(200);
    expect((await state(id)).retainer_on).toBe(D0);
    expect((await patch(id, { retainer: "hawley" })).status).toBe(200);
    expect((await state(id)).retainer_on).toBe(D2);
  });

  it("real PATCH none clears a known date and permits completion; null retainer still blocks it", async () => {
    const id = await fixture("essix", D1);
    expect((await patch(id, { retainer: "none", retainerOn: D0 })).status).toBe(200);
    expect(await state(id)).toMatchObject({ retainer: "none", retainer_on: null, status: "retention" });
    expect((await patch(id, { retainer: "none" })).status).toBe(200);
    expect(await db!.closeOrthoCase({ id, status: "completed", actor: ACTOR, note: null })).toEqual({ ok: true });
    const missingRetainer = await fixture(); const before = await state(missingRetainer);
    expect((await db!.closeOrthoCase({ id: missingRetainer, status: "completed", actor: ACTOR, note: null })).ok).toBe(false);
    expect(await state(missingRetainer)).toEqual(before);
  });

  it.each(["completed", "discontinued"] as const)("%s cannot be mutated or reopened", async (status) => {
    const id = await fixture("essix", D1, status); const before = await state(id);
    for (const retainer of ["essix", "hawley", "none"] as const) {
      expect(await setRetainerForProbe({ id, retainer, deliveredOn: retainer === "none" ? null : D0,
        preserveExistingDeliveryDate: true })).toBe(false);
      expect((await patch(id, { retainer, retainerOn: D0 })).status).toBe(409);
      expect(await state(id)).toEqual(before);
    }
  });

  it("a missing case is not created by the writer or route", async () => {
    expect(await setRetainerForProbe({ id: 2_000_000_000, retainer: "essix", deliveredOn: D1,
      preserveExistingDeliveryDate: true })).toBe(false);
    expect((await patch(2_000_000_000, { retainer: "essix" })).status).toBe(404);
    expect((await db!.getPool().query("SELECT id FROM ortho_cases WHERE id = 2000000000")).rows).toEqual([]);
  });

  it("an impossible explicit calendar date keeps the existing error/atomicity contract", async () => {
    const id = await fixture("essix", D1, "retention"); const before = await state(id);
    expect((await patch(id, { retainer: "essix", retainerOn: "2026-02-30" })).status).toBe(500);
    expect(await state(id)).toEqual(before);
  });
});

describe("observed PostgreSQL lock-current decisions", () => {
  it("a waiting real PATCH preserves the explicit correction committed after its case read", async () => {
    const id = await fixture("essix", D1, "retention");
    at("2026-10-05T21:30:00.000Z");
    const [correction, repeat] = await orderedPair(id,
      () => db!.setRetainer({ id, retainer: "essix", deliveredOn: D0 }), SETTER,
      () => patch(id, { retainer: "essix" }), SETTER);
    expect(correction).toBe(true); expect(repeat.status).toBe(200);
    expect((await state(id)).retainer_on).toBe(D0);
  });

  it("repeat first, explicit correction second, then another repeat retain the correction", async () => {
    const id = await fixture("essix", D1, "retention");
    at("2026-10-05T21:30:00.000Z");
    const [repeat, correction] = await orderedPair(id,
      () => patch(id, { retainer: "essix" }), SETTER,
      () => db!.setRetainer({ id, retainer: "essix", deliveredOn: D0 }), SETTER);
    expect(repeat.status).toBe(200); expect(correction).toBe(true);
    expect((await state(id)).retainer_on).toBe(D0);
    expect((await patch(id, { retainer: "essix" })).status).toBe(200);
    expect((await state(id)).retainer_on).toBe(D0);
  });

  it("competing first deliveries of the same type retain the first committed fallback", async () => {
    const id = await fixture();
    const [first, second] = await orderedPair(id,
      () => setRetainerForProbe({ id, retainer: "essix", deliveredOn: D1, preserveExistingDeliveryDate: true }), SETTER,
      () => setRetainerForProbe({ id, retainer: "essix", deliveredOn: D2, preserveExistingDeliveryDate: true }), SETTER);
    expect([first, second]).toEqual([true, true]);
    expect(await state(id)).toMatchObject({ retainer: "essix", retainer_on: D1, status: "retention" });
  });

  it.each(["completed", "discontinued"] as const)("%s before a waiting PATCH rechecks the closed guard", async (status) => {
    const id = await fixture("essix", D1, "retention"); const before = await state(id);
    const [close, repeat] = await orderedPair(id,
      () => db!.closeOrthoCase({ id, status, actor: ACTOR, note: "Synthetic queued closure" }), CLOSER,
      () => patch(id, { retainer: "hawley", retainerOn: D0 }), SETTER);
    expect(close).toEqual({ ok: true }); expect(repeat.status).toBe(409);
    const after = await state(id);
    expect(after).toEqual({ ...before, status, closed_at: expect.any(String),
      closed_by: ACTOR, closed_note: "Synthetic queued closure" });
  });

  it("a setter before completion succeeds, closure succeeds, then further saves cannot mutate", async () => {
    const id = await fixture();
    const [saved, closed] = await orderedPair(id,
      () => setRetainerForProbe({ id, retainer: "essix", deliveredOn: D1, preserveExistingDeliveryDate: true }), SETTER,
      () => db!.closeOrthoCase({ id, status: "completed", actor: ACTOR, note: null }), CLOSER);
    expect(saved).toBe(true); expect(closed).toEqual({ ok: true });
    const before = await state(id);
    expect(before).toMatchObject({ status: "completed", retainer: "essix", retainer_on: D1 });
    expect(await db!.setRetainer({ id, retainer: "essix", deliveredOn: D0 })).toBe(false);
    expect(await state(id)).toEqual(before);
  });

  it("different type selections retain last-writer type/date coherence", async () => {
    const id = await fixture("bonded", D0, "retention");
    expect(await orderedPair(id,
      () => setRetainerForProbe({ id, retainer: "essix", deliveredOn: D1, preserveExistingDeliveryDate: true }), SETTER,
      () => setRetainerForProbe({ id, retainer: "hawley", deliveredOn: D2, preserveExistingDeliveryDate: true }), SETTER))
      .toEqual([true, true]);
    expect(await state(id)).toMatchObject({ retainer: "hawley", retainer_on: D2 });
  });

  it("an independent phase write survives a waiting type-only save", async () => {
    const id = await fixture("essix", D1, "retention");
    expect(await orderedPair(id,
      () => db!.setOrthoPhase(id, "working"), PHASE,
      () => setRetainerForProbe({ id, retainer: "essix", deliveredOn: D2, preserveExistingDeliveryDate: true }), SETTER))
      .toEqual([true, true]);
    expect(await state(id)).toMatchObject({ retainer: "essix", retainer_on: D1, phase: "working", status: "retention" });
  });
});
