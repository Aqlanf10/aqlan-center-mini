import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import type { AppointmentService } from "../../lib/appointment-services";
import { assertRealPostgresUrl, rawPool } from "./_setup";

const pool = rawPool(assertRealPostgresUrl(), 1);
vi.stubEnv("CLINIC_TIME_ZONE", "Asia/Aden");
const { listProviderBlocks } = await import("../../lib/db");
const { evaluateCapacity, loadProviderBlockWindows } = await import("../../lib/capacity-context");
let client: PoolClient;
const DATE = "2026-10-05";
const PROVIDER = 10;
const OTHER_PROVIDER = 20;
const service: AppointmentService = {
  id: 1, code: "CONSULTATION", nameAr: "كشف", nameEn: null, specialty: "consultation",
  defaultDurationMinutes: 15, bufferBeforeMinutes: 0, bufferAfterMinutes: 0,
  requiresProvider: true, requiresChair: true, allowsConcurrentProviderWork: false,
  consumesEmergencyReserve: false, priority: 1, badgeClass: null, isActive: true,
  sortOrder: 1, legacyType: null, createdAt: "2026-01-01T00:00:00Z", createdBy: null,
  updatedAt: "2026-01-01T00:00:00Z", updatedBy: null,
};

beforeAll(async () => {
  client = await pool.connect();
  // The reader's transaction-client path needs only this connection-local fixture.
  // No runtime schema bootstrap, migrations, real tables or provider writers run.
  await client.query(`CREATE TEMP TABLE provider_blocks (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    provider_id integer NOT NULL, starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
    reason text NOT NULL, cancelled_at timestamptz, created_by text NOT NULL DEFAULT 'test',
    created_at timestamptz NOT NULL DEFAULT NOW(), CHECK (ends_at > starts_at)
  )`);
});
beforeEach(async () => { await client.query("TRUNCATE provider_blocks"); });
afterAll(async () => {
  client?.release();
  await pool.end();
  vi.unstubAllEnvs();
});

async function sessionZone(zone: string) {
  await client.query("SELECT set_config('TimeZone', $1, false)", [zone]);
}
async function block(reason: string, startsAt: string, endsAt: string, providerId = PROVIDER, cancelled = false) {
  await client.query(
    `INSERT INTO provider_blocks (provider_id, starts_at, ends_at, reason, cancelled_at)
     VALUES ($1, $2::timestamptz, $3::timestamptz, $4, CASE WHEN $5 THEN NOW() END)`,
    [providerId, startsAt, endsAt, reason, cancelled],
  );
}
async function availability(time: string, providerId = PROVIDER, requiresProvider = true) {
  return evaluateCapacity({
    sameDay: [], date: DATE, time, durationMinutes: 15, providerId,
    service: { ...service, requiresProvider }, client,
    context: {
      shifts: [{ start: "00:00", end: "23:59" }], chairs: 3, nearCapacityPercent: 80,
      emergencyReserveMinutes: 0, newPatientDailyLimit: 0,
    },
  });
}

// Compare the same real reader and capacity path across PostgreSQL session zones.
// Clinic midnight is 21:00 UTC on the previous calendar date.
describe.each(["UTC", "Asia/Aden"])("provider blocks with PostgreSQL session %s", (zone) => {
  beforeEach(async () => { await sessionZone(zone); });

  it("includes local midnight and early blocks on the previous UTC date", async () => {
    await block("midnight", "2026-10-05T00:00:00+03:00", "2026-10-05T00:15:00+03:00");
    await block("early", "2026-10-04T21:30:00Z", "2026-10-04T22:00:00Z");
    const blocks = await listProviderBlocks(PROVIDER, DATE, client);
    expect(blocks.map((row) => row.reason)).toEqual(["midnight", "early"]);
    expect(blocks[0].startsAt).toBe("2026-10-04T21:00:00.000Z");
    expect(await loadProviderBlockWindows(PROVIDER, DATE, client)).toEqual([
      { startMinutes: 0, endMinutes: 15, reason: "midnight" },
      { startMinutes: 30, endMinutes: 60, reason: "early" },
    ]);
    expect((await availability("00:00")).state).toBe("OVER_CAPACITY");
    expect((await availability("00:15")).state).not.toBe("OVER_CAPACITY");
    expect((await availability("00:30")).state).toBe("OVER_CAPACITY");
    expect((await availability("01:00")).state).not.toBe("OVER_CAPACITY");
  });

  it("clips crossing-midnight blocks but excludes blocks merely touching either day boundary", async () => {
    await block("ended-at-start", "2026-10-04T23:00:00+03:00", "2026-10-05T00:00:00+03:00");
    await block("crosses-start", "2026-10-04T23:45:00+03:00", "2026-10-05T00:15:00+03:00");
    await block("crosses-end", "2026-10-05T23:45:00+03:00", "2026-10-06T00:15:00+03:00");
    await block("starts-at-end", "2026-10-06T00:00:00+03:00", "2026-10-06T00:30:00+03:00");
    expect((await listProviderBlocks(PROVIDER, DATE, client)).map((row) => row.reason))
      .toEqual(["crosses-start", "crosses-end"]);
    expect(await loadProviderBlockWindows(PROVIDER, DATE, client)).toEqual([
      { startMinutes: 0, endMinutes: 15, reason: "crosses-start" },
      { startMinutes: 1425, endMinutes: 1440, reason: "crosses-end" },
    ]);
    expect((await availability("00:00")).state).toBe("OVER_CAPACITY");
    expect((await availability("00:15")).state).not.toBe("OVER_CAPACITY");
    const lateVerdict = await availability("23:40");
    expect(lateVerdict.outsideHours).toBe(false);
    expect(lateVerdict.state).toBe("OVER_CAPACITY");
    expect(lateVerdict.reasons.join(" ")).toContain("crosses-end");
  });

  it("includes a block spanning the whole day and retains microsecond boundary precision", async () => {
    await block("spanning", "2026-10-04T12:00:00+03:00", "2026-10-06T12:00:00+03:00");
    await block("first-tick", "2026-10-05T00:00:00+03:00", "2026-10-05T00:00:00.000001+03:00");
    await block("last-tick", "2026-10-05T23:59:59.999999+03:00", "2026-10-06T00:00:00+03:00");
    expect((await listProviderBlocks(PROVIDER, DATE, client)).map((row) => row.reason))
      .toEqual(["spanning", "first-tick", "last-tick"]);
  });

  it("does not leak another provider's blocks or cancelled blocks, or change service policy", async () => {
    await block("cancelled", "2026-10-05T00:00:00+03:00", "2026-10-05T01:00:00+03:00", PROVIDER, true);
    await block("other-doctor", "2026-10-05T00:00:00+03:00", "2026-10-05T01:00:00+03:00", OTHER_PROVIDER);
    expect(await listProviderBlocks(PROVIDER, DATE, client)).toEqual([]);
    expect((await availability("00:15")).state).not.toBe("OVER_CAPACITY");
    expect((await availability("00:15", OTHER_PROVIDER)).state).toBe("OVER_CAPACITY");
    expect((await availability("00:15", OTHER_PROVIDER, false)).state).not.toBe("OVER_CAPACITY");
  });
});

// Reload only the reader's zone constant, not production configuration or helpers.
async function readerForClinic(zone: string) {
  vi.stubEnv("CLINIC_TIME_ZONE", zone);
  vi.resetModules();
  return (await import("../../lib/db")).listProviderBlocks;
}

describe("configured clinic-zone day boundaries", () => {
  it.each([
    { date: "2026-03-08", start: "2026-03-08T05:00:00Z", end: "2026-03-09T04:00:00Z", hours: 23 },
    { date: "2026-11-01", start: "2026-11-01T04:00:00Z", end: "2026-11-02T05:00:00Z", hours: 25 },
  ])("uses independent midnight boundaries for a $hours-hour day", async ({ date, start, end, hours }) => {
    const readBlocks = await readerForClinic("America/New_York");
    expect((Date.parse(end) - Date.parse(start)) / 3_600_000).toBe(hours);
    await block("ends-at-start", new Date(Date.parse(start) - 60_000).toISOString(), start);
    await block("first-minute", start, new Date(Date.parse(start) + 60_000).toISOString());
    await block("last-minute", new Date(Date.parse(end) - 60_000).toISOString(), end);
    await block("starts-at-end", end, new Date(Date.parse(end) + 60_000).toISOString());
    for (const session of ["UTC", "Asia/Aden", "America/New_York"]) {
      await sessionZone(session);
      expect((await readBlocks(PROVIDER, date, client)).map((row) => row.reason))
        .toEqual(["first-minute", "last-minute"]);
    }
  });

  it("includes both repeated midnights, keeping the first midnight's end exclusive", async () => {
    const readBlocks = await readerForClinic("America/Havana");
    // 2026-11-01 repeats 00:00: the first is 04:00Z, the second is 05:00Z.
    await block("ends-at-first-midnight", "2026-11-01T03:30:00Z", "2026-11-01T04:00:00Z");
    await block("first-midnight", "2026-11-01T04:00:00Z", "2026-11-01T04:15:00Z");
    await block("ends-at-second-midnight", "2026-11-01T04:30:00Z", "2026-11-01T05:00:00Z");
    await block("second-midnight", "2026-11-01T05:00:00Z", "2026-11-01T05:15:00Z");
    await block("next-midnight", "2026-11-02T05:00:00Z", "2026-11-02T05:15:00Z");
    for (const session of ["UTC", "Asia/Aden", "America/Havana"]) {
      await sessionZone(session);
      expect((await readBlocks(PROVIDER, "2026-11-01", client)).map((row) => row.reason))
        .toEqual(["first-midnight", "ends-at-second-midnight", "second-midnight"]);
    }
  });
});
