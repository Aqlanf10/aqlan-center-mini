import { createHash } from "node:crypto";
import { staffIdentitySchemaName } from "./staff-identity-substrate-schema.mjs";
import { readStaffIdentitySubstrateCatalogue } from "./staff-identity-substrate-probe.mjs";
import { EXPECTED_RUNTIME_CATALOGUE } from "./staff-runtime-catalogue.mjs";
/** Exact v2 schema diagnostic, not ready-state or operator authorization. */
export async function inspectStaffRuntimeSchema(source,schema="public") {
 const s=staffIdentitySchemaName(schema);
 const {rows}=await source.query(`SELECT c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname=$1 AND c.relname=ANY(ARRAY['staff_authority_identity','staff_execution_epochs'])
 UNION ALL SELECT a.attname FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
 JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='users' AND a.attname='staff_subject_id' AND NOT a.attisdropped`,[s]);
 if(rows.length)throw new Error("STAFF_RUNTIME_PARALLEL_SCHEMA_REFUSED");
 const actual=await readStaffIdentitySubstrateCatalogue(source,s);
 if(JSON.stringify(actual)!==JSON.stringify(EXPECTED_RUNTIME_CATALOGUE))throw new Error("STAFF_RUNTIME_SCHEMA_DRIFT");
 return Object.freeze({version:2,schema:s,fingerprint:createHash("sha256").update(JSON.stringify(actual)).digest("hex")});
}
