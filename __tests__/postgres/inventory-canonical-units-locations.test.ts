/** Synthetic trusted-ready runtime evidence ONLY. This setup proves no operator,
 * owner bootstrap, source recovery or real account activation authority. */
import { afterAll, beforeAll, expect, it, vi, describe } from "vitest";
import { randomBytes, randomUUID, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { assertRealPostgresUrl } from "./_setup";
import { staffIdentitySubstrateSql } from "../../lib/staff-identity-substrate-schema.mjs";
import { initializeStaffIdentitySubstrate, bindStaffAccountIncarnation } from "../../lib/staff-identity-substrate.mjs";
import { staffRuntimeSchemaSql } from "../../lib/staff-runtime-schema.mjs";
import { sessionCredentialVersion } from "../../lib/auth";
import { readVerifiedDurableSession } from "../../lib/staff-durable-session";
import { withStaffOperation, staffOperationIdentity, staffOperationReferenceCapabilities, type StaffOperationHandle } from "../../lib/staff-operation-runtime";
import { commandCanonicalInventoryUnitRevise, commandCanonicalInventoryLocationCreate, readCanonicalInventoryReferences } from "../../lib/inventory-domain/reference-setup";
import { PURCHASE_RESET_FENCE } from "../../lib/clinic-reset";
import { STAFF_AUTHORIZATION_POLICY_VERSION } from "../../lib/staff-capability-catalogue";
import { INVENTORY_PROCUREMENT_SQL } from "../../lib/inventory-domain/schema-proposal";
import { INVENTORY_COMMAND_LIFECYCLE_SQL } from "../../lib/inventory-domain/command-lifecycle-schema-proposal";
import { runCanonicalInventoryUnitReviseLifecycle, runCanonicalInventoryLocationCreateLifecycle } from "../../lib/inventory-domain/command-lifecycle";
import { REFERENCE_PROTOCOL, type ReferenceIntent, type ReferenceInput } from "../../lib/inventory-reference-protocol";
import type { DbPool } from "../../lib/db";
assertRealPostgresUrl();
const schema = `aqlan_identity_${randomBytes(8).toString("hex")}`;
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, ssl: false, max: 10, options: `-c search_path=${schema},pg_catalog` });
const doc = (grants: Record<string, boolean>) => ({ schemaVersion: 2, confirmation: "owner", revision: 1, patientScope: "none", appointmentScope: "none", grants });
function sign(payload: unknown) { const body = Buffer.from(JSON.stringify(payload)).toString("base64url"); return `${body}.${createHmac("sha256", process.env.SESSION_SECRET!).update(body).digest("base64url")}`; }
async function claims(userId = 2) {
    const { rows: [r] } = await pool.query(`SELECT u.id,u.username,u.password_hash,u.authorization_epoch::text,u.permissions,u.party_id,p.clinical_authority_epoch::text,
 h.realm_id::text,h.generation_id::text,h.registry_revision::text,c.binding_epoch::text,b.subject_id::text
 FROM ${schema}.users u CROSS JOIN ${schema}.staff_identity_state h CROSS JOIN ${schema}.staff_authority_control c
 JOIN ${schema}.staff_identity_current b ON b.user_id=$1 LEFT JOIN ${schema}.parties p ON p.id=u.party_id WHERE u.id=$1`, [userId]);
    return { userId: r.id, username: r.username, expiresAt: Date.now() + 60000, durableIdentity: { schemaVersion: 2, policyVersion: STAFF_AUTHORIZATION_POLICY_VERSION, realmId: r.realm_id, subjectId: r.subject_id, generationId: r.generation_id, registryRevision: r.registry_revision, controlEpoch: r.binding_epoch, accountEpoch: r.authorization_epoch, permissionRevision: r.permissions.revision, credentialVersion: sessionCredentialVersion(r.password_hash), provider: r.party_id === null ? null : { partyId: r.party_id, clinicalEpoch: r.clinical_authority_epoch } } };
}
async function session(userId = 2) {
    const handle = readVerifiedDurableSession(sign(await claims(userId)));
    if (!handle)
        throw new Error("synthetic token fixture invalid");
    return handle;
}
async function waitForBlockedBy(holderPid: number) {
    const deadline = performance.now() + 3000;
    while (performance.now() < deadline) {
        const { rows } = await pool.query<{
            pid: number;
        }>("SELECT pid FROM pg_stat_activity WHERE $1::integer=ANY(pg_blocking_pids(pid))", [holderPid]);
        if (rows.length)
            return rows.map(r => r.pid);
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("real PostgreSQL blocking barrier was not observed");
}
const both = { "inventory.references.view": true, "inventory.units.revise": true, "inventory.locations.create": true };
beforeAll(async () => {
    vi.stubEnv("INVENTORY_INTEGRATION_ENABLED", "true");
    const c = await pool.connect();
    try {
        await c.query(`CREATE SCHEMA ${schema};SET search_path TO ${schema},pg_catalog`);
        await c.query(`CREATE TABLE ${schema}.parties(id SERIAL PRIMARY KEY,kind TEXT,name TEXT,is_active BOOLEAN);
   CREATE TABLE ${schema}.users(id SERIAL PRIMARY KEY,username TEXT,display_name TEXT,password_hash TEXT,role TEXT,is_active BOOLEAN,party_id INTEGER,permissions JSONB);
   CREATE TABLE ${schema}.inventory_items(id SERIAL PRIMARY KEY,name TEXT NOT NULL,category TEXT,unit TEXT,min_level NUMERIC,note TEXT,created_by TEXT,is_active BOOLEAN NOT NULL DEFAULT TRUE);
   CREATE TABLE ${schema}.inventory_movements(id INTEGER PRIMARY KEY, quantity NUMERIC, details JSONB);
   CREATE TABLE ${schema}.clinical_facts(id INTEGER PRIMARY KEY, details JSONB);
   CREATE TABLE ${schema}.payables(id INTEGER PRIMARY KEY, amount NUMERIC, details JSONB);
   CREATE TABLE ${schema}.audit_log(id BIGSERIAL PRIMARY KEY,action TEXT,entity TEXT,entity_id TEXT,summary TEXT,details JSONB,actor TEXT,actor_role TEXT,source_ip TEXT,user_agent TEXT,created_at TIMESTAMPTZ DEFAULT now());`);
        await c.query(readFileSync(new URL("../fixtures/staff-identity/frozen-0076.sql", import.meta.url), "utf8"));
        await c.query(staffIdentitySubstrateSql(schema));
        await c.query(`INSERT INTO ${schema}.parties(id,kind,is_active) VALUES(20,'doctor',TRUE),(21,'doctor',TRUE),(22,'doctor',FALSE),(23,'supplier',TRUE)`);
        for (const [id, role, party, grants] of [[1, "admin", null, {}], [2, "doctor", 20, both], [3, "admin", null, {}], [4, "doctor", 20, { "inventory.references.view": true }], [5, "doctor", 20, { "inventory.units.revise": true, "inventory.locations.create": true }], [6, "doctor", 20, { "inventory.references.view": true, "inventory.items.create": true }], [7, "doctor", 20, { "inventory.references.view": true, "inventory.units.revise": true }], [8, "doctor", 20, { "inventory.references.view": true, "inventory.locations.create": true }]] as const)
            await c.query(`INSERT INTO ${schema}.users(id,username,role,is_active,password_hash,party_id,permissions) VALUES($1,$2,$3,TRUE,'synthetic-hash',$4,$5)`, [id, `synthetic-${id}`, role, party, JSON.stringify(doc(grants))]);
        await c.query("BEGIN");
        let h = await initializeStaffIdentitySubstrate(c, schema);
        for (const userId of [1, 2, 3, 4, 5, 6, 7, 8])
            h = await bindStaffAccountIncarnation(c, { userId, currentSubjectId: null, expected: { generationId: h.generationId, registryRevision: h.registryRevision } }, schema);
        await c.query("COMMIT");
        await c.query(staffRuntimeSchemaSql(schema));
        // Hypothetical trusted-ready fixture, NOT a provisioning/bootstrap API.
        await c.query("BEGIN");
        await c.query(`UPDATE ${schema}.users SET authorization_mode='canonical'`);
        await c.query(`UPDATE ${schema}.staff_authority_control SET state='prepared',pending_owner_user_id=1,conversion_digest=repeat('a',64),recovery_reference='synthetic-item-evidence-not-bootstrap' WHERE singleton`);
        await c.query(`UPDATE ${schema}.staff_authority_control SET state='active',owner_user_id=1,pending_owner_user_id=NULL WHERE singleton`);
        await c.query("COMMIT");
        await c.query(`UPDATE ${schema}.staff_identity_state SET status='ready',ready_owner_subject_id=(SELECT subject_id FROM ${schema}.staff_identity_current WHERE user_id=1),ready_control_epoch=(SELECT binding_epoch FROM ${schema}.staff_authority_control) WHERE singleton`);
        // Install complete reviewed proposals, including append-only and terminal guards.
        await c.query(INVENTORY_PROCUREMENT_SQL);
        await c.query(INVENTORY_COMMAND_LIFECYCLE_SQL);
        await c.query(`INSERT INTO ${schema}.inventory_movements VALUES(1,17.5,'{"historical":true}');
          INSERT INTO ${schema}.payables VALUES(1,918.25,'{"supplier":23}');
          INSERT INTO ${schema}.clinical_facts VALUES(1,'{"patient":42,"commission":11,"custody":21}');`);
    }
    finally {
        c.release();
    }
});
afterAll(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await pool.query(`DROP SCHEMA ${schema} CASCADE`); await pool.end(); });
type Action = "unit.revise" | "location.create";
type Mode = "admit" | "execute" | "lookup" | "retire";
const actions: Action[] = ["unit.revise", "location.create"];
const modes: Mode[] = ["admit", "execute", "lookup", "retire"];
const capability = (a: Action) => a === "unit.revise" ? "inventory.units.revise" as const : "inventory.locations.create" as const;
const facade = (a: Action) => a === "unit.revise" ? commandCanonicalInventoryUnitRevise : commandCanonicalInventoryLocationCreate;
const lower = (a: Action) => a === "unit.revise" ? runCanonicalInventoryUnitReviseLifecycle : runCanonicalInventoryLocationCreateLifecycle;
async function intent(action: Action, id = 2): Promise<ReferenceIntent> {
    const p = await claims(id);
    let input: ReferenceInput;
    if (action === "unit.revise") {
        const item = (await pool.query(`INSERT INTO ${schema}.inventory_items(name,unit,min_level,note) VALUES($1,'piece',2,'immutable seed') RETURNING id`, [`Synthetic ${randomUUID()}`])).rows[0];
        await pool.query(`INSERT INTO ${schema}.inventory_item_unit_versions VALUES($1,1,'piece','piece',1,0,0)`, [item.id]);
        input = { action, itemId: item.id, expectedVersion: 1, enteredUnit: "box", factor: "12", enteredPrecision: 0, basePrecision: 0, reason: "Synthetic conversion revision" };
    } else input = { action, id: `synthetic-${randomUUID()}`, label: "Synthetic store", kind: "store", doctorPartyId: null, reason: "Synthetic location creation" };
    return { protocol: REFERENCE_PROTOCOL, nonce: randomUUID(), authority: { realmId: p.durableIdentity.realmId, subjectId: p.durableIdentity.subjectId, generation: p.durableIdentity.generationId }, input };
}
const command = async (i: ReferenceIntent, mode: Mode, id = 2, db: DbPool = pool) => facade(i.input.action as Action)(db, await session(id), i, mode, mode === "retire" ? "Synthetic withdrawal" : undefined, schema);
async function snapshot() {
    const tables = (await pool.query<{tablename:string}>("SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename", [schema])).rows;
    const result: Record<string, unknown> = {};
    for (const {tablename} of tables) result[tablename] = (await pool.query(`SELECT to_jsonb(t) AS row FROM ${schema}."${tablename}" t ORDER BY to_jsonb(t)::text`)).rows;
    return result; // Sequences are deliberately excluded: gaps are not transactional.
}
function unchangedExcept(before: Record<string, unknown>, after: Record<string, unknown>, exceptions: string[]) {
    for (const name of Object.keys(before)) if (!exceptions.includes(name)) expect(after[name], name).toEqual(before[name]);
}
function observedPool(after: (sql: string, values: unknown[] | undefined) => Promise<void> | void): DbPool {
    return { query: pool.query.bind(pool) as DbPool["query"], connect: async () => {
        const c = await pool.connect();
        return { query: async <T>(sql: string, values?: unknown[]) => { const result = await c.query(sql, values); await after(sql, values); return result as {rows:T[];rowCount:number|null}; }, release: () => c.release() };
    } };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return {promise, resolve}; }
for (const action of actions) describe(action, () => {
    it.each([1,2,action === "unit.revise" ? 7 : 8])("owner or exact delegate %s commits only reference rows with replay", async id => {
        const original = await intent(action,id), before = await snapshot();
        await expect(command(original,"execute",id)).rejects.toMatchObject({code:"command_provenance_required"});
        expect(await snapshot()).toEqual(before);
        const admitted = await command(original,"admit",id), admission = await snapshot();
        expect(await command(original,"admit",id)).toEqual(admitted);
        expect((await command(original,"lookup",id)).status).toBe("pending");
        expect(await snapshot()).toEqual(admission);
        const committed = await command(original,"execute",id);
        expect(committed.status).toBe("committed");
        if(committed.status !== "committed") throw Error("Expected committed result");
        expect(committed.result).toMatchObject({action,version:action === "unit.revise" ? 2 : 1});
        const after = await snapshot();
        unchangedExcept(before,after,["inventory_command_bindings","inventory_operations","audit_log",action === "unit.revise" ? "inventory_item_unit_versions" : "inventory_locations"]);
        for (const mode of modes) expect(await command(original,mode,id)).toEqual({...committed,result:{...committed.result,replayed:true}});
        expect(await snapshot()).toEqual(after);
    });
    it.each([3,4,5,6,action === "unit.revise" ? 8 : 7])("admin or adjacent/missing grants %s cannot authorize any mode", async id => {
        const original = await intent(action,id), before = await snapshot();
        for(const mode of modes) await expect(command(original,mode,id)).rejects.toThrow(/STAFF_OPERATION_/);
        expect(await snapshot()).toEqual(before);
    });
    it("same nonce changed payload and changed action conflict without adopting history", async () => {
        const original = await intent(action); await command(original,"admit");
        const adjacent = await intent(action === "unit.revise" ? "location.create" : "unit.revise");
        const before = await snapshot();
        for(const input of [{...original.input,reason:"Changed reason"},adjacent.input]) for(const mode of modes)
            await expect(command({...original,input},mode)).rejects.toMatchObject({code:"idempotency_conflict"});
        expect(await snapshot()).toEqual(before);
    });
    it("retirement tombstone is durable in every mode without domain writes", async () => {
        const original = await intent(action); await command(original,"admit");
        const retired = await command(original,"retire"), before = await snapshot();
        expect(retired.status).toBe("retired");
        for(const mode of modes) expect(await command(original,mode)).toEqual(retired);
        expect(await snapshot()).toEqual(before);
    });
    it.each(["execute","retire"] as const)("same transaction or released savepoint cannot supply committed provenance for %s", async mode => {
        const original = await intent(action), before = await snapshot();
        await expect(withStaffOperation(pool,await session(),capability(action),async(c,h)=>{
            await c.query("SAVEPOINT synthetic_admission");
            await lower(action)(c,h,original,"admit",undefined,schema);
            await c.query("RELEASE SAVEPOINT synthetic_admission");
            await lower(action)(c,h,original,mode,"Synthetic withdrawal",schema);
        },schema)).rejects.toMatchObject({code:"command_admission_uncommitted"});
        expect(await snapshot()).toEqual(before);
    });
    it("wrong realm, subject, generation and changed username cannot adopt old binding", async () => {
        const original = await intent(action); await command(original,"admit");
        const before = await snapshot();
        for(const key of ["realmId","subjectId","generation"] as const) for(const mode of modes)
            await expect(command({...original,authority:{...original.authority,[key]:randomUUID()}},mode)).rejects.toThrow();
        expect(await snapshot()).toEqual(before);
        await pool.query(`UPDATE ${schema}.users SET username='changed-synthetic-2' WHERE id=2`);
        try { const renamed = await snapshot(); for(const mode of modes) await expect(command(original,mode)).rejects.toThrow(); expect(await snapshot()).toEqual(renamed); }
        finally { await pool.query(`UPDATE ${schema}.users SET username='synthetic-2' WHERE id=2`); }
    });
    it("lower facade requires authentic exact action, client, schema and live handle", async () => {
        const original = await intent(action), before = await snapshot();
        for(const kind of ["clone","projection","client","schema"] as const)
            await expect(withStaffOperation(pool,await session(),capability(action),async(c,h)=>{
                if(kind === "client") { const other = await pool.connect(); try {return await lower(action)(other,h,original,"admit",undefined,schema);} finally {other.release();} }
                const supplied = kind === "clone" ? {...h} : kind === "projection" ? await staffOperationIdentity(c,h,capability(action),schema) : h;
                return lower(action)(c,supplied as StaffOperationHandle,original,"admit",undefined,kind === "schema" ? "public" : schema);
            },schema)).rejects.toThrow(/HANDLE/);
        await expect(withStaffOperation(pool,await session(),"inventory.references.view",(c,h)=>lower(action)(c,h,original,"admit",undefined,schema),schema)).rejects.toThrow(/HANDLE/);
        let escaped!: StaffOperationHandle;
        await withStaffOperation(pool,await session(),capability(action),async(_c,h)=>{escaped=h;},schema);
        const c = await pool.connect(); try {await expect(lower(action)(c,escaped,original,"admit",undefined,schema)).rejects.toThrow(/HANDLE/);} finally {c.release();}
        expect(await snapshot()).toEqual(before);
    });
    it.each([action === "unit.revise" ? "inventory_item_unit_versions" : "inventory_locations","audit_log","inventory_operations"])("failure after real %s insert rolls back complete domain/audit/result", async table => {
        const original = await intent(action); await command(original,"admit"); const before = await snapshot();
        await pool.query(`CREATE FUNCTION ${schema}.synthetic_reference_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic reference failure'; END $$; CREATE TRIGGER synthetic_reference_fail AFTER INSERT ON ${schema}.${table} FOR EACH ROW EXECUTE FUNCTION ${schema}.synthetic_reference_fail()`);
        try {await expect(command(original,"execute")).rejects.toThrow("synthetic reference failure");}
        finally {await pool.query(`DROP TRIGGER synthetic_reference_fail ON ${schema}.${table}; DROP FUNCTION ${schema}.synthetic_reference_fail()`);}
        expect(await snapshot()).toEqual(before);
        expect((await command(original,"execute")).status).toBe("committed");
    });
    it("final runtime assertion expiry rolls back successful domain and result inserts", async () => {
        const original = await intent(action); await command(original,"admit"); const before = await snapshot(), p = await claims();
        const verified = readVerifiedDurableSession(sign(p))!; let reached = false;
        const db = observedPool(sql=>{if(sql.startsWith(`INSERT INTO ${schema}.inventory_operations`)){reached=true;vi.spyOn(Date,"now").mockReturnValue(p.expiresAt+1);}});
        try {await expect(facade(action)(db,verified,original,"execute",undefined,schema)).rejects.toThrow(/SESSION/);expect(reached).toBe(true);}
        finally {vi.restoreAllMocks();}
        expect(await snapshot()).toEqual(before);
    });
    it.each(modes)("real reset-fence blocking then expiration refuses %s without writes", async mode => {
        const original = await intent(action); if(mode !== "admit") await command(original,"admit");
        const before = await snapshot(), p = await claims(), verified = readVerifiedDurableSession(sign(p))!;
        const holder = await pool.connect(); await holder.query("BEGIN");
        const pid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[PURCHASE_RESET_FENCE]);
        const pending = facade(action)(pool,verified,original,mode,mode === "retire" ? "Synthetic withdrawal" : undefined,schema).then(()=>null,e=>e);
        try {await waitForBlockedBy(pid); vi.spyOn(Date,"now").mockReturnValue(p.expiresAt+1); await holder.query("COMMIT"); expect(await pending).toMatchObject({message:"STAFF_OPERATION_SESSION_OR_ACTION_INVALID"});}
        finally {vi.restoreAllMocks();await holder.query("ROLLBACK");holder.release();await pending;}
        expect(await snapshot()).toEqual(before);
    });
    it.each(["admit","execute","retire"] as const)("lost real commit %s reply recovers exact durable evidence", async mode => {
        const original = await intent(action); if(mode !== "admit") await command(original,"admit");
        let reached = false; const db = observedPool(sql=>{if(sql === "COMMIT"){reached=true;throw Error("Synthetic lost reply");}});
        await expect(command(original,mode,2,db)).rejects.toThrow("Synthetic lost reply"); expect(reached).toBe(true);
        const before = await snapshot(); expect((await command(original,mode)).status).toBe(mode === "admit" ? "admitted" : mode === "execute" ? "committed" : "retired");expect(await snapshot()).toEqual(before);
    });
    it.each([["admit","admit"],["execute","execute"],["execute","retire"],["retire","execute"]] as const)("observed real blocking serializes %s versus %s", async (firstMode,secondMode) => {
        const original = await intent(action); if(firstMode !== "admit") await command(original,"admit");
        const entered=deferred(), release=deferred();let pid=0,held=false;
        const table=firstMode === "admit" ? "inventory_command_bindings" : firstMode === "retire" ? "inventory_command_retirements" : action === "unit.revise" ? "inventory_item_unit_versions" : "inventory_locations";
        const db: DbPool={query:pool.query.bind(pool) as DbPool["query"],connect:async()=>{const c=await pool.connect();pid=(await c.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;return {query:async<T>(sql:string,values?:unknown[])=>{const r=await c.query(sql,values);if(!held&&sql.startsWith(`INSERT INTO ${schema}.${table}`)){held=true;entered.resolve();await release.promise;}return r as {rows:T[];rowCount:number|null};},release:()=>c.release()};}};
        const first=command(original,firstMode,2,db);let second:ReturnType<typeof command>|undefined;
        try {await Promise.race([entered.promise,first.then(()=>{throw Error("Missing write barrier");})]);second=command(original,secondMode);await waitForBlockedBy(pid);release.resolve();const a=await first,b=await second;expect(b.status).toBe(a.status);
            const n=(await pool.query(`SELECT (SELECT count(*)::int FROM ${schema}.inventory_command_bindings WHERE operation_key=$1) bindings,(SELECT count(*)::int FROM ${schema}.inventory_operations WHERE operation_key=$1) results,(SELECT count(*)::int FROM ${schema}.inventory_command_retirements WHERE operation_key=$1) retirements`,[a.identity.operationKey])).rows[0];
            expect(n).toEqual({bindings:1,results:firstMode === "execute" ? 1 : 0,retirements:firstMode === "retire" ? 1 : 0});
        } finally {release.resolve();await Promise.allSettled([first,...(second?[second]:[])]);}
    });
});
it("reference preview reports only exact effective grants, never policy or DTO authority", async () => {
    for(const [id,expected] of [[1,["item.create","unit.revise","location.create","policy.revise"]],[2,["unit.revise","location.create"]],[4,[]],[6,["item.create"]],[7,["unit.revise"]],[8,["location.create"]]] as const){
        const dto=await readCanonicalInventoryReferences(pool,await session(id),"",0,schema);expect(dto.allowedActions).toEqual(expected);
        for(const action of actions) await expect(facade(action)(pool,dto as never,await intent(action,id),"admit",undefined,schema)).rejects.toThrow(/SESSION/);
    }
});
it("unit revisions append conversion snapshots without changing historical request/order or stock/clinical facts", async()=>{
    const original=await intent("unit.revise");if(original.input.action!=="unit.revise")throw Error("unit required");
    const itemId=original.input.itemId, request=randomUUID(),order=randomUUID();
    const conversion={itemId,version:1,enteredUnit:"piece",baseUnit:"piece",baseUnitsPerEnteredUnit:"1",enteredPrecision:0,basePrecision:0};
    await pool.query(`INSERT INTO ${schema}.purchase_requests(id,branch_key,current_version,status,requested_by) VALUES($1,'main',1,'draft',2)`,[request]);
    await pool.query(`INSERT INTO ${schema}.purchase_request_revisions(request_id,version,document) VALUES($1,1,$2)`,[request,JSON.stringify({conversion})]);
    await pool.query(`INSERT INTO ${schema}.purchase_request_lines VALUES($1,1,'line',$2,7,7,$3)`,[request,itemId,JSON.stringify(conversion)]);
    await pool.query(`INSERT INTO ${schema}.purchase_orders(id,branch_key,supplier_party_id,document,created_by) VALUES($1,'main',23,$2,2)`,[order,JSON.stringify({conversion,orderedBaseQty:"7"})]);
    await pool.query(`INSERT INTO ${schema}.purchase_order_lines VALUES($1,'line',$2,7)`,[order,itemId]);
    const before=await snapshot();await command(original,"admit");await command(original,"execute");
    unchangedExcept(before,await snapshot(),["inventory_item_unit_versions","inventory_command_bindings","inventory_operations","audit_log"]);
    expect((await pool.query(`SELECT version,entered_unit,base_unit,factor::text,base_precision FROM ${schema}.inventory_item_unit_versions WHERE item_id=$1 ORDER BY version`,[itemId])).rows).toEqual([
        {version:1,entered_unit:"piece",base_unit:"piece",factor:"1.000000000",base_precision:0},
        {version:2,entered_unit:"box",base_unit:"piece",factor:"12.000000000",base_precision:0}
    ]);
});
it.each(["factor","precision","basePrecision","missing","inactive","stale"])("invalid unit %s fails with no mutation",async kind=>{
    const original=await intent("unit.revise");if(original.input.action!=="unit.revise")throw Error("unit required");
    if(kind==="factor")original.input.factor="0";
    if(kind==="precision")original.input.enteredPrecision=4;
    if(kind==="basePrecision")original.input.basePrecision=1;
    if(kind==="missing")original.input.itemId=2147483647;
    if(kind==="inactive")await pool.query(`UPDATE ${schema}.inventory_items SET is_active=FALSE WHERE id=$1`,[original.input.itemId]);
    if(kind==="stale")original.input.expectedVersion=0;
    const before=await snapshot();
    await expect((async()=>{await command(original,"admit");await command(original,"execute");})()).rejects.toThrow();
    unchangedExcept(before,await snapshot(),["inventory_command_bindings","audit_log"]);
});
it("unversioned active item bootstraps 0→1 while existing base unit mismatch cannot be laundered",async()=>{
    const original=await intent("unit.revise");if(original.input.action!=="unit.revise")throw Error("unit required");
    const item=(await pool.query(`INSERT INTO ${schema}.inventory_items(name,unit) VALUES('unversioned','gram') RETURNING id`)).rows[0];
    const fresh={...original,nonce:randomUUID(),input:{...original.input,itemId:item.id,expectedVersion:0}};
    await command(fresh,"admit");const reply=await command(fresh,"execute");expect(reply.status).toBe("committed");if(reply.status==="committed")expect(reply.result.version).toBe(1);
    await pool.query(`UPDATE ${schema}.inventory_items SET unit='changed-unit' WHERE id=$1`,[original.input.itemId]);
    await command(original,"admit");const before=await snapshot();await expect(command(original,"execute")).rejects.toMatchObject({code:"conversion_version_mismatch"});expect(await snapshot()).toEqual(before);
});
it.each(["inactive","stale","expiry"])("real item row blocking revalidates %s after FOR UPDATE wait",async kind=>{
    const original=await intent("unit.revise");if(original.input.action!=="unit.revise")throw Error("unit required");await command(original,"admit");
    const holder=await pool.connect();await holder.query("BEGIN");const pid=(await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await holder.query(`SELECT id FROM ${schema}.inventory_items WHERE id=$1 FOR UPDATE`,[original.input.itemId]);
    const p=await claims(),verified=readVerifiedDurableSession(sign(p))!;
    const pending=facade("unit.revise")(pool,verified,original,"execute",undefined,schema).then(()=>null,e=>e);
    try {await waitForBlockedBy(pid);
        if(kind==="inactive")await holder.query(`UPDATE ${schema}.inventory_items SET is_active=FALSE WHERE id=$1`,[original.input.itemId]);
        if(kind==="stale")await holder.query(`INSERT INTO ${schema}.inventory_item_unit_versions VALUES($1,2,'carton','piece',24,0,0)`,[original.input.itemId]);
        if(kind==="expiry")vi.spyOn(Date,"now").mockReturnValue(p.expiresAt+1);
        await holder.query("COMMIT");const failure=await pending;expect(failure).toBeInstanceOf(Error);
        if(kind!=="expiry")expect(failure).toMatchObject({code:kind==="inactive"?"item_unit_mismatch":"stale_version"});
    } finally {vi.restoreAllMocks();await holder.query("ROLLBACK");holder.release();await pending;}
    expect((await command(original,"lookup")).status).toBe("pending");
});
it("different keys competing for one expected unit version serialize on actual item row; exactly one wins",async()=>{
    const a=await intent("unit.revise"), b={...a,nonce:randomUUID()};await command(a,"admit");await command(b,"admit");
    const entered=deferred(),release=deferred();let pid=0;
    const db:DbPool={query:pool.query.bind(pool) as DbPool["query"],connect:async()=>{const c=await pool.connect();pid=(await c.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;return{query:async<T>(sql:string,values?:unknown[])=>{const r=await c.query(sql,values);if(sql.startsWith(`INSERT INTO ${schema}.inventory_item_unit_versions`)){entered.resolve();await release.promise;}return r as {rows:T[];rowCount:number|null};},release:()=>c.release()};}};
    const first=command(a,"execute",2,db);let second:Promise<unknown>|undefined;
    try {await Promise.race([entered.promise,first.then(()=>{throw Error("Missing unit write barrier");})]);second=command(b,"execute").then(()=>null,e=>e);await waitForBlockedBy(pid);release.resolve();expect((await first).status).toBe("committed");expect(await second).toMatchObject({code:"stale_version"});}
    finally {release.resolve();await Promise.allSettled([first,...(second?[second]:[])]);}
});
it.each(["store","transit","custody"] as const)("creates %s with canonical doctor binding only, never patient or commission authority",async kind=>{
    const original=await intent("location.create");if(original.input.action!=="location.create")throw Error("location required");original.input.kind=kind;original.input.doctorPartyId=kind==="custody"?21:null;
    const before=await snapshot();await command(original,"admit");await command(original,"execute");
    unchangedExcept(before,await snapshot(),["inventory_locations","inventory_command_bindings","inventory_operations","audit_log"]);
    expect((await pool.query(`SELECT kind,doctor_party_id FROM ${schema}.inventory_locations WHERE id=$1`,[original.input.id])).rows).toEqual([{kind,doctor_party_id:kind==="custody"?21:null}]);
});
it.each([null,22,23,2147483647])("custody rejects nonexistent/inactive/non-doctor %s without domain mutations",async doctorPartyId=>{
    const original=await intent("location.create");if(original.input.action!=="location.create")throw Error("location required");original.input.kind="custody";original.input.doctorPartyId=doctorPartyId;
    const before=await snapshot();await expect((async()=>{await command(original,"admit");await command(original,"execute");})()).rejects.toThrow();unchangedExcept(before,await snapshot(),["inventory_command_bindings","audit_log"]);
});
it.each(["store","transit"] as const)("%s rejects a supplied doctor before admission",async kind=>{
    const original=await intent("location.create");if(original.input.action!=="location.create")throw Error("location required");original.input.kind=kind;original.input.doctorPartyId=21;
    const before=await snapshot();await expect(command(original,"admit")).rejects.toThrow();expect(await snapshot()).toEqual(before);
});
it("duplicate location ID cannot overwrite any existing row",async()=>{
    const a=await intent("location.create");await command(a,"admit");await command(a,"execute");const b={...a,nonce:randomUUID(),input:{...a.input,reason:"Different attempt"}};await command(b,"admit");const before=await snapshot();await expect(command(b,"execute")).rejects.toMatchObject({code:"23505"});expect(await snapshot()).toEqual(before);
});
it.each(["inactive","non-doctor"])("custody FOR SHARE wait rechecks doctor changed to %s",async kind=>{
    const original=await intent("location.create");if(original.input.action!=="location.create")throw Error("location required");original.input.kind="custody";original.input.doctorPartyId=21;await command(original,"admit");
    const holder=await pool.connect();await holder.query("BEGIN");const pid=(await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;await holder.query(`SELECT id FROM ${schema}.parties WHERE id=21 FOR UPDATE`);
    const pending=command(original,"execute").then(()=>null,e=>e);
    try {await waitForBlockedBy(pid);await holder.query(kind==="inactive"?`UPDATE ${schema}.parties SET is_active=FALSE WHERE id=21`:`UPDATE ${schema}.parties SET kind='supplier' WHERE id=21`);await holder.query("COMMIT");expect(await pending).toMatchObject({code:"location_forbidden"});}
    finally {await holder.query("ROLLBACK");holder.release();await pending;await pool.query(`UPDATE ${schema}.parties SET is_active=TRUE,kind='doctor' WHERE id=21`);}
    expect((await command(original,"lookup")).status).toBe("pending");
});
it("successful custody transaction holds target doctor FOR SHARE against concurrent deactivation",async()=>{
    const original=await intent("location.create");if(original.input.action!=="location.create")throw Error("location required");original.input.kind="custody";original.input.doctorPartyId=21;await command(original,"admit");
    const entered=deferred(),release=deferred();let pid=0;
    const db:DbPool={query:pool.query.bind(pool) as DbPool["query"],connect:async()=>{const c=await pool.connect();pid=(await c.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;return{query:async<T>(sql:string,values?:unknown[])=>{const r=await c.query(sql,values);if(sql.startsWith(`INSERT INTO ${schema}.inventory_locations`)){entered.resolve();await release.promise;}return r as {rows:T[];rowCount:number|null};},release:()=>c.release()};}};
    const first=command(original,"execute",2,db);let second:Promise<unknown>|undefined;
    try {await Promise.race([entered.promise,first.then(()=>{throw Error("Missing custody insert barrier");})]);second=pool.query(`UPDATE ${schema}.parties SET is_active=FALSE WHERE id=21`);await waitForBlockedBy(pid);release.resolve();expect((await first).status).toBe("committed");await second;}
    finally {release.resolve();await Promise.allSettled([first,...(second?[second]:[])]);await pool.query(`UPDATE ${schema}.parties SET is_active=TRUE WHERE id=21`);}
});
for(const action of actions){
    it(`${action} gate, malformed intent and policy/adjacent action remain closed before connection`,async()=>{
        const connect=vi.fn(()=>{throw Error("Forbidden connection");}),db={connect} as unknown as DbPool,verified=await session(),original=await intent(action);
        vi.stubEnv("INVENTORY_INTEGRATION_ENABLED","false");
        try{await expect(facade(action)(db,verified,original,"admit",undefined,schema)).rejects.toThrow();}finally{vi.stubEnv("INVENTORY_INTEGRATION_ENABLED","true");}
        for(const input of [{action:"policy.revise",expectedVersion:0,limitMinor:100,reason:"Forbidden policy"}, {action:"item.create",name:"No item authority",category:"",baseUnit:"piece",basePrecision:0,minLevel:"0",note:"",reason:"Forbidden item"}] as ReferenceInput[])
            for(const mode of modes)await expect(facade(action)(db,verified,{...original,input},mode,mode==="retire"?"Withdraw":undefined,schema)).rejects.toThrow();
        await expect(facade(action)(db,verified,{...original,nonce:"bad"},"admit",undefined,schema)).rejects.toThrow();
        await expect(facade(action)(db,verified,original,"unknown" as never,undefined,schema)).rejects.toThrow();expect(connect).not.toHaveBeenCalled();
    });
    it(`${action} cannot borrow an adjacent exact action handle in any mode`,async()=>{
        const original=await intent(action),before=await snapshot();
        for(const mode of modes) await expect(withStaffOperation(pool,await session(),capability(action==="unit.revise"?"location.create":"unit.revise"),(c,h)=>lower(action)(c,h,original,mode,mode==="retire"?"Withdraw":undefined,schema),schema)).rejects.toThrow(/HANDLE/);
        expect(await snapshot()).toEqual(before);
    });
    it.each(["admit","retire"] as const)(`${action} %s audit failure rolls back lifecycle evidence`,async mode=>{
        const original=await intent(action);if(mode==="retire")await command(original,"admit");const before=await snapshot();
        await pool.query(`CREATE FUNCTION ${schema}.synthetic_lifecycle_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic lifecycle failure'; END $$; CREATE TRIGGER synthetic_lifecycle_fail AFTER INSERT ON ${schema}.audit_log FOR EACH ROW EXECUTE FUNCTION ${schema}.synthetic_lifecycle_fail()`);
        try{await expect(command(original,mode)).rejects.toThrow("synthetic lifecycle failure");}finally{await pool.query(`DROP TRIGGER synthetic_lifecycle_fail ON ${schema}.audit_log; DROP FUNCTION ${schema}.synthetic_lifecycle_fail()`);}
        expect(await snapshot()).toEqual(before);
    });
}
