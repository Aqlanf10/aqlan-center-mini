import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initializeGeneratedRuntimeSchema, validateOwnershipHarnessEnvironment } from "../../scripts/verify-schema-ownership";

let client: Client | undefined;
let database: string;
let created = false;
let target: ReturnType<typeof validateOwnershipHarnessEnvironment>;
let patientId: number;
let services: number[];

beforeEach(async () => {
  created = false;
  client = undefined;
  target = validateOwnershipHarnessEnvironment();
  if ([...target.testUrl.searchParams.keys()].some((key) => key !== "sslmode")) throw new Error("Unexpected test connection override.");
  database = `aqlan_schema_ownership_waiting_${randomUUID().replace(/-/g, "")}`;
  const admin = new Client({ connectionString: target.maintenanceUrl.toString(), ssl: false });
  await admin.connect();
  try { await admin.query(`CREATE DATABASE ${database}`); created = true; }
  finally { await admin.end(); }
  await initializeGeneratedRuntimeSchema(target, database);
  const url = new URL(target.testUrl); url.pathname = `/${database}`;
  client = new Client({ connectionString: url.toString(), ssl: false });
  await client.connect();
  const patient = await client!.query("INSERT INTO patients(patient_number,full_name) VALUES ('SYNPGWR','Synthetic restart') RETURNING id");
  patientId = patient.rows[0].id;
  const rows = await client!.query("INSERT INTO appointment_services(code,name_ar) VALUES ('syn-pg-wr-a','Synthetic A'),('syn-pg-wr-b','Synthetic B') RETURNING id");
  services = rows.rows.map((row) => row.id);
});

afterEach(async () => {
  await client?.end();
  if (!created) return;
  const admin = new Client({ connectionString: target.maintenanceUrl.toString(), ssl: false });
  await admin.connect();
  try { await admin.query(`DROP DATABASE ${database} WITH (FORCE)`); }
  finally { await admin.end(); }
});

async function indexes() {
  return (await client!.query("SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='waiting_list' AND indexname LIKE 'waiting_list_one_open%' ORDER BY indexname")).rows.map((row) => row.indexname);
}

describe("populated waiting-list cold start on PostgreSQL 18", () => {
  it("keeps different-service and generic open rows unchanged across two cold starts", async () => {
    await client!.query("INSERT INTO waiting_list(patient_id,service_id,status,note) VALUES ($1,$2,'waiting','Synthetic A'),($1,$3,'offered','Synthetic B'),($1,NULL,'waiting','Synthetic generic')", [patientId, ...services]);
    const before = (await client!.query("SELECT * FROM waiting_list ORDER BY id")).rows;
    for (let restart = 0; restart < 2; restart++) {
      await initializeGeneratedRuntimeSchema(target, database);
      expect((await client!.query("SELECT * FROM waiting_list ORDER BY id")).rows).toEqual(before);
      expect(await indexes()).toEqual(["waiting_list_one_open_generic_idx", "waiting_list_one_open_per_patient_service_idx"]);
    }
  });

  it("retains per-service and generic uniqueness, with a new entry allowed after resolution", async () => {
    await initializeGeneratedRuntimeSchema(target, database);
    await client!.query("INSERT INTO waiting_list(patient_id,service_id) VALUES ($1,$2),($1,NULL)", [patientId, services[0]]);
    await expect(client!.query("INSERT INTO waiting_list(patient_id,service_id,status) VALUES ($1,$2,'offered')", [patientId, services[0]]))
      .rejects.toMatchObject({ code: "23505", constraint: "waiting_list_one_open_per_patient_service_idx" });
    await expect(client!.query("INSERT INTO waiting_list(patient_id,service_id,status) VALUES ($1,NULL,'offered')", [patientId]))
      .rejects.toMatchObject({ code: "23505", constraint: "waiting_list_one_open_generic_idx" });
    await client!.query("UPDATE waiting_list SET status='expired' WHERE patient_id=$1 AND service_id=$2", [patientId, services[0]]);
    await client!.query("INSERT INTO waiting_list(patient_id,service_id) VALUES ($1,$2),($1,$3)", [patientId, ...services]);
    expect((await client!.query("SELECT COUNT(*)::int AS n FROM waiting_list")).rows[0].n).toBe(4);
    await initializeGeneratedRuntimeSchema(target, database);
    expect((await client!.query("SELECT COUNT(*)::int AS n FROM waiting_list")).rows[0].n).toBe(4);
  });

  it("still removes an existing obsolete patient-only index without changing rows", async () => {
    await client!.query("INSERT INTO waiting_list(patient_id,service_id) VALUES ($1,$2)", [patientId, services[0]]);
    await client!.query("DROP INDEX waiting_list_one_open_per_patient_service_idx");
    await client!.query("DROP INDEX waiting_list_one_open_generic_idx");
    await client!.query("CREATE UNIQUE INDEX waiting_list_one_open_per_patient_idx ON waiting_list(patient_id) WHERE status IN ('waiting','offered')");
    expect(await indexes()).toEqual(["waiting_list_one_open_per_patient_idx"]);
    const before = (await client!.query("SELECT * FROM waiting_list ORDER BY id")).rows;
    await initializeGeneratedRuntimeSchema(target, database);
    expect(await indexes()).toEqual(["waiting_list_one_open_generic_idx", "waiting_list_one_open_per_patient_service_idx"]);
    expect((await client!.query("SELECT * FROM waiting_list ORDER BY id")).rows).toEqual(before);
    await client!.query("INSERT INTO waiting_list(patient_id,service_id) VALUES ($1,$2)", [patientId, services[1]]);
  });
});
