import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { validatePostgresTestTarget } from "./_safe-target";

const base = validatePostgresTestTarget(process.env).testUrl.toString();
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalTestDatabaseUrl = process.env.TEST_DATABASE_URL;
const name = `aqlan_number_compat_${randomUUID().replaceAll("-", "")}`;
let created = false;
let db: typeof import("../../lib/db");
async function query(url: string, sql: string) {
  const client = new Client({ connectionString: url, ssl: false });
  await client.connect();
  try { return (await client.query(sql)).rows; }
  finally { await client.end(); }
}
const patient = (fullName: string) => ({
  fullName, phone: null, altPhone: null, gender: "unknown" as const, birthYear: null,
  address: null, medicalAlert: null, note: null,
});
beforeAll(async () => {
  if (!/^aqlan_number_compat_[a-f0-9]{32}$/.test(name)) throw new Error("Invalid synthetic database");
  await query(base, `CREATE DATABASE "${name}"`);
  created = true;
  const target = new URL(base);
  target.pathname = `/${name}`;
  const url = target.toString();
  await query(url, "CREATE SEQUENCE patient_number_seq");
  await query(url, "SELECT setval('patient_number_seq',7000,false)");
  process.env.DATABASE_URL = url;
  process.env.TEST_DATABASE_URL = url;
  db = await import("../../lib/db");
  await db.resetPoolForTesting();
  const identity = (await db.getPool().query("SELECT current_database() AS name")).rows[0];
  if (identity.name !== name) throw new Error("Synthetic database identity mismatch");
  await db.ensureSchema();
});
afterAll(async () => {
  try {
    await db?.resetPoolForTesting();
    if (created && /^aqlan_number_compat_[a-f0-9]{32}$/.test(name)) {
      await query(base, `DROP DATABASE "${name}" WITH (FORCE)`);
    }
  } finally {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalTestDatabaseUrl === undefined) delete process.env.TEST_DATABASE_URL;
    else process.env.TEST_DATABASE_URL = originalTestDatabaseUrl;
  }
});
it("preserves Stage's pending P-07000 through active 0080 and restart, then does not reuse it", async () => {
  const q = (sql: string) => db.getPool().query(sql);
  expect((await q("SELECT name,adopted FROM schema_migrations WHERE version='0080'")).rows)
    .toEqual([{ name: "patient_numbering", adopted: false }]);
  await q("INSERT INTO patients(patient_number,full_name) VALUES('P-00042','Synthetic prior file')");
  db.schemaReadyReset();
  await db.ensureSchema();
  expect((await q("SELECT last_value::text,is_called FROM patient_number_seq")).rows)
    .toEqual([{ last_value: "7000", is_called: false }]);
  expect((await db.createPatient(patient("Synthetic first new file"))).patientNumber).toBe("P-07000");
  db.schemaReadyReset();
  await db.ensureSchema();
  expect((await db.createPatient(patient("Synthetic second new file"))).patientNumber).toBe("P-07001");
  expect((await q("SELECT patient_number FROM patients WHERE full_name='Synthetic prior file'")).rows)
    .toEqual([{ patient_number: "P-00042" }]);
});
