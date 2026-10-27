import { afterAll, beforeAll, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { assertRealPostgresUrl } from "./_setup";
import { staffIdentitySubstrateSql } from "../../lib/staff-identity-substrate-schema.mjs";
import { initializeStaffIdentitySubstrate } from "../../lib/staff-identity-substrate.mjs";
import { inspectStaffIdentitySubstrate } from "../../lib/staff-identity-substrate-probe.mjs";
import { inspectStaffRuntimeSchema } from "../../lib/staff-runtime-probe.mjs";
import { staffRuntimeSchemaSql } from "../../lib/staff-runtime-schema.mjs";
assertRealPostgresUrl();
const schema=`aqlan_identity_${randomBytes(8).toString("hex")}`;
const client=new Client({connectionString:process.env.TEST_DATABASE_URL,ssl:false});
beforeAll(async()=>{
 await client.connect();await client.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema},pg_catalog`);
 await client.query(`CREATE TABLE ${schema}.parties(id INTEGER PRIMARY KEY,kind TEXT,name TEXT,is_active BOOLEAN); CREATE TABLE ${schema}.users(id INTEGER PRIMARY KEY,username TEXT,display_name TEXT,password_hash TEXT,role TEXT,is_active BOOLEAN,party_id INTEGER,permissions JSONB)`);
 await client.query(readFileSync(new URL("../fixtures/staff-identity/frozen-0076.sql",import.meta.url),"utf8"));
 await client.query(staffIdentitySubstrateSql(schema));
 await client.query("BEGIN");await initializeStaffIdentitySubstrate(client,schema);await client.query("COMMIT");
 await client.query(staffRuntimeSchemaSql(schema));
});
afterAll(async()=>{await client.query(`DROP SCHEMA ${schema} CASCADE`);await client.end();});
it("v2 proposal installation retains quarantine and is not accepted by v1",async()=>{
 const row=(await client.query(`SELECT status,registry_revision::text,ready_owner_subject_id,ready_control_epoch FROM ${schema}.staff_identity_state`)).rows[0];
 expect(row).toEqual({status:"quarantined",registry_revision:"1",ready_owner_subject_id:null,ready_control_epoch:null});
 await expect(inspectStaffIdentitySubstrate(client,schema)).rejects.toThrow("STAFF_IDENTITY_SCHEMA_DRIFT");
 await expect(client.query(`UPDATE ${schema}.staff_identity_state SET status='ready'`)).rejects.toThrow();
 expect((await inspectStaffRuntimeSchema(client,schema)).version).toBe(2);
});
