import { inspectStaffPermissionEnvelope } from "../../lib/staff-permission-envelope-core.mjs";
import { readLegacyStaffSchema, staffLifecycleLockKey } from "../../lib/legacy-staff-schema.mjs";
import { staffIdentitySchemaName } from "../../lib/staff-identity-substrate-schema.mjs";

/** Dedicated connection only. Never a canonical credential operation. Caller owns
 * connection cleanup; no environment/connection acquisition or secret logging. */
export async function resetLegacyPassword(client, { username, password, hashPassword, verifyPassword }, schema="public") {
  const s=staffIdentitySchemaName(schema);
  let begun=false;
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED"); begun=true;
    await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))",[staffLifecycleLockKey(s)]);
    if(await readLegacyStaffSchema(client,s)!=="base")throw new Error("LEGACY_STAFF_BASE_SCHEMA_UNREADABLE");
    const {rows}=await client.query(`SELECT id,permissions FROM ${s}.users WHERE username=$1 FOR UPDATE`,[username]);
    if(rows.length!==1)throw new Error("LEGACY_PASSWORD_TARGET_MISSING");
    if(inspectStaffPermissionEnvelope(rows[0].permissions).kind!=="legacy")throw new Error("LEGACY_STAFF_PERMISSION_ENVELOPE_HELD");
    const hash=await hashPassword(password);
    const updated=await client.query(`UPDATE ${s}.users SET password_hash=$1 WHERE id=$2 RETURNING id`,[hash,rows[0].id]);
    if(updated.rows.length!==1)throw new Error("LEGACY_PASSWORD_UPDATE_FAILED");
    const stored=await client.query(`SELECT password_hash FROM ${s}.users WHERE id=$1`,[rows[0].id]);
    if(stored.rows.length!==1 || !await verifyPassword(password,stored.rows[0].password_hash))throw new Error("LEGACY_PASSWORD_VERIFICATION_FAILED");
    await client.query("COMMIT"); begun=false;
  } catch(error) {
    if(begun)await client.query("ROLLBACK").catch(()=>{});
    throw error;
  }
}
