import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HISTORICAL_BOOKING_0090 as published, inspectHistoricalBooking0090 } from "../../lib/historical-booking-0090";
import { validatePostgresTestTarget } from "./_safe-target";

const exactSql = `-- Additive request metadata only; existing requests retain their original meaning.
ALTER TABLE booking_requests ADD COLUMN request_key TEXT;
ALTER TABLE booking_requests ADD COLUMN request_hash TEXT;
ALTER TABLE booking_requests ADD COLUMN preferences JSONB NOT NULL DEFAULT '{}'::jsonb;
CREATE UNIQUE INDEX booking_requests_request_key_idx ON booking_requests (request_key) WHERE request_key IS NOT NULL;
`;
const name = "aqlan_historical_0090_" + randomUUID().replaceAll("-", "");
let reader: Client, writer: Client, admin: Client, created = false;
const queryWriter = (text: string, values?: unknown[]) => writer.query(text, values);

beforeAll(async () => {
  const target = validatePostgresTestTarget();
  admin = new Client({ connectionString: target.maintenanceUrl.toString(), ssl: false });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  created = true;
  target.testUrl.pathname = "/" + name;
  reader = new Client({ connectionString: target.testUrl.toString(), ssl: false });
  writer = new Client({ connectionString: target.testUrl.toString(), ssl: false });
  await Promise.all([reader.connect(), writer.connect()]);
});
beforeEach(async () => {
  await queryWriter(`DROP TABLE IF EXISTS public.booking_requests, public.schema_migrations CASCADE;
    DROP VIEW IF EXISTS public.booking_requests_request_key_idx;
    CREATE TABLE public.booking_requests(id integer PRIMARY KEY);
    CREATE TABLE public.schema_migrations(version text PRIMARY KEY, name text NOT NULL, checksum text NOT NULL,
      adopted boolean NOT NULL DEFAULT false);`);
});
afterAll(async () => {
  await Promise.all([reader?.end(), writer?.end()]);
  try { if (created) await admin.query(`DROP DATABASE ${name} WITH (FORCE)`); }
  finally { await admin?.end(); }
});

async function register(name: string = published.name, digest: string = published.sha256, adopted = false) {
  await queryWriter("INSERT INTO public.schema_migrations(version,name,checksum,adopted) VALUES($1,$2,$3,$4)",
    [published.version,name,digest,adopted]);
}
async function install() { await queryWriter(exactSql); await register(); }
async function snapshot(action = () => inspectHistoricalBooking0090(reader)) {
  await reader.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await reader.query("SET LOCAL search_path = pg_catalog; SET LOCAL row_security = off; SET LOCAL statement_timeout = '5s'; SET LOCAL lock_timeout = '1s'");
    return await action();
  } finally { await reader.query("ROLLBACK"); }
}

describe("historical 0090 catalog-only recognizer (owned PostgreSQL)", () => {
  it("does not treat absence as an activation instruction", async () => {
    expect(await snapshot()).toEqual({ status: "absent" });
    expect((await queryWriter("SELECT count(*)::int AS n FROM public.schema_migrations")).rows[0].n).toBe(0);
    expect((await queryWriter("SELECT to_regclass('public.booking_requests_request_key_idx') AS idx")).rows[0].idx).toBeNull();
  });
  it("verifies exact published bytes and physical index without reading bookings or other registry rows", async () => {
    expect(createHash("sha256").update(exactSql).digest("hex")).toBe(published.sha256);
    await install();
    await queryWriter("INSERT INTO public.booking_requests(id,request_key,request_hash,preferences) VALUES(1,'synthetic-key','synthetic-hash','{\"fixture\":true}')");
    const observed: string[] = [];
    const result = await snapshot(() => inspectHistoricalBooking0090({
      query: (sql, params) => { observed.push(sql); return reader.query(sql, params); },
    }));
    expect(result).toEqual({ status: "verified" });
    expect(observed.every(sql => /^SELECT/i.test(sql.trim()))).toBe(true);
    expect(observed.some(sql => /FROM\s+(?:ONLY\s+)?public\.booking_requests\b/i.test(sql))).toBe(false);
    expect((await queryWriter("SELECT request_hash FROM public.booking_requests")).rows).toEqual([{request_hash:"synthetic-hash"}]);
  });
  it.each([
    ["wrong_name", published.sha256, false],
    [published.name, "1".repeat(64), false],
    [published.name, published.sha256, true],
  ] as const)("rejects different registry lineage", async (name, checksum, adopted) => {
    await queryWriter(exactSql); await register(name,checksum,adopted);
    expect(await snapshot()).toEqual({ status: "hold", reason: "registry-mismatch" });
  });
  it("rejects a duplicate 0090 row", async () => {
    await install();
    await queryWriter("ALTER TABLE public.schema_migrations DROP CONSTRAINT schema_migrations_pkey");
    await register();
    expect(await snapshot()).toEqual({ status: "hold", reason: "registry-mismatch" });
  });
  it("rejects a row without footprint and footprint without a row", async () => {
    await register();
    expect(await snapshot()).toEqual({ status: "hold", reason: "footprint-mismatch" });
    await queryWriter("DELETE FROM public.schema_migrations");
    await queryWriter(exactSql);
    expect(await snapshot()).toEqual({ status: "hold", reason: "footprint-mismatch" });
  });
  it.each([
    "ALTER TABLE public.booking_requests ALTER COLUMN request_hash SET NOT NULL",
    "ALTER TABLE public.booking_requests ALTER COLUMN preferences SET DEFAULT '{\"other\":true}'::jsonb",
    "DROP INDEX public.booking_requests_request_key_idx; CREATE INDEX booking_requests_request_key_idx ON public.booking_requests(request_key)",
    "DROP INDEX public.booking_requests_request_key_idx; CREATE UNIQUE INDEX booking_requests_request_key_idx ON public.booking_requests(request_key) WHERE request_key <> ''",
    "DROP INDEX public.booking_requests_request_key_idx; CREATE UNIQUE INDEX booking_requests_request_key_idx ON public.booking_requests(request_key DESC) WHERE request_key IS NOT NULL",
    "DROP INDEX public.booking_requests_request_key_idx; CREATE VIEW public.booking_requests_request_key_idx AS SELECT 1 AS synthetic",
  ])("rejects lookalike or incomplete catalog: %s", async sql => {
    await install(); await queryWriter(sql);
    expect(await snapshot()).toEqual({ status: "hold", reason: "footprint-mismatch" });
  });
  it("does not trust a missing or RLS-filterable registry", async () => {
    await queryWriter("ALTER TABLE public.schema_migrations ENABLE ROW LEVEL SECURITY");
    expect(await snapshot()).toEqual({ status: "hold", reason: "catalog-unavailable" });
    await queryWriter("DROP TABLE public.schema_migrations");
    expect(await snapshot()).toEqual({ status: "hold", reason: "catalog-unavailable" });
  });
  it("requires the caller's enforced read-only repeatable-read transaction", async () => {
    expect(await inspectHistoricalBooking0090(reader)).toEqual({ status: "hold", reason: "snapshot-required" });
    await reader.query("BEGIN READ ONLY");
    try {
      await reader.query("SET LOCAL search_path = pg_catalog; SET LOCAL row_security = off");
      expect(await inspectHistoricalBooking0090(reader)).toEqual({ status: "hold", reason: "snapshot-required" });
    } finally { await reader.query("ROLLBACK"); }
  });
  it("holds one snapshot across concurrent registry changes", async () => {
    await install();
    let changed = false;
    const before = await snapshot(() => inspectHistoricalBooking0090({
      query: async (sql, params) => {
        const result = await reader.query(sql, params);
        // Catalog snapshot has already been taken on the reader. Concurrent DML
        // does not get to change the registry view halfway through inspection.
        if (!changed && sql.includes("AS read_only")) {
          changed = true;
          await queryWriter("UPDATE public.schema_migrations SET adopted=true");
        }
        return result;
      },
    }));
    expect(changed).toBe(true);
    expect(before).toEqual({ status: "verified" });
    expect(await snapshot()).toEqual({ status: "hold", reason: "registry-mismatch" });
  });
});
