import "server-only";
import type { DbClient, DbPool } from "./db";
import { withIsolation } from "./transactions";
import { staffIdentitySchemaName } from "./staff-identity-substrate-schema.mjs";
import { revalidateVerifiedDurableSession, type VerifiedDurableSession } from "./staff-durable-session";
import { hasStaffCapability } from "./staff-capabilities";
import { loadLockedStaffAuthority } from "./staff-authority-proof-internal";

export type StaffRuntimeAction = "staff.view" | "staff.permissions.edit" | "inventory.references.view" | "inventory.items.create" | "inventory.units.revise" | "inventory.locations.create";
const actions = new Set<string>(["staff.view","staff.permissions.edit","inventory.references.view","inventory.items.create","inventory.units.revise","inventory.locations.create"]);
declare const operationBrand: unique symbol;
export interface StaffOperationHandle { readonly [operationBrand]: true }
interface OperationState {
 client: DbClient; xid: string; action: StaffRuntimeAction; session: VerifiedDurableSession;
 schema: string; fingerprint: string;
}
const operations = new WeakMap<StaffOperationHandle, OperationState>();
function refuse(reason: string): never { throw new Error(`STAFF_OPERATION_${reason}`); }
async function xid(client: DbClient): Promise<string> {
 await client.query("SAVEPOINT staff_runtime_transaction_check");
 await client.query("RELEASE SAVEPOINT staff_runtime_transaction_check");
 const {rows} = await client.query<{xid:string;isolation:string}>("SELECT pg_current_xact_id()::text AS xid,current_setting('transaction_isolation') AS isolation");
 if(rows.length!==1 || rows[0].isolation!=="read committed")refuse("TRANSACTION_REQUIRED");
 return rows[0].xid;
}
async function load(client: DbClient, session: VerifiedDurableSession, action: StaffRuntimeAction, schema:string) {
 const claims=revalidateVerifiedDurableSession(session);
 if(!claims || !actions.has(action))refuse("SESSION_OR_ACTION_INVALID");
 const s=staffIdentitySchemaName(schema),transactionId=await xid(client);
 // Shared runtime fence, same key as exclusive phase1 lifecycle operations.
 // Fixed order; no inventory/domain fence may precede this.
 await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))",[`aqlan.canonical.identity.substrate.v1:${s}`]);
 const proof=await loadLockedStaffAuthority(client,session,action,s);
 if(await xid(client)!==transactionId)refuse("TRANSACTION_CHANGED");
 return {xid:transactionId,...proof};
}
/** Protected SQL callers must assert inside the callback, not accept projections.
 * Reacquires all fences and fresh proof; XID is not a subtransaction identifier. */
async function assertAndLoadStaffOperation(client:DbClient,handle:StaffOperationHandle,action:StaffRuntimeAction,schema?:string){
 const state=operations.get(handle);
 if(!state || state.client!==client || state.action!==action)refuse("HANDLE_INVALID");
 if(schema!==undefined && staffIdentitySchemaName(schema)!==state.schema)refuse("HANDLE_SCHEMA_MISMATCH");
 if(await xid(client)!==state.xid)refuse("TRANSACTION_CHANGED");
 const current=await load(client,state.session,action,state.schema);
 if(current.xid!==state.xid || current.fingerprint!==state.fingerprint)refuse("AUTHORITY_CHANGED");
 return current;
}
/** Fresh proof through the private handle, client, XID and exact action. This frozen
 * display/provenance projection is never accepted as authority by this runtime. */
export async function staffOperationIdentity(client:DbClient,handle:StaffOperationHandle,action:StaffRuntimeAction,schema?:string):Promise<Readonly<{realmId:string;subjectId:string;generationId:string;userId:number;username:string;role:string}>> {
 return (await assertAndLoadStaffOperation(client,handle,action,schema)).identity;
}
export async function assertStaffOperation(client:DbClient,handle:StaffOperationHandle,action:StaffRuntimeAction,schema?:string):Promise<void>{
 await assertAndLoadStaffOperation(client,handle,action,schema);
}
/** Bounded display preview, never operation admission. An exact reference-read
 * handle is freshly asserted (including schema) before exposing only implemented reference actions.
 * Each mutation still requires its own separate exact action handle. */
export async function staffOperationReferenceCapabilities(client:DbClient,handle:StaffOperationHandle,schema:string):Promise<readonly ("inventory.items.create" | "inventory.units.revise" | "inventory.locations.create")[]>{
 const exactSchema=staffIdentitySchemaName(schema);
 const current=await assertAndLoadStaffOperation(client,handle,"inventory.references.view",exactSchema);
 return Object.freeze((["inventory.items.create","inventory.units.revise","inventory.locations.create"] as const).filter(action=>hasStaffCapability(current.access,action)));
}
/** Owns transaction/commit. Trusted callback MUST NOT issue top-level transaction
 * control. Changed/ended XID refuses, but a malicious early COMMIT cannot be undone.
 * Savepoints are created only after admission fences. No handle survives callback. */
export async function withStaffOperation<T>(pool:DbPool,session:VerifiedDurableSession,action:StaffRuntimeAction,work:(client:DbClient,handle:StaffOperationHandle)=>Promise<T>,schema="public"):Promise<T>{
 return withIsolation(pool,"READ COMMITTED",async client=>{
  const proof=await load(client,session,action,schema);
  const handle=Object.freeze({}) as StaffOperationHandle;
  operations.set(handle,{client,xid:proof.xid,action,session,schema,fingerprint:proof.fingerprint});
  try{
   const result=await work(client,handle);
   await assertStaffOperation(client,handle,action);
   return result;
  }finally{operations.delete(handle);}
 });
}
